import { describe, expect, it } from "vitest";
import { z } from "zod";

import { ORGANIZATION_MODEL_NAMES, modelEnum, modelFailureCode, modelFailureText, modelName, modelValues, storedName, withModelNames } from "./model-names";

const SCOPES = ["personal", "workspace"] as const;

describe("model names", () => {
  it("offers a stored enum under its model names and parses either spelling to the stored value", () => {
    const schema = z.strictObject({ scope: modelEnum(SCOPES, ORGANIZATION_MODEL_NAMES).describe("Who owns it.") });
    expect(z.toJSONSchema(schema, { io: "input" })).toEqual({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: { scope: { type: "string", enum: ["personal", "organization"], description: "Who owns it." } },
      required: ["scope"],
      additionalProperties: false,
    });
    expect(schema.parse({ scope: "organization" })).toEqual({ scope: "workspace" });
    // Instructions saved before the rename may still spell the stored name.
    expect(schema.parse({ scope: "workspace" })).toEqual({ scope: "workspace" });
    expect(schema.parse({ scope: "personal" })).toEqual({ scope: "personal" });
    expect(schema.safeParse({ scope: "team" }).success).toBe(false);
  });

  it("names stored values for a model, and leaves an unmapped value as it is", () => {
    expect(modelValues(SCOPES, ORGANIZATION_MODEL_NAMES)).toEqual(["personal", "organization"]);
    expect(modelName(ORGANIZATION_MODEL_NAMES, "workspace")).toBe("organization");
    expect(modelName(ORGANIZATION_MODEL_NAMES, "editors")).toBe("editors");
    expect(storedName(SCOPES, ORGANIZATION_MODEL_NAMES, "organization")).toBe("workspace");
    expect(storedName(SCOPES, ORGANIZATION_MODEL_NAMES, "team")).toBeUndefined();
  });

  it("translates only the listed fields of a result, at any depth", () => {
    expect(withModelNames({
      connectorId: "slack", scope: "workspace", name: "workspace",
      connections: [{ scope: "workspace", state: "connected" }, { scope: "personal", state: "not_connected" }],
      accounts: [{ scope: "workspace", account: "workspace" }], count: 2, next: null,
    }, ORGANIZATION_MODEL_NAMES, ["scope"])).toEqual({
      connectorId: "slack", scope: "organization", name: "workspace",
      connections: [{ scope: "organization", state: "connected" }, { scope: "personal", state: "not_connected" }],
      accounts: [{ scope: "organization", account: "workspace" }], count: 2, next: null,
    });
  });

  it("names the product in a failure code and leaves everything that is not one as written", () => {
    expect(modelFailureCode("workstream_archived")).toBe("canvas_archived");
    expect(modelFailureCode("memory_user_not_active_workspace_member")).toBe("memory_user_not_active_organization_member");
    expect(modelFailureCode("workspace_workstream_access")).toBe("organization_canvas_access");
    expect(modelFailureCode("substream_not_found")).toBe("conversation_not_found");
    // A sandbox's file workspace and a provider's own account word are not the Organization.
    expect(modelFailureCode("terminal_workspace_changed")).toBe("terminal_workspace_changed");
    expect(modelFailureCode("slack_workspace_already_connected")).toBe("slack_workspace_already_connected");
    expect(modelFailureText("workstream_wakeup_target_unavailable")).toBe("canvas_wakeup_target_unavailable");
    expect(modelFailureText("workstream_archived: Stop sending work to this destination."))
      .toBe("canvas_archived: Stop sending work to this destination.");
    // A sentence may echo what the model sent, and has to echo it exactly.
    expect(modelFailureText("no such table: workspace_metrics")).toBe("no such table: workspace_metrics");
    expect(modelFailureText("Path /workspace/.rally-output/workstream_notes.md was not found"))
      .toBe("Path /workspace/.rally-output/workstream_notes.md was not found");
    expect(modelFailureText("workspace")).toBe("workspace");
  });
});
