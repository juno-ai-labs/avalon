import { beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { AuthService } from "../src/services/auth-service";
import { createTestD1Database, createTestD1PreparedStatement, createTestD1Result, createTestEnv } from "./helpers/cloudflare-test";

const userId = "00000000-0000-7000-8000-000000000001";
const workspaceId = "00000000-0000-7000-8000-0000000000a1";

class SessionDatabase {
  revokedSessionIds: string[] = [];
  refreshRevocations = 0;

  readonly binding = createTestD1Database({
    prepare: (rawSql: string) => {
      const sql = rawSql.replace(/\s+/gu, " ").trim();
      let values: unknown[] = [];
      const statement = {
        bind: (...nextValues: unknown[]) => {
          values = nextValues;
          return statement;
        },
        first: async <T>() => {
          if (sql.startsWith("UPDATE sessions SET revoked_at = ? WHERE id = ?")) {
            this.revokedSessionIds.push(String(values[1]));
            return { id: String(values[1]), user_id: userId, workspace_id: workspaceId } as T;
          }
          throw new Error(`Unexpected first query: ${sql}`);
        },
        all: async <T>() => {
          if (!sql.startsWith("UPDATE sessions SET revoked_at = ? WHERE revoked_at IS NULL AND (refresh_token_hash")) {
            throw new Error(`Unexpected all query: ${sql}`);
          }
          this.refreshRevocations += 1;
          // The statement revoked nothing here: the presented refresh token is
          // stale, which is the case this test exists for.
          return createTestD1Result<T>({ success: true, results: [], meta: { changes: 0 } });
        },
        // Both logout statements read their rows back now, so nothing here
        // calls `run`; leaving it throwing keeps that visible.
        run: async () => {
          throw new Error(`Unexpected run query: ${sql}`);
        },
      };
      return createTestD1PreparedStatement(statement);
    },
  });
}

function environment(database: SessionDatabase, published: unknown[] = []): Env {
  return createTestEnv({
    DB: database.binding,
    ACCESS_REVOCATION_QUEUE: { send: async (body: unknown) => { published.push(body); } },
    AVALON_REGION: "global",
    PUBLIC_API_BASE_URL: "https://api.with-avalon.com",
    SESSION_SIGNING_KEY: "global-session-signing-key-with-enough-entropy",
  });
}

describe("authentication session lifecycle", () => {
  let database: SessionDatabase;

  beforeEach(() => {
    database = new SessionDatabase();
  });

  it("revokes the verified bearer session even when the supplied refresh token is stale", async () => {
    const published: unknown[] = [];
    await new AuthService(environment(database, published))
      .logout({ sessionId: "session-1", refreshToken: "stale-refresh-token-longer-than-twenty" });

    expect(database.revokedSessionIds).toEqual(["session-1"]);
    expect(database.refreshRevocations).toBe(1);
    // Revoking the row is half of a logout: the sockets it is holding are
    // closed only if the revocation is announced. See docs/access-revocation.md.
    expect(published).toEqual([expect.objectContaining({
      kind: "access_revoked",
      reason: "session_revoked",
      sessionId: "session-1",
      userId,
      workspaceId,
    })]);
  });
});

describe("what an access token can claim", () => {
  it("drops a forged connector-principal claim on verification", async () => {
    // The connector-principal design hangs on one property: the auth
    // middleware builds its context exclusively from the claims
    // `verifyAccessToken` returns, and that function constructs a fresh
    // literal rather than spreading the JWT payload — so a token body that
    // smuggles `principal: "connector"` cannot make a product request skip
    // the `sessions` verification. This is the assertion behind that
    // property.
    const { SignJWT } = await import("jose");
    const { verifyAccessToken } = await import("../src/services/auth-service");
    const env = createTestEnv({
      SESSION_SIGNING_KEY: "global-session-signing-key-with-enough-entropy",
      AVALON_REGION: "global",
    });
    const now = Math.floor(Date.now() / 1_000);
    const forged = await new SignJWT({
      sid: "session-forged",
      wid: "00000000-0000-7000-8000-000000000801",
      region: "global",
      principal: "connector",
    })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setSubject("00000000-0000-7000-8000-000000000802")
      .setIssuer("avalon-api")
      .setAudience("avalon-desktop")
      .setIssuedAt(now)
      .setExpirationTime(now + 60)
      .sign(new TextEncoder().encode("global-session-signing-key-with-enough-entropy"));

    const verified = await verifyAccessToken(env, forged);

    // `toEqual`, so the *absence* of `principal` is what passes.
    expect(verified).toEqual({
      sessionId: "session-forged",
      userId: "00000000-0000-7000-8000-000000000802",
      workspaceId: "00000000-0000-7000-8000-000000000801",
      region: "global",
    });
  });
});
