import type { HarnessEvent } from "@avalon/agent-harness";
import type { ConnectorConnectionContext } from "@avalon/connectors";
import { describe, expect, it } from "vitest";

import { __integrationTesting } from "../src/services/integrations";

function toolFailure(
  outcome: Extract<HarnessEvent, { type: "tool_failed" }>["outcome"],
  phase: Extract<HarnessEvent, { type: "tool_failed" }>["phase"] = "execution",
): Extract<HarnessEvent, { type: "tool_failed" }> {
  return {
    type: "tool_failed",
    toolCallId: "run-1:turn:1:tool:0",
    toolName: "connector.create",
    pluginId: "connection:connection-1",
    error: "Provider request failed",
    phase,
    outcome,
  };
}

describe("Bind tool failure persistence", () => {
  it("does not infer write ambiguity from a definitive provider failure", () => {
    expect(__integrationTesting.classifyHarnessToolFailure(
      toolFailure("definitive_failure"),
    )).toEqual({
      ambiguous: false,
      errorCode: "tool_failed",
      checkpointPhase: "execution_failed",
    });
  });

  it("persists explicit ambiguous and timeout outcomes distinctly", () => {
    expect(__integrationTesting.classifyHarnessToolFailure(
      toolFailure("ambiguous_external_write"),
    )).toEqual({
      ambiguous: true,
      errorCode: "ambiguous_external_write",
      checkpointPhase: "ambiguous_external_write",
    });
    expect(__integrationTesting.classifyHarnessToolFailure(
      toolFailure("timed_out"),
    )).toEqual({
      ambiguous: false,
      errorCode: "tool_timeout",
      checkpointPhase: "timed_out",
    });
  });

  it("passes the provider idempotency key into connector execution context", () => {
    const connection: ConnectorConnectionContext = {
      id: "connection-1",
      workspaceId: "workspace-1",
      scope: "workspace",
      ownerUserId: null,
      grantedScopes: ["records.write"],
      credentials: {},
      cursor: {},
      config: {},
    };
    const signal = new AbortController().signal;

    expect(__integrationTesting.createConnectorToolContext(
      connection,
      { type: "workspace", workspaceId: "workspace-1" },
      signal,
      "run-1:turn:1:tool:0",
    )).toEqual({
      connection,
      principal: { type: "workspace", workspaceId: "workspace-1" },
      providerIdempotencyKey: "run-1:turn:1:tool:0",
      signal,
    });
    expect(__integrationTesting.createConnectorToolContext(
      connection,
      { type: "workspace", workspaceId: "workspace-1" },
      signal,
    )).not.toHaveProperty("providerIdempotencyKey");
  });
});
