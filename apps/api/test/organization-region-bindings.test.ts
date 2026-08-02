import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { AuthService } from "../src/services/auth-service";
import { previewInvitation } from "../src/services/workspace-service";

interface RecordedStatement {
  sql: string;
  values: unknown[];
}

class RecordingDatabase {
  readonly runs: RecordedStatement[] = [];

  constructor(private readonly invitation: Record<string, unknown>) {}

  readonly binding = {
    prepare: (sql: string) => {
      const statement: RecordedStatement = {
        sql: sql.replace(/\s+/gu, " ").trim(),
        values: [],
      };
      const prepared = {
        bind: (...values: unknown[]) => {
          statement.values = values;
          return prepared;
        },
        first: async <T>() => {
          if (statement.sql.includes("WHERE i.token_hash = ?")) {
            return this.invitation as T;
          }
          throw new Error(`Unexpected first() query: ${statement.sql}`);
        },
        run: async <T>() => {
          this.runs.push(statement);
          return {
            success: true,
            results: [],
            meta: { changes: 1 },
          } as unknown as D1Result<T>;
        },
      };
      return prepared as unknown as D1PreparedStatement;
    },
  } as unknown as D1Database;
}

const invitation = {
  id: "018f3f4e-7b5a-7cc1-9a6f-2aa0324b79d0",
  workspace_id: "018f3f4e-7b5a-7cc1-9a6f-2aa0324b79d1",
  workspace_name: "Europe Research",
  workspace_region: "eu" as const,
  email: "invitee@example.com",
  role: "admin" as const,
  invited_by_name: "Ada",
  expires_at: "2026-08-08T00:00:00.000Z",
  accepted_at: null,
  accepted_by_user_id: null,
  revoked_at: null,
  created_at: "2026-08-01T00:00:00.000Z",
};

function environment(database: RecordingDatabase, region: "global" | "eu"): Env {
  return {
    DB: database.binding,
    AVALON_REGION: region,
    PUBLIC_API_BASE_URL: region === "eu"
      ? "https://eu.api.with-avalon.com"
      : "https://api.with-avalon.com",
    PUBLIC_WEB_BASE_URL: "https://with-avalon.com",
    DESKTOP_DEEP_LINK_URI: "avalon://auth/complete",
    GOOGLE_OAUTH_CLIENT_ID: "google-client-id",
    GOOGLE_OAUTH_CLIENT_SECRET: "google-client-secret",
    OAUTH_STATE_ENCRYPTION_KEY: "test-oauth-state-encryption-key",
  } as unknown as Env;
}

afterEach(() => vi.useRealTimers());

describe("organization region bindings", () => {
  it("returns the invitation's EU region from the EU preview service", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-01T01:00:00.000Z"));
    const database = new RecordingDatabase(invitation);

    await expect(previewInvitation(environment(database, "eu"), "p".repeat(32)))
      .resolves.toEqual({
        workspaceId: invitation.workspace_id,
        workspaceName: invitation.workspace_name,
        region: "eu",
        email: invitation.email,
        role: "admin",
        expiresAt: invitation.expires_at,
      });
  });

  it("refuses to preview an EU invitation through the global service", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-01T01:00:00.000Z"));
    const database = new RecordingDatabase(invitation);

    await expect(previewInvitation(environment(database, "global"), "p".repeat(32)))
      .rejects.toMatchObject({ status: 409, code: "region_mismatch" });
  });

  it("refuses a second regional identity login", async () => {
    const database = new RecordingDatabase(invitation);
    await expect(new AuthService(environment(database, "eu")).beginIdentity({
      returnUri: "avalon://auth/complete",
      desktopAttemptId: "a".repeat(43),
      desktopCodeChallenge: "c".repeat(43),
    })).rejects.toMatchObject({ status: 409, code: "global_identity_required" });
    expect(database.runs).toHaveLength(0);
  });
});
