import { describe, expect, it } from "vitest";

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

describe("activity visibility", () => {
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
