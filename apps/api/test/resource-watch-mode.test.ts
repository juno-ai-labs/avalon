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
import {
  seedWorkstreamObjectRoot,
  testSubstreamAgentsBinding,
  testWorkstreamObjectStore,
} from "./helpers/durable-authority";

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
  /** Make the regional half of the two-authority write fail, and only that half. */
  failRegionalWatchWrite = false;


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
          if (recorded.sql.startsWith("SELECT placement_affinity FROM workspaces")) {
            // Routing a statement at the work stream's object resolves where
            // this workspace is placed first. One region here, one answer.
            return { placement_affinity: "wnam" } as T;
          }
          throw new Error(`Unexpected first query: ${recorded.sql}`);
        },
        run: async () => {
          if (this.failRegionalWatchWrite && recorded.sql.startsWith("INSERT INTO resource_watches")) {
            throw new Error("resource_watch_row_unavailable");
          }
          return { success: true, meta: { changes: 1 }, results: [] };
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

  /**
   * The work stream's own object, with a real store behind it.
   *
   * The attachment half of a watch toggle is an operation now rather than SQL,
   * so there is nothing left to record for it — and nothing to fake either. The
   * link lives in a real object database with the real schema, and the
   * assertions below read it. The regional watch row is still SQL and is still
   * recorded, because it is still the half these tests are about.
   */
  readonly objectStore = testWorkstreamObjectStore();

  readonly agents = testSubstreamAgentsBinding(this.objectStore, {
    extra: {
      executeRuntimeSql: async (input: {
        statements: Array<{ sql: string; params: unknown[] }>;
      }) => ({
        status: 200,
        bodyJson: JSON.stringify({
          results: await Promise.all(input.statements.map(async ({ sql, params }) => {
            const statement = this.binding.prepare(sql).bind(...params);
            if (/^\s*SELECT/iu.test(sql) || /\bRETURNING\b/iu.test(sql)) {
              const row = await statement.first<Record<string, string | number | null>>();
              return {
                columns: row ? Object.keys(row) : [],
                rows: row ? [row] : [],
                changes: row ? 1 : 0,
              };
            }
            return { columns: [], rows: [], changes: 1 };
          })),
        }),
      }),
    },
  });

  constructor(readonly connectorType: string) {
    seedWorkstreamObjectRoot(this.objectStore, { workspaceId, workstreamId });
    this.objectStore.prepare(
      `INSERT INTO workstream_resource_links
         (resource_id, attached_by_user_id, watch_enabled, relationship_type,
          resource_json, attached_at, updated_at)
       VALUES (?, NULL, 0, 'explicit', '{}', 1, 1)`,
    ).run(resourceId);
  }

  /** What the object holds for the one attachment these tests toggle. */
  watchEnabled(): number {
    return Number((this.objectStore.prepare(
      `SELECT watch_enabled FROM workstream_resource_links WHERE resource_id = ?`,
    ).get(resourceId) as { watch_enabled: number }).watch_enabled);
  }
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
    SUBSTREAM_AGENTS: database.agents,
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
    // The attachment and the watch row sit in different authorities, so there
    // is no batch that spans them: the attachment is written first, through the
    // work stream's object, and the regional watch row follows.
    expect(database.batches).toBe(0);
    expect(refreshWorkspaceSchedule).toHaveBeenCalledOnce();
  });

  /**
   * The compensation the two-authority write exists for.
   *
   * While both statements went into one `DB.batch`, a failed watch row took the
   * attachment with it and there was nothing to compensate. They cannot share a
   * transaction any more, so the attachment is written first and rolled back by
   * hand — and an attachment left claiming a watch that no sweep will ever poll
   * is a work stream quietly waiting on a resource nobody is reading.
   */
  it("rolls the attachment back when the regional watch row cannot be written", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-01T12:00:00.000Z"));
    const database = new WatchDatabase("github");
    database.failRegionalWatchWrite = true;

    await expect(new ResourceService(environment(database), auth).watch(resourceId, workstreamId))
      .rejects.toThrow("resource_watch_row_unavailable");

    // The link is back where it started. `setWatchEnabled` answers with the
    // value it replaced, so the compensation restores *that* rather than a
    // value read three statements earlier — which is the difference between
    // this and the routed version it replaces.
    expect(database.watchEnabled()).toBe(0);
    // Nothing is due, so nothing asks the scheduler to look.
    expect(refreshWorkspaceSchedule).not.toHaveBeenCalled();
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
