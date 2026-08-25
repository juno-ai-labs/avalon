#!/usr/bin/env node

import { createHash, randomBytes, webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createCloudflareClient } from "./configure-cloudflare-observability.mjs";
import { isEntryPoint } from "./entry-point.mjs";

const DEFAULT_NOTION_INGRESS_BASE_URL = "https://notion.rallywith.ai";
const NONCE_TTL_MS = 30 * 60 * 1_000;
const NOTION_CHALLENGE_AAD = "provider-webhook:notion:global";
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const globalWranglerConfigPath = resolve(repositoryRoot, "apps/api/wrangler.global.jsonc");

export function sha256Base64Url(value) {
  return createHash("sha256").update(value).digest("base64url");
}

export function databaseIdFromWranglerConfig(source) {
  const match = source.match(/"database_id"\s*:\s*"([0-9a-f-]{36})"/iu);
  if (!match) throw new Error("The Global D1 database ID is missing from wrangler.global.jsonc");
  return match[1];
}

export function credentialVersionFromWranglerConfig(source) {
  const match = source.match(/"CONNECTOR_CREDENTIALS_KEY_VERSION"\s*:\s*"(\d+)"/u);
  if (!match) throw new Error("The connector credential key version is missing from wrangler.global.jsonc");
  return match[1];
}

export function d1Rows(result) {
  const queries = Array.isArray(result) ? result : [result];
  if (queries.length !== 1 || queries[0]?.success !== true || !Array.isArray(queries[0].results)) {
    throw new Error("Cloudflare returned an invalid D1 query result");
  }
  return queries[0].results;
}

export function d1BatchRows(result, expectedCount) {
  const queries = Array.isArray(result) ? result : [result];
  if (
    queries.length !== expectedCount
    || queries.some((query) => query?.success !== true || !Array.isArray(query.results))
  ) {
    throw new Error("Cloudflare returned an invalid D1 batch result");
  }
  return queries.map((query) => query.results);
}

export async function queryD1(cloudflare, databaseId, sql, params = []) {
  const result = await cloudflare(`/d1/database/${databaseId}/query`, {
    method: "POST",
    body: JSON.stringify({ sql, params }),
  });
  return d1Rows(result);
}

export async function queryD1Batch(cloudflare, databaseId, batch) {
  const result = await cloudflare(`/d1/database/${databaseId}/query`, {
    method: "POST",
    body: JSON.stringify({ batch }),
  });
  return d1BatchRows(result, batch.length);
}

function decodeBase64Url(value) {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function importCredentialKey(secret) {
  if (!secret) throw new Error("The Global connector credential key is not configured locally");
  let keyBytes;
  try {
    keyBytes = decodeBase64Url(secret);
  } catch {
    keyBytes = new TextEncoder().encode(secret);
  }
  if (keyBytes.byteLength !== 32) {
    keyBytes = new Uint8Array(await webcrypto.subtle.digest("SHA-256", new TextEncoder().encode(secret)));
  }
  return webcrypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["decrypt"]);
}

function previousCredentialKeys(raw) {
  if (!raw) return {};
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter(
      ([version, key]) => /^\d+$/u.test(version) && typeof key === "string" && key.length > 0,
    ));
  } catch {
    return {};
  }
}

export function credentialKeyForVersion(row, environment) {
  const activeVersion = Number(
    environment.CONNECTOR_CREDENTIALS_KEY_VERSION_GLOBAL
      ?? environment.CONNECTOR_CREDENTIALS_KEY_VERSION
      ?? "1",
  );
  const storedVersion = Number(row.credential_key_version || activeVersion);
  if (storedVersion === activeVersion) {
    return environment.CONNECTOR_CREDENTIALS_KEY_GLOBAL
      ?? environment.CONNECTOR_CREDENTIALS_KEY;
  }
  const historical = previousCredentialKeys(
    environment.CONNECTOR_CREDENTIALS_KEYS_JSON_GLOBAL
      ?? environment.CONNECTOR_CREDENTIALS_KEYS_JSON,
  );
  return historical[String(storedVersion)];
}

export function globalCredentialEnvironment(environment, wranglerConfig) {
  const version = credentialVersionFromWranglerConfig(wranglerConfig);
  return {
    ...environment,
    // This command reads the production Global database selected by the same
    // checked-in config. An unsuffixed local development version must not
    // reinterpret that production row after a key rotation.
    CONNECTOR_CREDENTIALS_KEY_VERSION_GLOBAL: version,
    CONNECTOR_CREDENTIALS_KEY_VERSION: version,
  };
}

export async function decryptStoredNotionToken(row, environment) {
  const secret = credentialKeyForVersion(row, environment);
  if (!secret) {
    throw new Error(`Connector credential key version ${row.credential_key_version} is unavailable locally`);
  }
  const key = await importCredentialKey(secret);
  const plaintext = await webcrypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: decodeBase64Url(row.token_iv),
      additionalData: new TextEncoder().encode(NOTION_CHALLENGE_AAD),
    },
    key,
    decodeBase64Url(row.encrypted_token),
  );
  return new TextDecoder().decode(plaintext);
}

export async function copyToClipboard(value, {
  platform = process.platform,
  spawnImplementation = spawn,
} = {}) {
  const command = platform === "darwin"
    ? { file: "pbcopy", args: [] }
    : platform === "linux"
      ? { file: "wl-copy", args: [] }
      : null;
  if (!command) throw new Error("No supported clipboard command is available on this platform");

  await new Promise((resolveCopy, rejectCopy) => {
    const child = spawnImplementation(command.file, command.args, { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", () => rejectCopy(new Error(`Could not start ${command.file}`)));
    child.once("exit", (code, signal) => {
      if (signal || code !== 0) {
        rejectCopy(new Error(`${command.file} failed${stderr ? `: ${stderr.trim()}` : ""}`));
      } else {
        resolveCopy();
      }
    });
    child.stdin.end(value);
  });
}

export async function prepareNotionWebhook({
  cloudflare,
  databaseId,
  environment = process.env,
  now = () => Date.now(),
  randomBytesImplementation = randomBytes,
  copy = copyToClipboard,
}) {
  const nonce = randomBytesImplementation(32).toString("base64url");
  const nonceHash = sha256Base64Url(nonce);
  const createdAtMs = now();
  const createdAt = new Date(createdAtMs).toISOString();
  const expiresAt = new Date(createdAtMs + NONCE_TTL_MS).toISOString();

  // One D1 batch is one SQL transaction. The partial unique index on
  // is_current is the backstop that makes two concurrent batches serialize to
  // one current setup generation rather than leave two usable URLs.
  await queryD1Batch(
    cloudflare,
    databaseId,
    [
      {
        sql: "UPDATE notion_webhook_setup_nonces SET is_current = 0 WHERE is_current = 1",
        params: [],
      },
      {
        sql: `INSERT INTO notion_webhook_setup_nonces
          (nonce_hash, verification_token_hash, created_at, expires_at, consumed_at, is_current)
          VALUES (?, NULL, ?, ?, NULL, 1)`,
        params: [nonceHash, createdAt, expiresAt],
      },
    ],
  );

  const url = new URL("/ingest/notion", environment.NOTION_INGRESS_BASE_URL || DEFAULT_NOTION_INGRESS_BASE_URL);
  url.searchParams.set("setup", nonce);
  await copy(url.toString());
  return { expiresAt };
}

export async function copyNotionVerificationToken({
  cloudflare,
  databaseId,
  environment = process.env,
  copy = copyToClipboard,
}) {
  const rows = await queryD1(
    cloudflare,
    databaseId,
    `SELECT challenge.encrypted_token, challenge.token_iv,
            challenge.credential_key_version, challenge.created_at,
            nonce.verification_token_hash
     FROM provider_webhook_challenges AS challenge
     INNER JOIN notion_webhook_setup_nonces AS nonce
       ON nonce.nonce_hash = challenge.setup_nonce_hash
     WHERE challenge.provider = 'notion' AND challenge.region = 'global'
       AND nonce.is_current = 1 AND nonce.consumed_at IS NOT NULL`,
  );
  const row = rows[0];
  if (!row) throw new Error("No current Notion verification token has reached the Global ingress yet");
  const token = await decryptStoredNotionToken(row, environment);
  if (sha256Base64Url(token) !== row.verification_token_hash) {
    throw new Error("The current Notion verification token has not finished being stored yet");
  }
  await copy(token);
  return { createdAt: row.created_at };
}

export async function notionWebhookSetupCli({
  argv = process.argv.slice(2),
  environment = process.env,
  fetchImplementation = fetch,
  copy = copyToClipboard,
} = {}) {
  const mode = argv[0];
  if (mode !== "prepare" && mode !== "copy-token") {
    throw new Error("Usage: notion-webhook-setup.mjs <prepare|copy-token>");
  }
  const accountId = environment.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = environment.CLOUDFLARE_API_TOKEN;
  if (!accountId || !apiToken) {
    throw new Error("CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required");
  }
  const config = await readFile(globalWranglerConfigPath, "utf8");
  const databaseId = databaseIdFromWranglerConfig(config);
  const cloudflare = createCloudflareClient({ accountId, apiToken, fetchImplementation });
  const configuredEnvironment = globalCredentialEnvironment(environment, config);

  if (mode === "prepare") {
    const { expiresAt } = await prepareNotionWebhook({
      cloudflare,
      databaseId,
      environment: configuredEnvironment,
      copy,
    });
    console.info(`Copied a one-time Notion webhook URL to the clipboard; it expires at ${expiresAt}.`);
    return;
  }
  const { createdAt } = await copyNotionVerificationToken({
    cloudflare,
    databaseId,
    environment: configuredEnvironment,
    copy,
  });
  console.info(`Copied the Notion verification token captured at ${createdAt} to the clipboard.`);
}

if (isEntryPoint(import.meta.url)) {
  notionWebhookSetupCli().catch((error) => {
    console.error(error instanceof Error ? error.message : "Notion webhook setup failed");
    process.exitCode = 1;
  });
}
