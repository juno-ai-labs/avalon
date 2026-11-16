import { afterEach, beforeEach, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";

import { createApp } from "../src/app";
import { AuthService } from "../src/services/auth-service";
import { createCloudflareTestBinding, createTestEnv } from "./helpers/cloudflare-test";
import { migratedSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";

// `GET` and `PUT /workspace/me/shared-canvases` over the real migrations: the
// switch is the caller's own, on until turned off, and a change queues a
// rebuild of every list they have. `docs/canvas-share-federation.md`.

let db: DatabaseSync;
let sent: unknown[];
const apiOrigin = "https://api.example.test";
const at = "2026-11-16T00:00:00.000Z";
const PERSON = "00000000-0000-7000-8000-0000000bb201";
const OTHER = "00000000-0000-7000-8000-0000000bb202";
const ACME = "00000000-0000-7000-8000-0000000bb301";

function bindings() {
  return createTestEnv({ DB: sqliteD1(db), APP_ENV: "development", RALLY_DEV_AUTH: "false", AVALON_REGION: "global",
    ALLOWED_ORIGINS: "https://app.example.test", BROWSER_APP_ORIGIN: "https://app.example.test",
    PUBLIC_API_BASE_URL: apiOrigin, LOG_LEVEL: "error", SESSION_SIGNING_KEY: "shared-canvases-signing-key",
    OAUTH_STATE_ENCRYPTION_KEY: "shared-canvases-encryption-key", MCP_RESOURCE: "https://mcp.example.test/mcp",
    ACTIVITY_QUEUE: createCloudflareTestBinding<Queue>({ send: async (body: unknown) => { sent.push(body); } }) });
}

async function token(userId: string) {
  return (await new AuthService(bindings()).createRegionalSession(userId, ACME)).accessToken;
}

function call(path: string, accessToken: string, init: { method?: string; body?: string } = {}) {
  return createApp().request(`${apiOrigin}${path}`, { method: init.method ?? "GET",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    ...(init.body === undefined ? {} : { body: init.body }) }, bindings());
}

beforeEach(() => {
  db = migratedSqliteDatabase();
  sent = [];
  for (const [id, email] of [[PERSON, "p@example.test"], [OTHER, "o@example.test"]] as const) {
    db.prepare(`INSERT INTO users (id, google_subject, email, name, created_at, updated_at) VALUES (?, ?, ?, 'Person', ?, ?)`)
      .run(id, `g-${id}`, email, at, at);
  }
  db.prepare(`INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at)
    VALUES (?, 'Acme', 'acme', 'global', ?, ?, ?)`).run(ACME, PERSON, at, at);
  for (const userId of [PERSON, OTHER]) {
    db.prepare(`INSERT INTO workspace_members (workspace_id, user_id, role, status, joined_at, access_class)
      VALUES (?, ?, 'member', 'active', ?, 'member')`).run(ACME, userId, at);
  }
});
afterEach(() => db.close());

it("reads the caller's own switch, on until they turn it off, and queues a rebuild of every list", async () => {
  const person = await token(PERSON);
  expect(await (await call("/workspace/me/shared-canvases", person)).json()).toEqual({ enabled: true });

  const saved = await call("/workspace/me/shared-canvases", person, { method: "PUT", body: JSON.stringify({ enabled: false }) });
  expect(saved.status).toBe(200);
  expect(await saved.json()).toEqual({ enabled: false });
  expect(await (await call("/workspace/me/shared-canvases", person)).json()).toEqual({ enabled: false });
  expect(sent).toEqual([{ kind: "shared_canvases_refresh", region: "global", workspaceId: ACME, userId: PERSON, scope: "all" }]);
  // Someone else's switch is untouched.
  expect(await (await call("/workspace/me/shared-canvases", await token(OTHER))).json()).toEqual({ enabled: true });
});

it("refuses a body that is not the switch, and saves nothing", async () => {
  const person = await token(PERSON);
  for (const body of [JSON.stringify({ enabled: "no" }), JSON.stringify({ enabled: false, extra: 1 }), ""]) {
    const refused = await call("/workspace/me/shared-canvases", person, { method: "PUT", body });
    expect([body, refused.status]).toEqual([body, 400]);
  }
  expect(sent).toEqual([]);
  expect(await (await call("/workspace/me/shared-canvases", person)).json()).toEqual({ enabled: true });
});

it("refuses a caller with no session", async () => {
  const refused = await createApp().request(`${apiOrigin}/workspace/me/shared-canvases`, { method: "GET" }, bindings());
  expect(refused.status).toBe(401);
});
