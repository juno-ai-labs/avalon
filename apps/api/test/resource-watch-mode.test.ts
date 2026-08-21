import { asUserId, asWorkspaceId } from "@avalon/contracts";
import type * as WakeupService from "../src/services/workstream-wakeup-service";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthContext, Env } from "../src/env";

// The reconcile is a WorkspaceDO round trip, and binding that namespace here
// would route this fixture's whole SQL surface into a stub object. What this
// file is about is which watch rows get written and whether the workspace is
// asked to re-derive its alarm afterwards, so the call itself is the seam.
vi.mock("../src/services/workstream-wakeup-service", async (importOriginal) => ({
  ...await importOriginal<typeof WakeupService>(),
  refreshWorkspaceSchedule: vi.fn(async () => undefined),
}));

import { refreshWorkspaceSchedule } from "../src/services/workstream-wakeup-service";
import { ResourceService } from "../src/services/resource-service";
import { createTestD1Database, createTestD1PreparedStatement, createTestEnv } from "./helpers/cloudflare-test";

const workspaceId = asWorkspaceId("00000000-0000-7000-8000-000000000001");
const userId = asUserId("00000000-0000-7000-8000-000000000002");
const workstreamId = "00000000-0000-7000-8000-000000000003";
const resourceId = "00000000-0000-7000-8000-000000000004";
const connectionId = "00000000-0000-7000-8000-000000000005";

interface RecordedStatement {
  sql: string;
  values: unknown[];
}

class WatchDatabase {
  readonly statements: RecordedStatement[] = [];
  batches = 0;

  constructor(private readonly connectorType: string) {}

  readonly binding = createTestD1Database({
    prepare: (sql: string) => {
      const recorded = { sql: sql.replace(/\s+/gu, " ").trim(), values: [] as unknown[] };
      this.statements.push(recorded);
      const statement = {
        bind: (...values: unknown[]) => {
          recorded.values = values;
          return statement;
        },
        first: async <T>() => {
          if (recorded.sql.startsWith("SELECT r.*")) {
            return {
              id: resourceId,
              workspace_id: workspaceId,
              connection_id: connectionId,
              resource_type: `${this.connectorType}_resource`,
              provider: this.connectorType,
              provider_resource_id: "provider-resource-1",
              title: "Watched resource",
              watch_enabled: 0,
              created_at: "2026-08-01T12:00:00.000Z",
              updated_at: "2026-08-01T12:00:00.000Z",
            } as T;
          }
          if (recorded.sql.startsWith("SELECT * FROM connector_connections")) {
            return {
              id: connectionId,
              workspace_id: workspaceId,
              connector_type: this.connectorType,
              scope: "workspace",
              owner_user_id: null,
              status: "healthy",
            } as T;
          }
          if (recorded.sql.startsWith("SELECT watch_enabled FROM workstream_resources")) {
            return { watch_enabled: 0 } as T;
          }
          throw new Error(`Unexpected first query: ${recorded.sql}`);
        },
      };
      return createTestD1PreparedStatement(statement);
    },
    batch: async () => {
      this.batches += 1;
      return [
        { success: true, meta: { changes: 1 }, results: [] },
        { success: true, meta: { changes: 1 }, results: [] },
      ];
    },
  });
}

const auth: AuthContext = {
  sessionId: "session-1",
  userId,
  workspaceId,
  region: "global",
  role: "owner",
};

function environment(database: WatchDatabase): Env {
  return createTestEnv({
    DB: database.binding,
    APP_ENV: "test",
    AVALON_REGION: "global",
    PUBLIC_API_BASE_URL: "https://api.with-avalon.com",
    GOOGLE_CONNECTOR_OAUTH_CLIENT_ID: "google-client",
    GOOGLE_CONNECTOR_OAUTH_CLIENT_SECRET: "google-secret",
    GITHUB_APP_ID: "12345",
    GITHUB_APP_CLIENT_ID: "github-client",
    GITHUB_APP_CLIENT_SECRET: "github-secret",
    GITHUB_APP_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\nunused-test-key\n-----END PRIVATE KEY-----",
    GITHUB_WEBHOOK_SECRET: "github-webhook-secret",
  });
}

beforeEach(() => vi.mocked(refreshWorkspaceSchedule).mockClear());
afterEach(() => vi.useRealTimers());

describe("resource watch scheduling modes", () => {
  it("enables a GitHub webhook watch without creating a poll deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-01T12:00:00.000Z"));
    const database = new WatchDatabase("github");

    await expect(new ResourceService(environment(database), auth).watch(resourceId, workstreamId))
      .resolves.toEqual({ watchEnabled: true });

    const enable = database.statements.find((statement) => statement.sql.startsWith("INSERT INTO resource_watches"));
    expect(enable?.values.slice(5, 9)).toEqual([
      "webhook",
      null,
      "2026-08-01T12:00:00.000Z",
      "2026-08-01T12:00:00.000Z",
    ]);
    expect(database.batches).toBe(1);
    expect(refreshWorkspaceSchedule).toHaveBeenCalledOnce();
  });

  it("preserves an immediate poll deadline for polling connectors", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-01T12:00:00.000Z"));
    const database = new WatchDatabase("google");

    await new ResourceService(environment(database), auth).watch(resourceId, workstreamId);

    const enable = database.statements.find((statement) => statement.sql.startsWith("INSERT INTO resource_watches"));
    expect(enable?.values.slice(5, 9)).toEqual([
      "incremental",
      "2026-08-01T12:00:00.000Z",
      "2026-08-01T12:00:00.000Z",
      "2026-08-01T12:00:00.000Z",
    ]);
  });

  it("rejects connectors whose manifest does not support watches", async () => {
    const database = new WatchDatabase("generic_webhook");

    await expect(new ResourceService(environment(database), auth).watch(resourceId, workstreamId))
      .rejects.toMatchObject({ status: 422, code: "watch_not_supported" });
    expect(database.batches).toBe(0);
    expect(refreshWorkspaceSchedule).not.toHaveBeenCalled();
  });
});
