import "../../../tests/isolated-region";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { AuthService } from "../src/services/auth-service";
import { previewInvitation } from "../src/services/workspace-service";
import { createTestD1Database, createTestD1PreparedStatement, createTestD1Result, createTestEnv } from "./helpers/cloudflare-test";

interface RecordedStatement {
  sql: string;
  values: unknown[];
}

class RecordingDatabase {
  readonly runs: RecordedStatement[] = [];

  constructor(private readonly invitation: Record<string, unknown>) {}

  readonly binding = createTestD1Database({
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
          return createTestD1Result<T>({
            success: true,
            results: [],
            meta: { changes: 1 },
          });
        },
      };
      return createTestD1PreparedStatement(prepared);
    },
  });
}

const invitation = {
  id: "018f3f4e-7b5a-7cc1-9a6f-2aa0324b79d0",
  workspace_id: "018f3f4e-7b5a-7cc1-9a6f-2aa0324b79d1",
  workspace_name: "Europe Research",
  workspace_region: "enterprise" as const,
  email: "invitee@example.com",
  role: "admin" as const,
  invited_by_name: "Ada",
  expires_at: "2026-08-08T00:00:00.000Z",
  accepted_at: null,
  accepted_by_user_id: null,
  revoked_at: null,
  created_at: "2026-08-01T00:00:00.000Z",
};

function environment(database: RecordingDatabase, region: string): Env {
  return createTestEnv({
    DB: database.binding,
    AVALON_REGION: region,
    PUBLIC_API_BASE_URL: region === "enterprise"
      ? "https://enterprise.api.with-avalon.com"
      : "https://api.with-avalon.com",
    PUBLIC_WEB_BASE_URL: "https://with-avalon.com",
    DESKTOP_DEEP_LINK_URI: "avalon://auth/complete",
    GOOGLE_OAUTH_CLIENT_ID: "google-client-id",
    GOOGLE_OAUTH_CLIENT_SECRET: "google-client-secret",
    OAUTH_STATE_ENCRYPTION_KEY: "test-oauth-state-encryption-key",
  });
}

afterEach(() => vi.useRealTimers());

describe("organization region bindings", () => {
  it("returns the invitation's enterprise region from the enterprise preview service", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-01T01:00:00.000Z"));
    const database = new RecordingDatabase(invitation);

    await expect(previewInvitation(environment(database, "enterprise"), "p".repeat(32)))
      .resolves.toEqual({
        workspaceId: invitation.workspace_id,
        workspaceName: invitation.workspace_name,
        region: "enterprise",
        email: invitation.email,
        role: "admin",
        expiresAt: invitation.expires_at,
      });
  });

  it("refuses to preview an enterprise invitation through the global service", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-01T01:00:00.000Z"));
    const database = new RecordingDatabase(invitation);

    await expect(previewInvitation(environment(database, "global"), "p".repeat(32)))
      .rejects.toMatchObject({ status: 409, code: "region_mismatch" });
  });

  it("refuses a second regional identity login", async () => {
    const database = new RecordingDatabase(invitation);
    await expect(new AuthService(environment(database, "enterprise")).beginIdentity({
      returnUri: "avalon://auth/complete",
      desktopAttemptId: "a".repeat(43),
      desktopCodeChallenge: "c".repeat(43),
    })).rejects.toMatchObject({ status: 409, code: "global_identity_required" });
    expect(database.runs).toHaveLength(0);
  });

  it("refuses the identity callback when Google is not configured, before spending anything", async () => {
    // The callback half of the flow, which read the credentials unguarded until
    // they became optional on `Env`. Unconfigured, it sent `undefined` to
    // Google and reported the rejection as a token-exchange failure — a
    // misconfiguration wearing a provider fault's error code.
    const database = new RecordingDatabase(invitation);
    const unconfigured = environment(database, "global");
    delete (unconfigured as Partial<Env>).GOOGLE_OAUTH_CLIENT_ID;
    delete (unconfigured as Partial<Env>).GOOGLE_OAUTH_CLIENT_SECRET;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      throw new Error("the identity callback must not reach Google unconfigured");
    });

    try {
      await expect(new AuthService(unconfigured).consumeIdentityCallback("code", "s".repeat(32)))
        .rejects.toMatchObject({ status: 503, code: "google_oauth_not_configured" });
      // Refused before the single-use OAuth state is claimed, so a retry after
      // the deployment is fixed still has one to spend.
      expect(database.runs).toHaveLength(0);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
