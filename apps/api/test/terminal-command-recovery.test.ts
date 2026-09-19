import { asWorkspaceId } from "@rally/contracts";
import type { HarnessPlugin, HarnessTool, HarnessToolContext } from "@rally/agent-harness";
import { describe, expect, it, vi } from "vitest";

import { __integrationTesting } from "../src/services/integrations";

const RECEIPT = "60fdb63e-25e5-4a58-a3d5-7cf7b6f8b2c1";

const context: Omit<HarnessToolContext, "effectIntentId"> = {
  workspaceId: "1629dee4-8cc4-4531-81f9-b2be8614e062",
  workstreamId: "workstream",
  harnessRunId: "run",
  toolCallId: "call",
  executionPrincipal: { type: "workspace", workspaceId: asWorkspaceId("1629dee4-8cc4-4531-81f9-b2be8614e062") },
  signal: new AbortController().signal,
};

function terminalPlugin(tool: HarnessTool): HarnessPlugin {
  return {
    canonicalId: "rally:terminal",
    modelId: "rally_terminal",
    shortWireName: "",
    description: "Terminal",
    preload: false,
    tools: [tool],
  };
}

describe("Terminal command receipt recovery", () => {
  it("re-executes only the recorded Terminal run_command through its frozen tool", async () => {
    const execute = vi.fn(async () => ({ output: { state: "completed" }, summary: "Recovered" }));
    const plugin = terminalPlugin({
      definition: {
        name: "run_command",
        description: "Run",
        capability: "terminal.command.run",
        mode: "write",
        idempotency: "record_before_execute",
        inputSchema: { type: "object", additionalProperties: true },
      },
      reenterable: true,
      execute,
    });

    await expect(__integrationTesting.reenterInterruptedWrite({
      row: {
        id: RECEIPT,
        status: "ambiguous",
        inputHash: "same",
        inputJson: '{"command":"pwd"}',
        providerIdempotencyKey: null,
      },
      expectedInputHash: "same",
      policyMatches: true,
      expectedPolicy: {
        pluginId: "rally:terminal",
        definition: plugin.tools[0]!.definition,
      },
      plugins: [plugin],
      context,
    })).resolves.toEqual({ output: { state: "completed" }, summary: "Recovered" });

    // The receipt being reconciled is the effect identity: re-entering the
    // tool has to land on the provider task the interrupted attempt started,
    // and nothing else in this context names it.
    expect(execute).toHaveBeenCalledWith(
      { command: "pwd" },
      { ...context, effectIntentId: RECEIPT },
    );
  });

  it("does not recover another write tool or a mismatched durable input", async () => {
    await expect(__integrationTesting.reenterInterruptedWrite({
      row: {
        id: RECEIPT,
        status: "started",
        inputHash: "old",
        inputJson: '{}',
        providerIdempotencyKey: null,
      },
      expectedInputHash: "new",
      policyMatches: true,
      expectedPolicy: {
        pluginId: "rally:terminal",
        definition: {
          name: "write_file",
          description: "Write",
          capability: "terminal.file.write",
          mode: "write",
          idempotency: "record_before_execute",
          inputSchema: { type: "object", additionalProperties: true },
        },
      },
      plugins: [],
      context,
    })).resolves.toBeNull();
  });

  it("refuses a write whose own tool does not declare itself re-enterable", async () => {
    const execute = vi.fn(async () => ({ output: {}, summary: "Should not run" }));
    const definition = {
      name: "write_file",
      description: "Write",
      capability: "terminal.file.write",
      mode: "write" as const,
      idempotency: "record_before_execute" as const,
      inputSchema: { type: "object", additionalProperties: true },
    };

    await expect(__integrationTesting.reenterInterruptedWrite({
      row: {
        id: RECEIPT,
        status: "started",
        inputHash: "same",
        inputJson: '{"filePath":"a.txt","content":"x"}',
        providerIdempotencyKey: null,
      },
      expectedInputHash: "same",
      policyMatches: true,
      expectedPolicy: { pluginId: "rally:terminal", definition },
      plugins: [terminalPlugin({ definition, execute })],
      context,
    })).resolves.toBeNull();
    expect(execute).not.toHaveBeenCalled();
  });

  it("also re-enters the convergent pull-request publisher for the exact receipt", async () => {
    const execute = vi.fn(async () => ({ output: { outcome: "reconciled" }, summary: "Recovered PR" }));
    const definition = {
      name: "publish_branch_and_pr",
      description: "Publish",
      capability: "terminal.repository.publish",
      mode: "write" as const,
      idempotency: "record_before_execute" as const,
      inputSchema: { type: "object", additionalProperties: true },
    };

    await expect(__integrationTesting.reenterInterruptedWrite({
      row: {
        id: RECEIPT,
        status: "started",
        inputHash: "same",
        inputJson: '{"title":"Ship","body":"Why"}',
        providerIdempotencyKey: null,
      },
      expectedInputHash: "same",
      policyMatches: true,
      expectedPolicy: { pluginId: "rally:terminal", definition },
      plugins: [terminalPlugin({ definition, reenterable: true, execute })],
      context,
    })).resolves.toMatchObject({ summary: "Recovered PR" });
    expect(execute).toHaveBeenCalledOnce();
  });

  it("also re-enters repository checkout so an interrupted replacement can converge", async () => {
    const execute = vi.fn(async () => ({ output: { outcome: "already_selected" }, summary: "Recovered checkout" }));
    const definition = {
      name: "checkout_repository",
      description: "Checkout",
      capability: "terminal.repository.checkout",
      mode: "write" as const,
      idempotency: "record_before_execute" as const,
      inputSchema: { type: "object", additionalProperties: true },
    };

    await expect(__integrationTesting.reenterInterruptedWrite({
      row: {
        id: RECEIPT,
        status: "ambiguous",
        inputHash: "same",
        inputJson: '{"repositoryFullName":"owner/repo","requiredRemoteAccess":"read_only"}',
        providerIdempotencyKey: null,
      },
      expectedInputHash: "same",
      policyMatches: true,
      expectedPolicy: { pluginId: "rally:terminal", definition },
      plugins: [terminalPlugin({ definition, reenterable: true, execute })],
      context,
    })).resolves.toMatchObject({ summary: "Recovered checkout" });
    expect(execute).toHaveBeenCalledOnce();
  });

  it("re-enters a provider-keyed publish under the key its receipt was admitted with", async () => {
    const execute = vi.fn(async () => ({ output: { resourceId: "doc" }, summary: "Recovered publish" }));
    const definition = {
      name: "publish_resource",
      description: "Publish",
      capability: "terminal.resource.publish",
      mode: "write" as const,
      idempotency: "provider_key" as const,
      inputSchema: { type: "object", additionalProperties: true },
    };
    const admittedKey = "workstream:w:substream:s:loop:turn:64:tool:0";

    await expect(__integrationTesting.reenterInterruptedWrite({
      row: {
        id: RECEIPT,
        status: "started",
        inputHash: "same",
        inputJson: '{"filePath":"prd.md"}',
        providerIdempotencyKey: admittedKey,
      },
      expectedInputHash: "same",
      policyMatches: true,
      expectedPolicy: { pluginId: "rally:terminal", definition },
      plugins: [terminalPlugin({ definition, reenterable: true, execute })],
      context,
    })).resolves.toMatchObject({ summary: "Recovered publish" });

    // A fresh key would be a key the provider has never seen, which is a second
    // write wearing the name of a retry.
    expect(execute).toHaveBeenCalledWith(
      { filePath: "prd.md" },
      { ...context, effectIntentId: RECEIPT, providerIdempotencyKey: admittedKey },
    );
  });
});
