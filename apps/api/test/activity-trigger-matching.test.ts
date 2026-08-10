import { describe, expect, it } from "vitest";

import type { Env } from "../src/env";
import { __testing } from "../src/queues/activity-consumer";

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
      {} as Env,
      activity as never,
      trigger,
      new Set(),
      connectorBindings,
      sourceBindings,
    )).resolves.toBe(true);
    await expect(__testing.triggerMatches(
      {} as Env,
      { ...activity, connection_id: "connection-github-other" } as never,
      trigger,
      new Set(),
      connectorBindings,
      sourceBindings,
    )).resolves.toBe(false);
  });

  it("retains the frozen connector-set fallback for legacy slotless triggers", async () => {
    await expect(__testing.triggerMatches(
      {} as Env,
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
});
