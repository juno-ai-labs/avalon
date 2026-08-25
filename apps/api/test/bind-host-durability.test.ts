import { describe, expect, it, vi } from "vitest";

import { __integrationTesting } from "../src/services/integrations";

describe("Bind host durability boundaries", () => {
  it("reuses the current started receipt for post-start validation failures", async () => {
    const intents = __integrationTesting.createToolEffectIntents();
    intents.record("call-post-start-validation", "invocation-real-input");
    const persistValidationReceipt = vi.fn(async () => ({
      state: "created" as const,
      invocationId: "invocation-empty-validation-plan",
    }));

    await expect(__integrationTesting.resolveValidationFailureInvocation(
      "call-post-start-validation",
      intents.resolve,
      persistValidationReceipt,
    )).resolves.toEqual({
      invocationId: "invocation-real-input",
      planAlreadyAmbiguous: false,
    });
    expect(persistValidationReceipt).not.toHaveBeenCalled();

    await expect(__integrationTesting.resolveValidationFailureInvocation(
      "call-pre-start-validation",
      intents.resolve,
      persistValidationReceipt,
    )).resolves.toEqual({
      invocationId: "invocation-empty-validation-plan",
      planAlreadyAmbiguous: false,
    });
    expect(persistValidationReceipt).toHaveBeenCalledOnce();
  });

  it("does not treat rejected attachment arguments as an unresolved content access", () => {
    const guard = new __integrationTesting.AttachmentGroundingGuard();
    const policy = { capability: "workstream.resources.read" };
    guard.onStarted({
      type: "tool_started",
      toolCallId: "tool-read-invalid-arguments",
      toolName: "workstream_read_resource",
      pluginId: "avalon_core",
      policy,
      input: {},
    } as never);
    guard.onFailed({
      type: "tool_failed",
      toolCallId: "tool-read-invalid-arguments",
      toolName: "workstream_read_resource",
      pluginId: "avalon_core",
      policy,
      error: "resourceId or cursor is required",
      phase: "validation",
      outcome: "definitive_failure",
    } as never);

    expect(guard.nudge()).toBeNull();
    expect(guard.boundary()).toBeNull();
    expect(guard.diagnostic()).toEqual({ count: 0, errorCodes: [], toolNames: [] });
  });

  it("replaces unverified attachment claims with a content-free provenance boundary", () => {
    const guard = new __integrationTesting.AttachmentGroundingGuard();
    const policy = { capability: "workstream.resources.read" };
    guard.onStarted({
      type: "tool_started",
      toolCallId: "tool-read-csv",
      toolName: "workstream_read_resource",
      pluginId: "avalon_core",
      policy,
      input: { resourceId: "00000000-0000-7000-8000-000000000777" },
    } as never);
    guard.onFailed({
      type: "tool_failed",
      toolCallId: "tool-read-csv",
      toolName: "workstream_read_resource",
      pluginId: "avalon_core",
      policy,
      error: "The resource could not be converted",
      data: { code: "resource_format_unsupported" },
      phase: "execution",
      outcome: "definitive_failure",
    } as never);

    expect(guard.nudge()).toContain("resource 00000000-0000-7000-8000-000000000777");
    expect(guard.nudge()).toBeNull();
    const boundary = guard.boundary();
    expect(boundary).toContain("Attachment content unverified");
    expect(boundary).toContain("resource_format_unsupported");
    expect(boundary).toContain("tool-read-csv");
    expect(boundary).not.toMatch(/July|42|forecast total/iu);

    guard.onStarted({
      type: "tool_started",
      toolCallId: "tool-read-retry",
      toolName: "workstream_read_resource",
      pluginId: "avalon_core",
      policy,
      input: { resourceId: "00000000-0000-7000-8000-000000000777" },
    } as never);
    guard.onCompleted({
      type: "tool_completed",
      toolCallId: "tool-read-retry",
      toolName: "workstream_read_resource",
      pluginId: "avalon_core",
      policy,
      result: { output: {}, summary: "verified" },
    } as never);
    expect(guard.boundary()).toBeNull();
  });

  it("keeps skipped image resources unverified while clearing included images", () => {
    const guard = new __integrationTesting.AttachmentGroundingGuard();
    const policy = { capability: "workstream.resources.view" };
    const includedId = "00000000-0000-7000-8000-000000000771";
    const skippedId = "00000000-0000-7000-8000-000000000772";
    guard.onStarted({
      type: "tool_started",
      toolCallId: "tool-view-mixed",
      toolName: "workstream_view_resource",
      pluginId: "avalon_core",
      policy,
      input: { resourceIds: [includedId, skippedId] },
    } as never);
    guard.onCompleted({
      type: "tool_completed",
      toolCallId: "tool-view-mixed",
      toolName: "workstream_view_resource",
      pluginId: "avalon_core",
      policy,
      result: {
        summary: "Viewed one of two requested images",
        output: {
          requested: 2,
          returned: 1,
          items: [{
            resourceId: includedId,
            title: "Included",
            sourceMimeType: "image/png",
            modelMimeType: "image/png",
            version: { sha256: "a".repeat(64), extractorVersion: "image-v1" },
            sourceBytes: 100,
            derivativeBytes: 80,
            width: 10,
            height: 10,
            status: "included",
            reasonCode: null,
            reason: null,
            suggestedCall: null,
            visualPartIndex: 0,
          }, {
            resourceId: skippedId,
            title: "Skipped",
            sourceMimeType: "image/png",
            modelMimeType: null,
            version: null,
            sourceBytes: 100,
            derivativeBytes: null,
            width: null,
            height: null,
            status: "skipped",
            reasonCode: "resource_conversion_failed",
            reason: "The image could not be safely converted",
            suggestedCall: null,
            visualPartIndex: null,
          }],
        },
      },
    } as never);

    expect(guard.boundary()).toContain(`Resource ${skippedId}`);
    expect(guard.boundary()).not.toContain(`Resource ${includedId}`);
  });

  it("clears a failed cursor read after a resource-identified retry succeeds", () => {
    const guard = new __integrationTesting.AttachmentGroundingGuard();
    const policy = { capability: "workstream.resources.read" };
    const resourceId = "00000000-0000-7000-8000-000000000773";
    guard.onStarted({
      type: "tool_started",
      toolCallId: "tool-read-cursor",
      toolName: "workstream_read_resource",
      pluginId: "avalon_core",
      policy,
      input: { cursor: "sealed-cursor" },
    } as never);
    guard.onFailed({
      type: "tool_failed",
      toolCallId: "tool-read-cursor",
      toolName: "workstream_read_resource",
      pluginId: "avalon_core",
      policy,
      error: "The resource changed; restart the read from its resource ID",
      data: { code: "resource_version_changed", details: { resourceId } },
      phase: "execution",
      outcome: "definitive_failure",
    } as never);
    expect(guard.boundary()).toContain(resourceId);

    guard.onStarted({
      type: "tool_started",
      toolCallId: "tool-read-retry",
      toolName: "workstream_read_resource",
      pluginId: "avalon_core",
      policy,
      input: { resourceId },
    } as never);
    guard.onCompleted({
      type: "tool_completed",
      toolCallId: "tool-read-retry",
      toolName: "workstream_read_resource",
      pluginId: "avalon_core",
      policy,
      result: { output: { resourceId }, summary: "Read resource" },
    } as never);
    expect(guard.boundary()).toBeNull();
  });
  it("returns preload candidates to Bind only after their activation is persisted", async () => {
    const order: string[] = [];
    const persisted = new Set<string>();
    const prepared = new Set<string>();
    let signalPersistStarted!: () => void;
    let releasePersistence!: () => void;
    const persistStarted = new Promise<void>((resolve) => { signalPersistStarted = resolve; });
    const persistenceGate = new Promise<void>((resolve) => { releasePersistence = resolve; });

    const preparing = __integrationTesting.persistInitialPluginActivations(
      ["connection:preload", "connection:revoked", "connection:unavailable", "connection:preload"],
      async (pluginId) => {
        order.push(`reauthorize:${pluginId}`);
        return pluginId === "connection:revoked" ? "denied" : "authorized";
      },
      async (pluginId) => {
        expect(prepared.has(pluginId)).toBe(true);
        order.push(`persist:start:${pluginId}`);
        signalPersistStarted();
        await persistenceGate;
        persisted.add(pluginId);
        order.push(`persist:finish:${pluginId}`);
      },
      async (pluginId) => {
        order.push(`prepare:${pluginId}`);
        if (pluginId === "connection:unavailable") return false;
        prepared.add(pluginId);
        return true;
      },
    );

    await persistStarted;
    let finished = false;
    void preparing.then(() => { finished = true; });
    await Promise.resolve();
    expect(finished).toBe(false);

    releasePersistence();
    const activationHints = await preparing;

    expect(activationHints).toEqual(["connection:preload"]);
    expect(activationHints.every((pluginId) => persisted.has(pluginId))).toBe(true);
    expect(order).toEqual([
      "reauthorize:connection:preload",
      "prepare:connection:preload",
      "persist:start:connection:preload",
      "persist:finish:connection:preload",
      "reauthorize:connection:revoked",
      "reauthorize:connection:unavailable",
      "prepare:connection:unavailable",
    ]);
  });

  it("omits a final message id for an empty elicitation needs-input run", () => {
    const messageId = "00000000-0000-4000-8000-000000000003";
    const result = __integrationTesting.workstreamHarnessTerminalResult({
      outcome: { status: "needs_input" },
      streamedText: "",
      messageId,
      ambiguousToolOutcome: false,
      stoppedByUser: false,
    });

    expect(result).toEqual({ status: "needs_input" });
    expect("messageId" in result).toBe(false);
    expect(__integrationTesting.workstreamHarnessTerminalResult({
      outcome: { status: "needs_input" },
      streamedText: "I need one detail before continuing.",
      messageId,
      ambiguousToolOutcome: false,
      stoppedByUser: false,
    })).toEqual({ status: "needs_input", messageId });
  });

  it("says why an ambiguous halt stopped the run, which nothing else may record", () => {
    const messageId = "00000000-0000-4000-8000-000000000003";
    // An elicitation leaves a question in the transcript to answer. An
    // ambiguity that collided with an already-settled receipt leaves the row
    // untouched, so the run is the only thing left that can explain itself.
    expect(__integrationTesting.workstreamHarnessTerminalResult({
      outcome: { status: "completed" },
      streamedText: "I will locate the repository.",
      messageId,
      ambiguousToolOutcome: true,
      stoppedByUser: false,
    })).toEqual({
      status: "needs_input",
      messageId,
      error: {
        code: "ambiguous_external_write",
        message: "An external action's outcome could not be confirmed, so Rally stopped instead of repeating it",
      },
    });
  });
});
