import { asUserId, asWorkspaceId } from "@rally/contracts";
import { DatabaseSync } from "node:sqlite";
import type * as WakeupService from "../src/services/workstream-wakeup-service";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthContext, Env } from "../src/env";

// The reconcile is a WorkspaceDO alarm round trip; what this file is about is
// which watch rows get written and whether the workspace is asked to re-derive
// its alarm afterwards, so the call itself is the seam.
vi.mock("../src/services/workstream-wakeup-service", async (importOriginal) => ({
  ...await importOriginal<typeof WakeupService>(),
  refreshWorkspaceSchedule: vi.fn(async () => undefined),
}));

import { refreshWorkspaceSchedule } from "../src/services/workstream-wakeup-service";
import { ResourceService } from "../src/services/resource-service";
import {
  createCloudflareTestBinding,
  createTestDurableObjectId,
  createTestEnv,
} from "./helpers/cloudflare-test";
import {
  seedWorkstreamObjectRoot,
  testSubstreamAgentsBinding,
  testWorkstreamObjectStore,
} from "./helpers/durable-authority";
import { sqliteD1 } from "./helpers/sqlite-d1";
import { createTestWorkspaceDO, workspaceObjectRpcs } from "./helpers/workspace-object-rpcs";

const workspaceId = asWorkspaceId("00000000-0000-7000-8000-000000000001");
const userId = asUserId("00000000-0000-7000-8000-000000000002");
const workstreamId = "00000000-0000-7000-8000-000000000003";
const resourceId = "00000000-0000-7000-8000-000000000004";
const connectionId = "00000000-0000-7000-8000-000000000005";

const open: DatabaseSync[] = [];
afterEach(() => { for (const database of open.splice(0)) database.close(); });

class WatchDatabase {
  /** Make the workspace half of the two-authority write fail, and only that half. */
  failWatchWrite = false;

  /**
   * The workspace's own object, with a real store behind it.
   *
   * The watch row is a typed WorkspaceDO write now rather than routed SQL, so
   * what these tests assert is the row the real object holds — its watch type,
   * its poll deadline — instead of the parameters a recording stub saw.
   */
  readonly workspaceObject = createTestWorkspaceDO({
    workspaceId,
    regionalDatabase: (() => {
      const regional = new DatabaseSync(":memory:");
      open.push(regional);
      return regional;
    })(),
    register: (created) => { open.push(created); },
  });

  readonly workspaceBinding: Env["WORKSPACE_DOS"] = (() => {
    const rpcs = workspaceObjectRpcs(this.workspaceObject.instance, [
      "enableResourceWatch",
      "disableResourceWatch",
      // The resource and connection reads still ride the runtime port; the
      // real object answers that SQL over the same store the watch rows use.
      "executeRuntimeSql",
    ]);
    const stub = {
      ...rpcs,
      enableResourceWatch: (input: unknown) => {
        if (this.failWatchWrite) throw new Error("resource_watch_row_unavailable");
        return (rpcs.enableResourceWatch as (value: unknown) => unknown)(input);
      },
    };
    const binding: Env["WORKSPACE_DOS"] = createCloudflareTestBinding<Env["WORKSPACE_DOS"]>({
      idFromName: (name: string) => createTestDurableObjectId(name),
      get: () => stub,
      jurisdiction: (): Env["WORKSPACE_DOS"] => binding,
    });
    return binding;
  })();

  /**
   * The work stream's own object, with a real store behind it.
   *
   * The attachment half of a watch toggle is an operation, so the link lives
   * in a real object database with the real schema, and the assertions below
   * read it.
   */
  readonly objectStore = testWorkstreamObjectStore();

  readonly agents = testSubstreamAgentsBinding(this.objectStore);

  constructor(readonly connectorType: string) {
    seedWorkstreamObjectRoot(this.objectStore, { workspaceId, workstreamId });
    this.objectStore.prepare(
      `INSERT INTO workstream_resource_links
         (resource_id, attached_by_user_id, watch_enabled, relationship_type,
          resource_json, attached_at, updated_at)
       VALUES (?, NULL, 0, 'attachment', '{}', 1, 1)`,
    ).run(resourceId);
    const objectDatabase = this.workspaceObject.objectDatabase;
    objectDatabase.prepare(
      `INSERT INTO connector_connections
         (id, workspace_id, connector_type, scope, display_name, status,
          model_plugin_id, created_at, updated_at)
       VALUES (?, ?, ?, 'workspace', 'Watched connection', 'healthy',
               'plugin-1', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')`,
    ).run(connectionId, workspaceId, connectorType);
    objectDatabase.prepare(
      `INSERT INTO resources
         (id, workspace_id, connection_id, resource_type, provider, provider_resource_id,
          title, metadata_json, attachment_status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'provider-resource-1', 'Watched resource', '{}', 'attached',
               '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')`,
    ).run(resourceId, workspaceId, connectionId, `${connectorType}_resource`, connectorType);
  }

  /** What the workspace object holds for the one watch these tests write. */
  watchRow(): Record<string, unknown> | undefined {
    return this.workspaceObject.objectDatabase.prepare(
      `SELECT watch_type, next_poll_at, enabled, created_at, updated_at
         FROM resource_watches WHERE workstream_id = ? AND resource_id = ?`,
    ).get(workstreamId, resourceId) as Record<string, unknown> | undefined;
  }

  /** What the work-stream object holds for the one attachment these toggle. */
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
  const regional = new DatabaseSync(":memory:");
  open.push(regional);
  return createTestEnv({
    DB: sqliteD1(regional),
    SUBSTREAM_AGENTS: database.agents,
    WORKSPACE_DOS: database.workspaceBinding,
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

    expect(database.watchRow()).toEqual({
      watch_type: "webhook",
      next_poll_at: null,
      enabled: 1,
      created_at: "2026-08-01T12:00:00.000Z",
      updated_at: "2026-08-01T12:00:00.000Z",
    });
    expect(refreshWorkspaceSchedule).toHaveBeenCalledOnce();
  });

  /**
   * The compensation the two-authority write exists for.
   *
   * The attachment is the work stream object's and the watch row is the
   * workspace object's, so no transaction spans them: the attachment is
   * written first and rolled back by hand — and an attachment left claiming a
   * watch that no sweep will ever poll is a work stream quietly waiting on a
   * resource nobody is reading.
   */
  it("rolls the attachment back when the workspace watch row cannot be written", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-01T12:00:00.000Z"));
    const database = new WatchDatabase("github");
    database.failWatchWrite = true;

    await expect(new ResourceService(environment(database), auth).watch(resourceId, workstreamId))
      .rejects.toThrow("resource_watch_row_unavailable");

    // The link is back where it started. `setWatchEnabled` answers with the
    // value it replaced, so the compensation restores *that* rather than a
    // value read three statements earlier — which is the difference between
    // this and the routed version it replaces.
    expect(database.watchEnabled()).toBe(0);
    expect(database.watchRow()).toBeUndefined();
    // Nothing is due, so nothing asks the scheduler to look.
    expect(refreshWorkspaceSchedule).not.toHaveBeenCalled();
  });

  it("preserves an immediate poll deadline for polling connectors", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-01T12:00:00.000Z"));
    const database = new WatchDatabase("google");

    await new ResourceService(environment(database), auth).watch(resourceId, workstreamId);

    expect(database.watchRow()).toMatchObject({
      watch_type: "incremental",
      next_poll_at: "2026-08-01T12:00:00.000Z",
      enabled: 1,
    });
  });

  it("rejects connectors whose manifest does not support watches", async () => {
    const database = new WatchDatabase("generic_webhook");

    await expect(new ResourceService(environment(database), auth).watch(resourceId, workstreamId))
      .rejects.toMatchObject({ status: 422, code: "watch_not_supported" });
    expect(database.watchRow()).toBeUndefined();
    expect(refreshWorkspaceSchedule).not.toHaveBeenCalled();
  });
});
