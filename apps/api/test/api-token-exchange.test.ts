import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createApp } from "../src/app";
import { verifyAccessToken } from "../src/services/auth-service";
import { createTestEnv } from "./helpers/cloudflare-test";
import { migratedSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";

// The same pair scripts/api-token.test.mjs pins for `newApiToken`, so a hash the
// operator script stores is the hash this route accepts.
const TOKEN = "rally_at_BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc";
const TOKEN_HASH = "UIp8zbX_BEnmVIs6pPnPlPQXdwA3IH5ABDWmRYClx6U";

let db: DatabaseSync;
function bindings() {
  return createTestEnv({ DB:sqliteD1(db),APP_ENV:"production",RALLY_DEV_AUTH:"false",AVALON_REGION:"global",
    ALLOWED_ORIGINS:"https://app.example.test",PUBLIC_API_BASE_URL:"https://api.example.test",LOG_LEVEL:"error",
    SESSION_SIGNING_KEY:"api-token-test-signing-key",OAUTH_STATE_ENCRYPTION_KEY:"api-token-test-encryption-key" });
}
function mint(columns: { expires_at?: string; revoked_at?: string } = {}) {
  db.prepare(`INSERT INTO api_tokens (id, user_id, token_hash, label, created_at, expires_at, revoked_at)
    VALUES ('token-1', '018f0000-0000-7000-8000-000000000001', ?, 'nightly e2e', '2026-10-01T00:00:00.000Z', ?, ?)`)
    .run(TOKEN_HASH, columns.expires_at ?? null, columns.revoked_at ?? null);
}
async function exchange(token: string) {
  return createApp().request("/auth/token/exchange", { method:"POST", headers:{ "content-type":"application/json" },
    body:JSON.stringify({ token }) }, bindings());
}

beforeEach(() => {
  db = migratedSqliteDatabase();
  db.prepare(`INSERT INTO users (id, google_subject, email, name, created_at, updated_at)
    VALUES ('018f0000-0000-7000-8000-000000000001', NULL, 'bot@example.test', 'Bot', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`).run();
});
afterEach(() => { db.close(); });

describe("POST /auth/token/exchange", () => {
  it("trades a live token for an identity-only session of its user and stamps its use", async () => {
    mint();
    const response = await exchange(TOKEN);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const session = await response.json() as { accessToken:string;workspace:unknown;user:{ id:string;email:string };apiBaseUrl:string };
    expect(session.workspace).toBeNull();
    expect(session.user).toMatchObject({ id:"018f0000-0000-7000-8000-000000000001",email:"bot@example.test" });
    expect(session.apiBaseUrl).toBe("https://api.example.test");
    const claims = await verifyAccessToken(bindings(), session.accessToken);
    expect(db.prepare("SELECT user_id, workspace_id, revoked_at FROM sessions WHERE id=?").get(claims.sessionId))
      .toEqual({ user_id:"018f0000-0000-7000-8000-000000000001",workspace_id:null,revoked_at:null });
    expect(db.prepare("SELECT last_used_at FROM api_tokens").get()).not.toEqual({ last_used_at:null });
  });

  it("refuses a revoked token without minting a session", async () => {
    mint({ revoked_at:"2026-10-02T00:00:00.000Z" });
    const response = await exchange(TOKEN);
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error:{ code:"invalid_api_token" } });
    expect(db.prepare("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n:0 });
    expect(db.prepare("SELECT last_used_at FROM api_tokens").get()).toEqual({ last_used_at:null });
  });

  it("refuses an expired token, and honours one that has not expired", async () => {
    mint({ expires_at:"2026-10-02T00:00:00.000Z" });
    expect((await exchange(TOKEN)).status).toBe(401);
    db.prepare("UPDATE api_tokens SET expires_at='2999-01-01T00:00:00.000Z'").run();
    expect((await exchange(TOKEN)).status).toBe(200);
  });

  it("refuses a well-formed token nobody minted", async () => {
    mint();
    const response = await exchange("rally_at_CAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg");
    expect(response.status).toBe(401);
    expect(db.prepare("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n:0 });
  });
});
