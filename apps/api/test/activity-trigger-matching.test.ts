import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";

import { __testing } from "../src/queues/activity-consumer";
import {
  createCloudflareTestBinding,
  createTestDurableObjectId,
  createTestEnv,
} from "./helpers/cloudflare-test";
import { sqliteD1 } from "./helpers/sqlite-d1";

const activity = {
  connection_id: "connection-github-acme",
  connector_type: "github",
  provider: "github",
  event_type: "github.pull_request.merged",
  resource_type: "github_pull_request",
  provider_resource_id: "juno-ai-labs/avalon#42",
  metadata_json: JSON.stringify({ repository: "juno-ai-labs/avalon", baseRef: "main" }),
};

describe("activity automation trigger matching", () => {
  it("matches a source slot only against its exact frozen connection", async () => {
    const trigger = {
      type: "connector_activity" as const,
      connectorType: "github",
      sourceBindingKey: "github_source",
      suggestedSourcePluginId: "plugin_github_acme",
      eventTypes: ["github.pull_request.merged"],
      deterministicFilters: { repository: "juno-ai-labs/avalon", baseRef: "main" },
    };
    const connectorBindings = {
      plugin_github_acme: "connection-github-acme",
      plugin_github_other: "connection-github-other",
    };
    const sourceBindings = { github_source: "plugin_github_acme" };

    await expect(__testing.triggerMatches(
      createTestEnv({}),
      activity as never,
      trigger,
      new Set(),
      connectorBindings,
      sourceBindings,
    )).resolves.toBe(true);
    await expect(__testing.triggerMatches(
      createTestEnv({}),
      { ...activity, connection_id: "connection-github-other" } as never,
      trigger,
      new Set(),
      connectorBindings,
      sourceBindings,
    )).resolves.toBe(false);
  });

  it("retains the frozen connector-set fallback for legacy slotless triggers", async () => {
    await expect(__testing.triggerMatches(
      createTestEnv({}),
      { ...activity, connection_id: "connection-github-other" } as never,
      {
        type: "connector_activity",
        connectorType: "github",
        eventTypes: ["github.pull_request.merged"],
        deterministicFilters: {},
      },
      new Set(),
      { plugin_github_other: "connection-github-other" },
      {},
    )).resolves.toBe(true);
  });

  it("fails closed for restricted workspace activity and personal activity without an owner", () => {
    expect(__testing.restrictedActivityUserIds({
      ...activity,
      connection_scope: "workspace",
      connection_owner_user_id: null,
      target_user_ids_json: "[]",
      visibility_json: JSON.stringify({ workspaceAutomationAllowed: false }),
    } as never)).toEqual([]);
    expect(__testing.restrictedActivityUserIds({
      ...activity,
      connection_scope: "workspace",
      connection_owner_user_id: null,
      target_user_ids_json: "[]",
      visibility_json: JSON.stringify({ allowedUserIds: ["user-adam"] }),
    } as never)).toEqual(["user-adam"]);
    expect(__testing.restrictedActivityUserIds({
      ...activity,
      connection_scope: "personal",
      connection_owner_user_id: null,
      target_user_ids_json: "[]",
      visibility_json: "{}",
    } as never)).toEqual([]);
  });

  it("checks a watched target against authoritative work-stream readers", async () => {
    const workspaceId = "00000000-0000-7000-8000-000000000101";
    const workstreamId = "00000000-0000-7000-8000-000000000102";
    const allowedUserId = "00000000-0000-7000-8000-000000000103";
    const differentUserId = "00000000-0000-7000-8000-000000000104";
    const database = new DatabaseSync(":memory:");
    database.exec(`CREATE TABLE resources (
      id TEXT PRIMARY KEY, workspace_id TEXT, connection_id TEXT, provider TEXT,
      provider_resource_id TEXT, slug TEXT, title TEXT NOT NULL
    )`);
    database.prepare(
      `INSERT INTO resources (id, workspace_id, connection_id, provider, provider_resource_id, title)
       VALUES (?, ?, ?, ?, ?, 'Pull request')`,
    ).run("resource-1", workspaceId, "connection-1", "github", "repo#1");
    const staleProjectionRead = vi.fn(async () => ({
      scope: "personal" as const,
      userIds: [allowedUserId],
    }));
    const workspaceNamespace = {
      idFromName: (name: string) => createTestDurableObjectId(name),
      get: () => ({
        workstreamsForResource: async () => ({ workstreamIds: [workstreamId] }),
        workstreamAudience: staleProjectionRead,
      }),
      jurisdiction: () => workspaceNamespace,
    };
    const authoritativeAudienceRead = vi.fn(async () => ({
      scope: "personal" as const,
      userIds: [differentUserId],
    }));
    const workstreamNamespace = {
      idFromName: (name: string) => createTestDurableObjectId(name),
      get: () => ({ readerAudience: authoritativeAudienceRead }),
      jurisdiction: () => workstreamNamespace,
    };

    await expect(__testing.routeDirectWatches(createTestEnv({
      DB: sqliteD1(database),
      AVALON_REGION: "global",
      WORKSPACE_DOS: createCloudflareTestBinding<DurableObjectNamespace>(workspaceNamespace),
      SUBSTREAM_AGENTS: createCloudflareTestBinding<DurableObjectNamespace>(workstreamNamespace),
    }), {
      workspace_id: workspaceId,
      connection_id: "connection-1",
      connection_scope: "workspace",
      connection_owner_user_id: null,
      provider: "github",
      provider_resource_id: "repo#1",
      entity_keys_json: "[]",
      target_user_ids_json: JSON.stringify([allowedUserId]),
      visibility_json: "{}",
    } as never)).resolves.toEqual(new Set());
    expect(authoritativeAudienceRead).toHaveBeenCalledOnce();
    expect(staleProjectionRead).not.toHaveBeenCalled();
    database.close();
  });
});
