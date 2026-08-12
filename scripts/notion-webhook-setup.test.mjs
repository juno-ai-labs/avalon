import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import test from "node:test";

import {
  copyNotionVerificationToken,
  credentialKeyForVersion,
  credentialVersionFromWranglerConfig,
  d1Rows,
  databaseIdFromWranglerConfig,
  prepareNotionWebhook,
  sha256Base64Url,
} from "./notion-webhook-setup.mjs";

const NOW = Date.parse("2026-08-12T20:00:00.000Z");
const DATABASE_ID = "3802fdab-e21c-4313-beb2-c1defb37f253";

test("prepares a hashed 30-minute nonce and copies only the webhook URL", async () => {
  const requests = [];
  const clipboard = [];
  const random = Buffer.alloc(32, 7);
  const cloudflare = async (path, init) => {
    requests.push({ path, body: JSON.parse(init.body) });
    return [{ success: true, results: [] }];
  };

  const result = await prepareNotionWebhook({
    cloudflare,
    databaseId: DATABASE_ID,
    environment: { NOTION_INGRESS_BASE_URL: "https://notion.example" },
    now: () => NOW,
    randomBytesImplementation: () => random,
    copy: async (value) => clipboard.push(value),
  });

  assert.equal(result.expiresAt, "2026-08-12T20:30:00.000Z");
  assert.equal(requests.length, 2);
  assert.match(requests[0].body.sql, /DELETE FROM notion_webhook_setup_nonces/u);
  assert.match(requests[1].body.sql, /INSERT INTO notion_webhook_setup_nonces/u);
  const nonce = random.toString("base64url");
  assert.equal(requests[1].body.params[0], sha256Base64Url(nonce));
  assert.doesNotMatch(JSON.stringify(requests), new RegExp(nonce));
  assert.equal(clipboard[0], `https://notion.example/ingest/notion?setup=${nonce}`);
});

test("decrypts the stored Global token and sends plaintext only to the clipboard", async () => {
  const keyBytes = Buffer.alloc(32, 11);
  const environment = {
    CONNECTOR_CREDENTIALS_KEY_GLOBAL: keyBytes.toString("base64url"),
    CONNECTOR_CREDENTIALS_KEY_VERSION: "2",
  };
  const encrypted = await encryptToken("notion-verification-secret", keyBytes);
  const clipboard = [];
  const cloudflare = async () => [{
    success: true,
    results: [{
      ...encrypted,
      credential_key_version: 2,
      created_at: "2026-08-12T20:01:00.000Z",
    }],
  }];

  const result = await copyNotionVerificationToken({
    cloudflare,
    databaseId: DATABASE_ID,
    environment,
    copy: async (value) => clipboard.push(value),
  });

  assert.deepEqual(result, { createdAt: "2026-08-12T20:01:00.000Z" });
  assert.deepEqual(clipboard, ["notion-verification-secret"]);
});

test("selects the historical Global credential key for an older row", () => {
  assert.equal(credentialKeyForVersion(
    { credential_key_version: 1 },
    {
      CONNECTOR_CREDENTIALS_KEY_GLOBAL: "active",
      CONNECTOR_CREDENTIALS_KEY_VERSION: "2",
      CONNECTOR_CREDENTIALS_KEYS_JSON_GLOBAL: JSON.stringify({ 1: "old" }),
    },
  ), "old");
});

test("rejects malformed Cloudflare query results and missing challenge rows", async () => {
  assert.throws(() => d1Rows([{ success: false, results: [] }]), /invalid D1 query result/u);
  await assert.rejects(copyNotionVerificationToken({
    cloudflare: async () => [{ success: true, results: [] }],
    databaseId: DATABASE_ID,
    environment: {},
    copy: async () => {},
  }), /No Notion verification token/u);
});

test("reads the Global D1 identifier from the checked-in Wrangler shape", () => {
  assert.equal(databaseIdFromWranglerConfig(`{
    "d1_databases": [{ "binding": "DB", "database_id": "${DATABASE_ID}" }]
  }`), DATABASE_ID);
  assert.throws(() => databaseIdFromWranglerConfig("{}"), /database ID is missing/u);
  assert.equal(credentialVersionFromWranglerConfig(`{
    "vars": { "CONNECTOR_CREDENTIALS_KEY_VERSION": "7" }
  }`), "7");
  assert.throws(() => credentialVersionFromWranglerConfig("{}"), /key version is missing/u);
});

async function encryptToken(token, keyBytes) {
  const key = await webcrypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt"]);
  const iv = Buffer.alloc(12, 13);
  const ciphertext = await webcrypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: new TextEncoder().encode("provider-webhook:notion:global"),
    },
    key,
    new TextEncoder().encode(token),
  );
  return {
    encrypted_token: Buffer.from(ciphertext).toString("base64url"),
    token_iv: iv.toString("base64url"),
  };
}
