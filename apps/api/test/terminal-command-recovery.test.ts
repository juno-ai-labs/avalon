import { asWorkspaceId } from "@avalon/contracts";
import type { HarnessPlugin, HarnessToolContext } from "@avalon/agent-harness";
import { describe, expect, it, vi } from "vitest";

import { __integrationTesting } from "../src/services/integrations";

const context: HarnessToolContext = {
  workspaceId: "1629dee4-8cc4-4531-81f9-b2be8614e062",
  workstreamId: "workstream",
  harnessRunId: "run",
  toolCallId: "call",
  executionPrincipal: { type: "workspace", workspaceId: asWorkspaceId("1629dee4-8cc4-4531-81f9-b2be8614e062") },
  signal: new AbortController().signal,
};

describe("Terminal command receipt recovery", () => {
  it("re-executes only the recorded Terminal run_command through its frozen tool", async () => {
    const execute = vi.fn(async () => ({ output: { state: "completed" }, summary: "Recovered" }));
    const plugin: HarnessPlugin = {
      canonicalId: "avalon:terminal",
      modelId: "avalon_terminal",
      shortWireName: "terminal",
      description: "Terminal",
      preload: false,
      tools: [{
        definition: {
          name: "run_command",
          description: "Run",
          capability: "terminal.command.run",
          mode: "write",
          idempotency: "record_before_execute",
          inputSchema: { type: "object", additionalProperties: true },
        },
        execute,
      }],
    };

    await expect(__integrationTesting.reconcileRecoverableTerminalWrite({
      row: { status: "ambiguous", inputHash: "same", inputJson: '{"command":"pwd"}' },
      expectedInputHash: "same",
      policyMatches: true,
      expectedPolicy: {
        pluginId: "avalon:terminal",
        definition: plugin.tools[0]!.definition,
      },
      plugins: [plugin],
      context,
    })).resolves.toEqual({ output: { state: "completed" }, summary: "Recovered" });

    expect(execute).toHaveBeenCalledWith({ command: "pwd" }, context);
  });

  it("does not recover another write tool or a mismatched durable input", async () => {
    await expect(__integrationTesting.reconcileRecoverableTerminalWrite({
      row: { status: "started", inputHash: "old", inputJson: '{}' },
      expectedInputHash: "new",
      policyMatches: true,
      expectedPolicy: {
        pluginId: "avalon:terminal",
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
    const plugin: HarnessPlugin = {
      canonicalId: "avalon:terminal",
      modelId: "avalon_terminal",
      shortWireName: "terminal",
      description: "Terminal",
      preload: false,
      tools: [{ definition, execute }],
    };

    await expect(__integrationTesting.reconcileRecoverableTerminalWrite({
      row: { status: "started", inputHash: "same", inputJson: '{"title":"Ship","body":"Why"}' },
      expectedInputHash: "same",
      policyMatches: true,
      expectedPolicy: { pluginId: "avalon:terminal", definition },
      plugins: [plugin],
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
    const plugin: HarnessPlugin = {
      canonicalId: "avalon:terminal",
      modelId: "avalon_terminal",
      shortWireName: "terminal",
      description: "Terminal",
      preload: false,
      tools: [{ definition, execute }],
    };

    await expect(__integrationTesting.reconcileRecoverableTerminalWrite({
      row: { status: "ambiguous", inputHash: "same", inputJson: '{"repositoryFullName":"owner/repo","requiredRemoteAccess":"read_only"}' },
      expectedInputHash: "same",
      policyMatches: true,
      expectedPolicy: { pluginId: "avalon:terminal", definition },
      plugins: [plugin],
      context,
    })).resolves.toMatchObject({ summary: "Recovered checkout" });
    expect(execute).toHaveBeenCalledOnce();
  });
});
