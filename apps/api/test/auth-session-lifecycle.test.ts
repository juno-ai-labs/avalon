import { beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { sha256 } from "../src/lib/crypto";
import { AuthService } from "../src/services/auth-service";
import { createTestD1Database, createTestD1PreparedStatement, createTestD1Result, createTestEnv } from "./helpers/cloudflare-test";

const oldRefreshToken = "old-refresh-token-with-more-than-twenty-characters";
const userId = "00000000-0000-7000-8000-000000000001";
const createdAt = "2026-08-01T12:00:00.000Z";
const workspaceId = "00000000-0000-7000-8000-0000000000a1";

class SessionDatabase {
  currentHash = "";
  previousHash: string | null = null;
  rotatedAt: string | null = null;
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
          if (sql.startsWith("UPDATE sessions SET previous_refresh_token_hash")) {
            const [newHash, nextRotatedAt, presentedCurrent, presentedPrevious, graceStart] = values as string[];
            const currentMatches = presentedCurrent === this.currentHash;
            const previousMatches = presentedPrevious === this.previousHash
              && this.rotatedAt !== null
              && this.rotatedAt >= graceStart!;
            if (!currentMatches && !previousMatches) return null;
            this.previousHash = this.currentHash;
            this.currentHash = newHash!;
            this.rotatedAt = nextRotatedAt!;
            return { id: "session-1", user_id: userId, workspace_id: null } as T;
          }
          if (sql.startsWith("UPDATE sessions SET revoked_at = ? WHERE id = ?")) {
            this.revokedSessionIds.push(String(values[1]));
            return { id: String(values[1]), user_id: userId, workspace_id: workspaceId } as T;
          }
          if (sql.includes("FROM users WHERE id = ?") && sql.includes("id AS user_id")) {
            return {
              user_id: userId,
              email: "member@example.com",
              user_name: "Member",
              avatar_url: null,
              user_created_at: createdAt,
            } as T;
          }
          throw new Error(`Unexpected first query: ${sql}`);
        },
        all: async <T>() => {
          if (!sql.startsWith("UPDATE sessions SET revoked_at = ? WHERE refresh_token_hash")) {
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
  let service: AuthService;

  beforeEach(async () => {
    database = new SessionDatabase();
    database.currentHash = await sha256(oldRefreshToken);
    service = new AuthService(environment(database));
  });

  it("accepts the immediately previous refresh token when a rotation response is lost", async () => {
    const first = await service.refresh(oldRefreshToken);
    const recovered = await service.refresh(oldRefreshToken);

    expect(recovered.refreshToken).not.toBe(first.refreshToken);
    expect(recovered.workspace).toBeNull();
    await expect(service.refresh(recovered.refreshToken)).resolves.toMatchObject({
      user: { email: "member@example.com" },
      workspace: null,
    });
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
