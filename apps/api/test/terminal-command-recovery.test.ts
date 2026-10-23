import { asWorkspaceId } from "@rally/contracts";
import type { HarnessPlugin, HarnessTool, HarnessToolContext } from "@rally/agent-harness";
import { describe, expect, it, vi } from "vitest";

import { __integrationTesting } from "../src/services/integrations";

const RECEIPT = "60fdb63e-25e5-4a58-a3d5-7cf7b6f8b2c1";
const ATTEMPT_STARTED_AT = 1_789_844_823_311;

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
  it("leaves a provider-key write unresolved when its original key is missing", async () => {
    const execute = vi.fn(async () => ({ output: {}, summary: "Should not run" }));
    const plugin = terminalPlugin({
      definition: { name: "recover", description: "Recover", capability: "test.recover", mode: "write",
        idempotency: "provider_key", inputSchema: { type: "object" } },
      reenterable: true, execute,
    });
    await expect(__integrationTesting.reenterInterruptedWrite({
      row: { id: RECEIPT, status: "started", inputHash: "same", inputJson: "{}",
        attemptStartedAt: ATTEMPT_STARTED_AT, providerIdempotencyKey: null },
      expectedInputHash: "same", policyMatches: true,
      expectedPolicy: { pluginId: "rally:terminal", definition: plugin.tools[0]!.definition }, plugins: [plugin], context,
    })).resolves.toBeNull();
    expect(execute).not.toHaveBeenCalled();
  });

  it.each(["landed", "unknown"] as const)("disposes the recovery deadline when reconciliation is %s", async (outcome) => {
    vi.useFakeTimers();
    try {
      const plugin = terminalPlugin({
        definition: { name: "recover", description: "Recover", capability: "test.recover", mode: "write",
          idempotency: "record_before_execute", inputSchema: { type: "object" } },
        reenterable: true,
        reconcileEffect: async () => outcome === "landed"
          ? { outcome: "landed", result: { output: { recovered: true }, summary: "Recovered" } }
          : { outcome: "unknown", reason: "test_receipt_unavailable" },
        execute: async () => { throw new Error("reconciled_effect_must_not_execute"); },
      });
      const recovered = __integrationTesting.reenterInterruptedWrite({
        row: { id: RECEIPT, status: "started", inputHash: "same", inputJson: "{}", attemptStartedAt: ATTEMPT_STARTED_AT, providerIdempotencyKey: null },
        expectedInputHash: "same", policyMatches: true, maxWallClockMs: 1_000,
        expectedPolicy: { pluginId: "rally:terminal", definition: plugin.tools[0]!.definition }, plugins: [plugin], context,
      });
      if (outcome === "landed") await expect(recovered).resolves.toMatchObject({ output: { recovered: true } });
      else await expect(recovered).rejects.toMatchObject({ code: "effect_reconcile_unknown" });
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

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
        attemptStartedAt: ATTEMPT_STARTED_AT,
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
      { ...context, replaying: true, effectIntentId: RECEIPT },
    );
  });

  it("bounds run-owned receipt re-entry by the remaining parent lifetime", async () => {
    const plugin = terminalPlugin({
      deadline: "run",
      definition: { name: "finish", description: "Finish", capability: "test.finish", mode: "write",
        idempotency: "record_before_execute", inputSchema: { type: "object" } },
      reenterable: true,
      execute: async (_args, call) => await new Promise((_resolve, reject) => {
        call.signal.addEventListener("abort", () => reject(call.signal.reason), { once: true });
      }),
    });
    await expect(__integrationTesting.reenterInterruptedWrite({
      row: { id: RECEIPT, status: "started", inputHash: "same", inputJson: '{}',
        attemptStartedAt: ATTEMPT_STARTED_AT, providerIdempotencyKey: null },
      expectedInputHash: "same", policyMatches: true, maxWallClockMs: 5,
      expectedPolicy: { pluginId: "rally:terminal", definition: plugin.tools[0]!.definition },
      plugins: [plugin], context,
    })).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("does not recover another write tool or a mismatched durable input", async () => {
    await expect(__integrationTesting.reenterInterruptedWrite({
      row: {
        id: RECEIPT,
        status: "started",
        inputHash: "old",
        attemptStartedAt: ATTEMPT_STARTED_AT,
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
        attemptStartedAt: ATTEMPT_STARTED_AT,
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
        attemptStartedAt: ATTEMPT_STARTED_AT,
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
        attemptStartedAt: ATTEMPT_STARTED_AT,
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

  const publishDefinition = {
    name: "publish_resource",
    description: "Publish",
    capability: "terminal.resource.publish",
    mode: "write" as const,
    idempotency: "provider_key" as const,
    inputSchema: { type: "object", additionalProperties: true },
  };

  function publishRow() {
    return {
      id: RECEIPT,
      status: "started",
      inputHash: "same",
      inputJson: '{"filePath":"prd.md"}',
      attemptStartedAt: ATTEMPT_STARTED_AT,
      providerIdempotencyKey: "workstream:w:substream:s:loop:turn:64:tool:0",
    };
  }

  it("returns a reconciler's landed result without running the tool", async () => {
    const execute = vi.fn(async () => ({ output: {}, summary: "Should not run" }));
    const reconcileEffect = vi.fn(async () => ({
      outcome: "landed" as const,
      result: { output: { resourceId: "doc" }, summary: "Published prd.md" },
    }));

    await expect(__integrationTesting.reenterInterruptedWrite({
      row: publishRow(),
      expectedInputHash: "same",
      policyMatches: true,
      expectedPolicy: { pluginId: "rally:terminal", definition: publishDefinition },
      plugins: [terminalPlugin({ definition: publishDefinition, reenterable: true, reconcileEffect, execute })],
      context,
    })).resolves.toMatchObject({ summary: "Published prd.md" });

    // The whole point of the hook: an attempt that landed is confirmed, not
    // performed again. Running the executor here would be the second write.
    expect(execute).not.toHaveBeenCalled();
    expect(reconcileEffect).toHaveBeenCalledWith(
      { filePath: "prd.md" },
      expect.objectContaining({ effectIntentId: RECEIPT, attemptStartedAt: ATTEMPT_STARTED_AT }),
    );
  });

  it("runs the tool only once the reconciler proves the effect is absent", async () => {
    const execute = vi.fn(async () => ({ output: { resourceId: "doc" }, summary: "Published" }));

    await expect(__integrationTesting.reenterInterruptedWrite({
      row: publishRow(),
      expectedInputHash: "same",
      policyMatches: true,
      expectedPolicy: { pluginId: "rally:terminal", definition: publishDefinition },
      plugins: [terminalPlugin({
        definition: publishDefinition,
        reenterable: true,
        reconcileEffect: async () => ({ outcome: "not_landed" as const }),
        execute,
      })],
      context,
    })).resolves.toMatchObject({ summary: "Published" });
    expect(execute).toHaveBeenCalledOnce();
  });

  it("refuses to run the tool when the reconciler cannot tell what happened", async () => {
    const execute = vi.fn(async () => ({ output: {}, summary: "Should not run" }));

    await expect(__integrationTesting.reenterInterruptedWrite({
      row: publishRow(),
      expectedInputHash: "same",
      policyMatches: true,
      expectedPolicy: { pluginId: "rally:terminal", definition: publishDefinition },
      plugins: [terminalPlugin({
        definition: publishDefinition,
        reenterable: true,
        reconcileEffect: async () => ({ outcome: "unknown" as const, reason: "publication_revised_by_another_run" }),
        execute,
      })],
      context,
    })).rejects.toMatchObject({ code: "effect_reconcile_unknown" });
    expect(execute).not.toHaveBeenCalled();
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
        attemptStartedAt: ATTEMPT_STARTED_AT,
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
      { ...context, replaying: true, effectIntentId: RECEIPT, providerIdempotencyKey: admittedKey },
    );
  });
});
