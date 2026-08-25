import { asWorkspaceId } from "@rally/contracts";
import type { HarnessEvent } from "@rally/agent-harness";
import { authorizedConnection } from "@rally/connectors";
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
    policy: {
      canonicalToolName: "connector.create",
      capability: "records.write",
      mode: "write",
      idempotency: "record_before_execute",
    },
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
    const connection = authorizedConnection({
      id: "connection-1",
      workspaceId: "668953d2-25f2-44fd-8d72-1e8cf024a277",
      scope: "workspace",
      ownerUserId: null,
      grantedScopes: ["records.write"],
      credentials: {},
      cursor: {},
      config: {},
    });
    const signal = new AbortController().signal;

    expect(__integrationTesting.createConnectorToolContext(
      connection,
      { type: "workspace", workspaceId: asWorkspaceId("668953d2-25f2-44fd-8d72-1e8cf024a277") },
      signal,
      "run-1:turn:1:tool:0",
    )).toEqual({
      connection,
      principal: { type: "workspace", workspaceId: "668953d2-25f2-44fd-8d72-1e8cf024a277" },
      providerIdempotencyKey: "run-1:turn:1:tool:0",
      signal,
    });
    expect(__integrationTesting.createConnectorToolContext(
      connection,
      { type: "workspace", workspaceId: asWorkspaceId("668953d2-25f2-44fd-8d72-1e8cf024a277") },
      signal,
    )).not.toHaveProperty("providerIdempotencyKey");
    expect(__integrationTesting.createConnectorToolContext(
      connection,
      { type: "workspace", workspaceId: asWorkspaceId("668953d2-25f2-44fd-8d72-1e8cf024a277") },
      signal,
      undefined,
      { slackActionToken: "event-only-token" },
    )).toMatchObject({
      invocationAuthorization: { slackActionToken: "event-only-token" },
    });
  });

  it("keeps Slack search results out of durable tool replay payloads", () => {
    const searchOutput = { messages: [{ text: "private transient result" }] };
    expect(__integrationTesting.durableToolReplayOutput(
      "slack.search",
      searchOutput,
      "Searched Slack messages",
    )).toEqual({ transient: true, summary: "Searched Slack messages" });
    expect(__integrationTesting.durableToolReplayOutput(
      "slack.messages.read",
      searchOutput,
      "Read Slack messages",
    )).toBe(searchOutput);
  });
});
