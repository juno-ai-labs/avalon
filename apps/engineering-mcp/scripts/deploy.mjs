import { execFileSync } from "node:child_process";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseWranglerConfig } from "../../../scripts/wrangler-config.mjs";

const appDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
const deploymentToken = process.env.CLOUDFLARE_API_TOKEN?.trim();
// Read tokens for the query tools, by the Worker secret each is installed as.
// Optional so a missing GitHub secret does not fail the API release this deploy
// runs inside; the tool names the missing secret instead.
const runtimeSecrets = [
  { name: "BASIN_SQL_API_TOKEN", tool: "query_data_lake" },
  { name: "WORKERS_OBSERVABILITY_API_TOKEN", tool: "query_worker_observability" },
].map((secret) => ({ ...secret, value: process.env[`ENGINEERING_MCP_${secret.name}`]?.trim() }));
const mcpDomain = "mcp.internal.rallywith.ai";
const aceDomain = "ace.internal.rallywith.ai";
const generatedConfig = join(appDirectory, "wrangler.generated.json");
const hostedClients = JSON.parse(
  await readFile(join(appDirectory, "hosted-clients.json"), "utf8"),
);
const hostedMcpRedirectUris = hostedClients.oauthRedirectUriPatterns;

if (!Array.isArray(hostedMcpRedirectUris)
  || hostedMcpRedirectUris.some((uri) => typeof uri !== "string" || !uri.startsWith("https://"))) {
  throw new Error("hosted-clients.json must define HTTPS OAuth redirect URI patterns");
}

if (!accountId) throw new Error("CLOUDFLARE_ACCOUNT_ID is required");
if (!deploymentToken) throw new Error("CLOUDFLARE_API_TOKEN is required");

async function cloudflareResponse(path, init = {}) {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${deploymentToken}`,
      Accept: "application/json",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.success !== true) {
    const detail = (body?.errors ?? []).map((error) => error.message).join("; ");
    throw new Error(
      `Cloudflare ${init.method ?? "GET"} ${path} failed (${response.status})${detail ? `: ${detail}` : ""}`,
    );
  }
  return body;
}

async function cloudflare(path, init = {}) {
  return (await cloudflareResponse(path, init)).result;
}

async function cloudflareList(path) {
  const items = [];
  for (let page = 1; ; page += 1) {
    const url = new URL(path, "https://api.cloudflare.invalid");
    url.searchParams.set("page", String(page));
    url.searchParams.set("per_page", "100");
    const body = await cloudflareResponse(`${url.pathname}${url.search}`);
    if (!Array.isArray(body.result)) {
      throw new Error(`Cloudflare GET ${path} returned a non-list result`);
    }
    items.push(...body.result);
    const totalPages = Number(body.result_info?.total_pages);
    if (Number.isInteger(totalPages) && totalPages > 0) {
      if (page >= totalPages) return items;
    } else if (body.result.length < 100) {
      return items;
    }
  }
}

function policyShape(policy) {
  return Object.fromEntries([
    "name", "decision", "include", "exclude", "require", "precedence",
    "purpose_justification_required", "purpose_justification_prompt",
    "approval_required", "approval_groups", "session_duration",
  ].flatMap((key) => policy[key] === undefined ? [] : [[key, policy[key]]]));
}

async function ensureAccessApplication() {
  const applications = await cloudflareList("/access/apps");
  const ace = applications.find((application) => application.domain === aceDomain);
  if (!ace) throw new Error(`The ${aceDomain} Access application is required as the MCP policy source`);
  const acePolicies = await cloudflareList(
    `/access/apps/${encodeURIComponent(ace.id)}/policies`,
  );
  if (!Array.isArray(acePolicies) || acePolicies.length === 0) {
    throw new Error("The Ace Access application has no policy to reuse");
  }
  if (typeof ace.session_duration !== "string" || ace.session_duration.length === 0) {
    throw new Error("The Ace Access application has no session duration to reuse");
  }
  const existing = applications.find((application) => application.domain === mcpDomain);
  const current = existing
    ? await cloudflare(`/access/apps/${encodeURIComponent(existing.id)}`)
    : null;
  const currentAllowedRedirectUris = Array.isArray(
    current?.oauth_configuration?.dynamic_client_registration?.allowed_uris,
  )
    ? current.oauth_configuration.dynamic_client_registration.allowed_uris
    : [];
  const application = {
    name: "Rally engineering MCP",
    type: "self_hosted",
    domain: mcpDomain,
    session_duration: ace.session_duration,
    app_launcher_visible: false,
    auto_redirect_to_identity: ace.auto_redirect_to_identity ?? false,
    ...(Array.isArray(ace.allowed_idps) ? { allowed_idps: ace.allowed_idps } : {}),
    oauth_configuration: {
      enabled: true,
      dynamic_client_registration: {
        ...(current?.oauth_configuration?.dynamic_client_registration ?? {}),
        enabled: true,
        allow_any_on_localhost: true,
        allow_any_on_loopback: true,
        allowed_uris: [...new Set([
          ...currentAllowedRedirectUris,
          ...hostedMcpRedirectUris,
        ])],
      },
      ...(current?.oauth_configuration?.grant
        ? { grant: current.oauth_configuration.grant }
        : {}),
    },
    policies: acePolicies.map(policyShape),
  };
  const result = existing
    ? await cloudflare(`/access/apps/${encodeURIComponent(existing.id)}`, {
        method: "PUT",
        body: JSON.stringify(application),
      })
    : await cloudflare("/access/apps", {
        method: "POST",
        body: JSON.stringify(application),
      });
  if (typeof result.aud !== "string" || result.aud.length === 0) {
    throw new Error("Cloudflare Access returned no audience tag for the engineering MCP");
  }
  return result.aud;
}

const audience = await ensureAccessApplication();
const source = await readFile(join(appDirectory, "wrangler.jsonc"), "utf8");
const config = parseWranglerConfig(source);
config.vars.ACCESS_APPLICATION_AUD = audience;
config.vars.CLOUDFLARE_ACCOUNT_ID = accountId;
await writeFile(generatedConfig, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
try {
  execFileSync("pnpm", ["exec", "wrangler", "deploy", "--config", generatedConfig], {
    cwd: appDirectory,
    stdio: "inherit",
  });
  for (const { name, tool, value } of runtimeSecrets) {
    if (value) {
      execFileSync("pnpm", ["exec", "wrangler", "secret", "put", name, "--config", generatedConfig], {
        cwd: appDirectory,
        input: `${value}\n`,
        stdio: ["pipe", "inherit", "inherit"],
      });
    } else {
      console.warn(`ENGINEERING_MCP_${name} is not set; ${tool} keeps any existing secret`);
    }
  }
} finally {
  await unlink(generatedConfig).catch(() => undefined);
}
