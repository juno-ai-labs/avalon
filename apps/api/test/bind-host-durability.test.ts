import { describe, expect, it, vi } from "vitest";

import { __integrationTesting } from "../src/services/integrations";

function attachmentReadPage(
  resourceId: string,
  nextCursor: string | null,
  previousCursor: string | null = null,
  start = 0,
) {
  const totalCharacters = 24_000;
  const end = Math.min(totalCharacters, start + 12_000);
  return {
    resourceId,
    title: "Call transcript",
    sourceMimeType: "text/plain",
    modelMimeType: "text/plain",
    version: { sha256: "a".repeat(64), extractorVersion: "text-v1" },
    range: { start, end },
    totalCharacters,
    charactersBefore: start,
    charactersReturned: end - start,
    charactersAfter: totalCharacters - end,
    text: "verified page",
    previousCursor,
    nextCursor,
  };
}

function attachmentSearchResult(resourceId: string, readCursor: string) {
  return {
    resourceId,
    title: "Call transcript",
    sourceMimeType: "text/plain",
    modelMimeType: "text/plain",
    version: { sha256: "a".repeat(64), extractorVersion: "text-v1" },
    query: "decision",
    totalMatches: 1,
    returnedMatches: 1,
    passages: [{
      rank: 1,
      sectionLabel: null,
      range: { start: 0, end: 8 },
      text: "decision",
      readCursor,
    }],
    truncated: false,
  };
}

function attachmentSummaryResult(resourceId: string, readCursor: string) {
  return {
    resourceId,
    title: "Call transcript",
    sourceMimeType: "text/plain",
    modelMimeType: "text/plain",
    version: { sha256: "a".repeat(64), extractorVersion: "text-v1" },
    prompt: null,
    outline: [],
    summary: "Verified summary",
    citations: [{ label: "Decision", range: { start: 0, end: 8 }, readCursor }],
    coverage: {
      status: "complete",
      totalCharacters: 24_000,
      consideredCharacters: 24_000,
      limitations: [],
    },
  };
}

function attachmentReceipt(overrides: Record<string, unknown>) {
  return {
    effectIntentId: "effect-1",
    runId: "run-1",
    toolCallId: "tool-read-1",
    toolName: "read_resource",
    mode: "read",
    connectionId: null,
    requestHash: "hash",
    inputJson: JSON.stringify({}),
    status: "completed",
    outputRef: null,
    outputSummary: null,
    providerOperationId: null,
    errorJson: null,
    executionPlanHash: "plan",
    executionPlanJson: JSON.stringify({ capability: "workstream.resources.read" }),
    startedAt: 1,
    settledAt: 2,
    checkpointIndex: 1,
    ...overrides,
  };
}

describe("Bind host durability boundaries", () => {
  it("requires an explicit protocol turn identity for every durable final response", () => {
    expect(__integrationTesting.resolveHarnessFinalTurnId("accepted response", "run-1:turn:2"))
      .toBe("run-1:turn:2");
    expect(__integrationTesting.resolveHarnessFinalTurnId("", null)).toBeNull();
    expect(() => __integrationTesting.resolveHarnessFinalTurnId("unowned response", null))
      .toThrow("harness_final_turn_identity_missing");
  });

  it("publishes post-run attachment safety text with explicit host provenance", () => {
    const boundary = "Attachment content unverified. Rally stopped before using it.";
    expect(__integrationTesting.applyHarnessAttachmentBoundary(
      { text: "raw provider text", turnId: "turn-1" },
      boundary,
      new Set(),
    )).toEqual({
      finalTurn: { text: "", turnId: null },
      participantNotice: boundary,
    });
    expect(__integrationTesting.applyHarnessAttachmentBoundary(
      { text: boundary, turnId: "turn-1" },
      boundary,
      new Set(["turn-1"]),
    )).toEqual({
      finalTurn: { text: boundary, turnId: "turn-1" },
      participantNotice: null,
    });
    expect(__integrationTesting.applyHarnessAttachmentBoundary(
      { text: "raw provider text", turnId: null },
      boundary,
      new Set(),
    )).toEqual({
      finalTurn: { text: "", turnId: null },
      participantNotice: boundary,
    });
    expect(__integrationTesting.applyHarnessAttachmentBoundary(
      { text: "accepted intermediate text", turnId: "turn-1" },
      boundary,
      new Set(["turn-1"]),
    )).toEqual({
      finalTurn: { text: "accepted intermediate text", turnId: "turn-1" },
      participantNotice: boundary,
    });
  });

  it("keeps only the current Bind turn when a non-completed run has crossed a tool boundary", () => {
    let streamed = { text: "", turnId: null as string | null };
    streamed = __integrationTesting.advanceHarnessStreamText(streamed, {
      type: "stream_started", turnId: "run-1:turn:1",
    });
    streamed = __integrationTesting.advanceHarnessStreamText(streamed, {
      type: "stream_delta", turnId: "run-1:turn:1", delta: "I will check.", reset: false,
    });
    streamed = __integrationTesting.advanceHarnessStreamText(streamed, {
      type: "stream_started", turnId: "run-1:turn:2",
    });
    streamed = __integrationTesting.advanceHarnessStreamText(streamed, {
      type: "stream_delta", turnId: "run-1:turn:2", delta: "Here is the partial result.", reset: false,
    });

    expect(streamed).toEqual({
      text: "Here is the partial result.",
      turnId: "run-1:turn:2",
    });
  });

  it("replaces only the retried current turn before Bind accepts it", () => {
    let streamed = { text: "discard", turnId: "run-1:turn:2" as string | null };
    streamed = __integrationTesting.advanceHarnessStreamText(streamed, {
      type: "stream_delta", turnId: "run-1:turn:2", delta: "recovered", reset: true,
    });

    expect(streamed).toEqual({ text: "recovered", turnId: "run-1:turn:2" });
  });

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
      toolName: "read_resource",
      pluginId: "rally_core",
      policy,
      input: {},
    } as never);
    guard.onFailed({
      type: "tool_failed",
      toolCallId: "tool-read-invalid-arguments",
      toolName: "read_resource",
      pluginId: "rally_core",
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
      toolName: "read_resource",
      pluginId: "rally_core",
      policy,
      input: { resourceId: "00000000-0000-7000-8000-000000000777" },
    } as never);
    guard.onFailed({
      type: "tool_failed",
      toolCallId: "tool-read-csv",
      toolName: "read_resource",
      pluginId: "rally_core",
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
      toolName: "read_resource",
      pluginId: "rally_core",
      policy,
      input: { resourceId: "00000000-0000-7000-8000-000000000777" },
    } as never);
    guard.onCompleted({
      type: "tool_completed",
      toolCallId: "tool-read-retry",
      toolName: "read_resource",
      pluginId: "rally_core",
      policy,
      result: { output: {}, summary: "verified" },
    } as never);
    expect(guard.boundary()).toBeNull();
  });

  it("replaces the terminal turn before acceptance and suppresses a redundant retry", () => {
    const guard = new __integrationTesting.AttachmentGroundingGuard();
    const policy = { capability: "workstream.resources.read" };
    guard.onStarted({
      type: "tool_started",
      toolCallId: "tool-read-failed",
      toolName: "read_resource",
      pluginId: "rally_core",
      policy,
      input: { resourceId: "00000000-0000-7000-8000-000000000778" },
    } as never);
    guard.onFailed({
      type: "tool_failed",
      toolCallId: "tool-read-failed",
      toolName: "read_resource",
      pluginId: "rally_core",
      policy,
      error: "The resource could not be converted",
      data: { code: "resource_format_unsupported" },
      phase: "execution",
      outcome: "definitive_failure",
    } as never);

    expect(guard.hasUnresolved()).toBe(true);
    const accepted = guard.sanitizeAssistantContent("The spreadsheet says July is 42.", false);
    expect(accepted).toContain("Attachment content unverified");
    expect(accepted).toContain("resource_format_unsupported");
    expect(accepted).not.toMatch(/July|42|spreadsheet says/iu);
    expect(guard.consumeTerminalBoundaryApplied()).toBe(true);
    expect(guard.consumeTerminalBoundaryApplied()).toBe(false);
  });

  it("settles the content Bind accepted even when a later tool clears the grounding failure", () => {
    const guard = new __integrationTesting.AttachmentGroundingGuard();
    const policy = { capability: "workstream.resources.read" };
    const resourceId = "00000000-0000-7000-8000-000000000779";
    guard.onStarted({
      type: "tool_started",
      toolCallId: "tool-read-failed-first",
      toolName: "read_resource",
      pluginId: "rally_core",
      policy,
      input: { resourceId },
    } as never);
    guard.onFailed({
      type: "tool_failed",
      toolCallId: "tool-read-failed-first",
      toolName: "read_resource",
      pluginId: "rally_core",
      policy,
      error: "The resource could not be converted",
      data: { code: "resource_format_unsupported" },
      phase: "execution",
      outcome: "definitive_failure",
    } as never);

    const accepted = __integrationTesting.acceptHarnessAssistantContent(guard, {
      turnId: "run-one:turn:2",
      content: "The unverified total is 42; I will try another reader.",
      hasToolCalls: true,
    });
    // A tool-bearing turn may still recover, so its prose is withheld rather
    // than published as one more copy of the boundary.
    expect(accepted).toEqual({ turnId: "run-one:turn:2", text: "" });
    expect(guard.consumeTerminalBoundaryApplied()).toBe(false);

    guard.onStarted({
      type: "tool_started",
      toolCallId: "tool-read-recovery",
      toolName: "read_resource",
      pluginId: "rally_core",
      policy,
      input: { resourceId },
    } as never);
    guard.onCompleted({
      type: "tool_completed",
      toolCallId: "tool-read-recovery",
      toolName: "read_resource",
      pluginId: "rally_core",
      policy,
      result: { output: { resourceId }, summary: "verified" },
    } as never);

    expect(guard.boundary()).toBeNull();
    // Settlement owns the accepted copy, not the earlier streamed provider
    // text and not whatever guard state happens to remain at run completion.
    expect(accepted.text).toBe("");
  });

  it("publishes the boundary once when every tool round fails and the answer ends tool-less", () => {
    const guard = new __integrationTesting.AttachmentGroundingGuard();
    const policy = { capability: "workstream.resources.read" };
    const resourceId = "00000000-0000-7000-8000-000000000781";
    guard.onStarted({ type: "tool_started", toolCallId: "tool-read-unconvertible", toolName: "read_resource",
      pluginId: "rally_core", policy, input: { resourceId } } as never);
    guard.onFailed({ type: "tool_failed", toolCallId: "tool-read-unconvertible", toolName: "read_resource",
      pluginId: "rally_core", policy, error: "The resource could not be converted",
      data: { code: "resource_format_unsupported" }, phase: "execution", outcome: "definitive_failure" } as never);

    const turns = [
      { turnId: "run-two:turn:2", content: "Let me list the threads.", hasToolCalls: true },
      { turnId: "run-two:turn:3", content: "Reading three threads now.", hasToolCalls: true },
      { turnId: "run-two:turn:4", content: "Here is the comparison.", hasToolCalls: false },
    ].map((turn) => __integrationTesting.acceptHarnessAssistantContent(guard, turn).text);

    expect(turns.filter((text) => text.includes("Attachment content unverified"))).toHaveLength(1);
    expect(turns.slice(0, 2)).toEqual(["", ""]);
    expect(turns[2]).toContain(`Resource ${resourceId}`);
  });

  it("states the boundary once when the run ends on a withheld tool-bearing turn", () => {
    const boundary = "## Attachment content unverified";
    expect(__integrationTesting.applyHarnessAttachmentBoundary(
      { text: "", turnId: "run-three:turn:2" },
      boundary,
      new Set(["run-three:turn:2"]),
    )).toEqual({
      finalTurn: { text: "", turnId: "run-three:turn:2" },
      participantNotice: boundary,
    });
  });

  it("keeps a partial read unverified when the rest of the resource disappears mid-run", async () => {
    const guard = new __integrationTesting.AttachmentGroundingGuard();
    const policy = { capability: "workstream.resources.read" };
    const resourceId = "00000000-0000-7000-8000-000000000783";
    guard.onStarted({ type: "tool_started", toolCallId: "tool-read-page-1", toolName: "read_resource",
      pluginId: "rally_core", policy, input: { resourceId } } as never);
    guard.onCompleted({ type: "tool_completed", toolCallId: "tool-read-page-1", toolName: "read_resource",
      pluginId: "rally_core", policy, result: { summary: "page 1", output: {
        resourceId, nextPageId: "page-2", previousPageId: null,
      } } } as never);
    guard.onStarted({ type: "tool_started", toolCallId: "tool-read-page-2", toolName: "read_resource",
      pluginId: "rally_core", policy, input: { pageId: "page-2" } } as never);
    guard.onFailed({ type: "tool_failed", toolCallId: "tool-read-page-2", toolName: "read_resource",
      pluginId: "rally_core", policy, error: "The resource was not found",
      data: { code: "resource_not_found" }, phase: "execution", outcome: "definitive_failure" } as never);

    expect(guard.boundary()).toContain(`Resource ${resourceId}`);

    const replayed = new __integrationTesting.AttachmentGroundingGuard();
    const receipt = (overrides: Record<string, unknown>) => ({
      effectIntentId: "effect-page", runId: "run-1", toolCallId: "tool-read-page", toolName: "read_resource",
      mode: "read", connectionId: null, requestHash: "hash", inputJson: JSON.stringify({ resourceId }),
      status: "completed", outputRef: null, outputSummary: null, providerOperationId: null, errorJson: null,
      executionPlanHash: "plan", executionPlanJson: JSON.stringify({ capability: "workstream.resources.read" }),
      startedAt: 1, settledAt: 2, checkpointIndex: 0, ...overrides,
    });
    await replayed.restoreReceipts([
      receipt({}),
      receipt({ effectIntentId: "effect-page-again", toolCallId: "tool-read-page-again", status: "failed",
        errorJson: JSON.stringify({ code: "tool_failed",
          data: { code: "resource_not_found", details: { resourceId } } }), startedAt: 3, settledAt: 4 }),
    ] as never);
    expect(replayed.boundary()).toContain(`Resource ${resourceId}`);
  });

  it("does not hold an answer hostage to a resource this conversation cannot see", async () => {
    const guard = new __integrationTesting.AttachmentGroundingGuard();
    const readPolicy = { capability: "workstream.resources.read" };
    const viewPolicy = { capability: "workstream.resources.view" };
    const foreignId = "00000000-0000-7000-8000-000000000782";
    guard.onStarted({ type: "tool_started", toolCallId: "tool-read-foreign", toolName: "read_resource",
      pluginId: "rally_core", policy: readPolicy, input: { resourceId: foreignId, startCharacter: 0 } } as never);
    guard.onFailed({ type: "tool_failed", toolCallId: "tool-read-foreign", toolName: "read_resource",
      pluginId: "rally_core", policy: readPolicy, error: "The resource was not found",
      data: { code: "resource_not_found", details: { resourceId: foreignId } },
      phase: "execution", outcome: "definitive_failure" } as never);
    guard.onStarted({ type: "tool_started", toolCallId: "tool-view-foreign", toolName: "view_resource",
      pluginId: "rally_core", policy: viewPolicy, input: { resourceIds: [foreignId] } } as never);
    guard.onCompleted({ type: "tool_completed", toolCallId: "tool-view-foreign", toolName: "view_resource",
      pluginId: "rally_core", policy: viewPolicy, result: { summary: "Viewed none", output: {
        requested: 1, returned: 0, items: [{
          resourceId: foreignId, title: "Unavailable", sourceMimeType: null, modelMimeType: null,
          version: null, sourceBytes: 0, derivativeBytes: null, width: null, height: null,
          status: "skipped", reasonCode: "resource_not_found", reason: "The resource was not found",
          suggestedCall: null, visualPartIndex: null,
        }],
      } } } as never);
    await guard.restoreReceipts([{
      effectIntentId: "effect-foreign", runId: "run-1", toolCallId: "tool-read-foreign-replayed",
      toolName: "read_resource", mode: "read", connectionId: null, requestHash: "hash",
      inputJson: JSON.stringify({ resourceId: foreignId }), status: "failed", outputRef: null,
      outputSummary: null, providerOperationId: null,
      errorJson: JSON.stringify({ code: "tool_failed", message: "The resource was not found",
        data: { code: "resource_not_found", details: { resourceId: foreignId } } }),
      executionPlanHash: "plan", executionPlanJson: JSON.stringify({ capability: "workstream.resources.read" }),
      startedAt: 1, settledAt: 2, checkpointIndex: 0,
    }] as never);

    expect(guard.boundary()).toBeNull();
    expect(guard.nudge()).toBeNull();
    expect(__integrationTesting.acceptHarnessAssistantContent(guard, {
      turnId: "run-four:turn:5", content: "Here is the comparison.", hasToolCalls: false,
    }).text).toBe("Here is the comparison.");
  });

  it("rebuilds attachment safety from durable receipts and lets a later verified read clear it", async () => {
    const guard = new __integrationTesting.AttachmentGroundingGuard();
    const resourceId = "00000000-0000-7000-8000-000000000780";
    const receipt = (overrides: Record<string, unknown>) => ({
      effectIntentId: "effect-1",
      runId: "run-1",
      toolCallId: "tool-read-1",
      toolName: "read_resource",
      mode: "read",
      connectionId: null,
      requestHash: "hash",
      inputJson: JSON.stringify({ resourceId }),
      status: "failed",
      outputRef: null,
      outputSummary: null,
      providerOperationId: null,
      errorJson: JSON.stringify({ code: "resource_format_unsupported" }),
      executionPlanHash: "plan",
      executionPlanJson: JSON.stringify({ capability: "workstream.resources.read" }),
      startedAt: 1,
      settledAt: 2,
      checkpointIndex: 0,
      ...overrides,
    });

    await guard.restoreReceipts([receipt({})] as never);
    expect(guard.boundary()).toContain(resourceId);

    await guard.restoreReceipts([receipt({
      effectIntentId: "effect-2",
      toolCallId: "tool-read-2",
      status: "completed",
      startedAt: 3,
      settledAt: 4,
      errorJson: null,
    })] as never);
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
      toolName: "view_resource",
      pluginId: "rally_core",
      policy,
      input: { resourceIds: [includedId, skippedId] },
    } as never);
    guard.onCompleted({
      type: "tool_completed",
      toolCallId: "tool-view-mixed",
      toolName: "view_resource",
      pluginId: "rally_core",
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
      toolName: "read_resource",
      pluginId: "rally_core",
      policy,
      input: { cursor: "sealed-cursor" },
    } as never);
    guard.onFailed({
      type: "tool_failed",
      toolCallId: "tool-read-cursor",
      toolName: "read_resource",
      pluginId: "rally_core",
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
      toolName: "read_resource",
      pluginId: "rally_core",
      policy,
      input: { resourceId },
    } as never);
    guard.onCompleted({
      type: "tool_completed",
      toolCallId: "tool-read-retry",
      toolName: "read_resource",
      pluginId: "rally_core",
      policy,
      result: { output: { resourceId }, summary: "Read resource" },
    } as never);
    expect(guard.boundary()).toBeNull();
  });

  it.each(["nextPageId", "previousPageId", "passages", "citations"])("grounds %s IDs to their resource among multiple active resources", (field) => {
    const guard = new __integrationTesting.AttachmentGroundingGuard();
    const policy = { capability: field === "passages" ? "workstream.resources.search"
      : field === "citations" ? "workstream.resources.summarize" : "workstream.resources.read" };
    for (const resourceId of ["resource-a", "resource-b"]) {
      const pageId = `workstream_quiet_amber_rapid_${resourceId === "resource-a" ? "otter" : "fox"}`;
      guard.onStarted({ type: "tool_started", toolCallId: resourceId, toolName: "read_resource", pluginId: "rally:workstream", policy, input: { resourceId } } as never);
      guard.onCompleted({ type: "tool_completed", toolCallId: resourceId, toolName: "read_resource", pluginId: "rally:workstream", policy,
        result: { output: { resourceId, [field]: field === "passages" || field === "citations" ? [{ readPageId: pageId }] : pageId }, summary: "page" } } as never);
    }
    const readPolicy = { capability: "workstream.resources.read" };
    guard.onStarted({ type: "tool_started", toolCallId: "next", toolName: "read_resource_next", pluginId: "rally:workstream", policy: readPolicy,
      input: { pageId: "workstream_quiet_amber_rapid_otter" } } as never);
    guard.onFailed({ type: "tool_failed", toolCallId: "next", toolName: "read_resource_next", pluginId: "rally:workstream", policy: readPolicy,
      error: "Resource changed", data: { code: "resource_changed" }, phase: "execution", outcome: "definitive_failure" } as never);
    expect(guard.boundary()).toContain("resource-a");
    expect(guard.boundary()).not.toContain("resource-b");
  });

  it("recovers a uniquely active read after the model corrupts its opaque cursor", () => {
    const guard = new __integrationTesting.AttachmentGroundingGuard();
    const policy = { capability: "workstream.resources.read" };
    const resourceId = "00000000-0000-7000-8000-000000000774";
    guard.onStarted({
      type: "tool_started",
      toolCallId: "tool-read-first-page",
      toolName: "read_resource",
      pluginId: "rally_core",
      policy,
      input: { resourceId },
    } as never);
    guard.onCompleted({
      type: "tool_completed",
      toolCallId: "tool-read-first-page",
      toolName: "read_resource",
      pluginId: "rally_core",
      policy,
      result: {
        output: attachmentReadPage(resourceId, "issued-cursor"),
        summary: "Read first page",
      },
    } as never);

    guard.onStarted({
      type: "tool_started",
      toolCallId: "tool-read-corrupted-cursor",
      toolName: "read_resource",
      pluginId: "rally_core",
      policy,
      input: { cursor: "issued-curs0r" },
    } as never);
    guard.onFailed({
      type: "tool_failed",
      toolCallId: "tool-read-corrupted-cursor",
      toolName: "read_resource",
      pluginId: "rally_core",
      policy,
      error: "Attachment cursor is invalid",
      data: { code: "invalid_cursor" },
      phase: "execution",
      outcome: "definitive_failure",
    } as never);
    expect(guard.boundary()).toContain(resourceId);

    guard.onStarted({
      type: "tool_started",
      toolCallId: "tool-read-explicit-recovery",
      toolName: "read_resource",
      pluginId: "rally_core",
      policy,
      input: { resourceId, startCharacter: 12_000 },
    } as never);
    guard.onCompleted({
      type: "tool_completed",
      toolCallId: "tool-read-explicit-recovery",
      toolName: "read_resource",
      pluginId: "rally_core",
      policy,
      result: { output: attachmentReadPage(resourceId, null), summary: "Read recovery page" },
    } as never);

    expect(guard.boundary()).toBeNull();
  });

  it("recovers a corrupted backwards cursor issued by a completed read", () => {
    const guard = new __integrationTesting.AttachmentGroundingGuard();
    const policy = { capability: "workstream.resources.read" };
    const resourceId = "00000000-0000-7000-8000-000000000781";
    guard.onStarted({
      type: "tool_started",
      toolCallId: "tool-read-terminal-page",
      toolName: "read_resource",
      pluginId: "rally_core",
      policy,
      input: { resourceId, startCharacter: 12_000 },
    } as never);
    guard.onCompleted({
      type: "tool_completed",
      toolCallId: "tool-read-terminal-page",
      toolName: "read_resource",
      pluginId: "rally_core",
      policy,
      result: {
        output: attachmentReadPage(resourceId, null, "issued-previous-cursor", 12_000),
        summary: "Read terminal page",
      },
    } as never);

    guard.onStarted({
      type: "tool_started",
      toolCallId: "tool-read-corrupted-previous-cursor",
      toolName: "read_resource",
      pluginId: "rally_core",
      policy,
      input: { cursor: "issued-previous-curs0r" },
    } as never);
    guard.onFailed({
      type: "tool_failed",
      toolCallId: "tool-read-corrupted-previous-cursor",
      toolName: "read_resource",
      pluginId: "rally_core",
      policy,
      error: "Attachment cursor is invalid",
      data: { code: "invalid_cursor" },
      phase: "execution",
      outcome: "definitive_failure",
    } as never);
    expect(guard.boundary()).toContain(resourceId);

    guard.onStarted({
      type: "tool_started",
      toolCallId: "tool-read-backwards-recovery",
      toolName: "read_resource",
      pluginId: "rally_core",
      policy,
      input: { resourceId },
    } as never);
    guard.onCompleted({
      type: "tool_completed",
      toolCallId: "tool-read-backwards-recovery",
      toolName: "read_resource",
      pluginId: "rally_core",
      policy,
      result: { output: attachmentReadPage(resourceId, "next-page"), summary: "Restarted read" },
    } as never);
    expect(guard.boundary()).toBeNull();
  });

  it("counts search and summary read cursors before inferring one resource", () => {
    const readPolicy = { capability: "workstream.resources.read" };
    const resourceA = "00000000-0000-7000-8000-000000000782";
    const resourceB = "00000000-0000-7000-8000-000000000783";
    const issuerScenarios = [
      {
        capability: "workstream.resources.search",
        toolName: "search_resource",
        output: attachmentSearchResult(resourceB, "search-read-cursor"),
      },
      {
        capability: "workstream.resources.summarize",
        toolName: "summarize_resource",
        output: attachmentSummaryResult(resourceB, "summary-read-cursor"),
      },
    ];

    for (const [index, scenario] of issuerScenarios.entries()) {
      const guard = new __integrationTesting.AttachmentGroundingGuard();
      guard.onStarted({
        type: "tool_started",
        toolCallId: `tool-read-a-${index}`,
        toolName: "read_resource",
        pluginId: "rally_core",
        policy: readPolicy,
        input: { resourceId: resourceA },
      } as never);
      guard.onCompleted({
        type: "tool_completed",
        toolCallId: `tool-read-a-${index}`,
        toolName: "read_resource",
        pluginId: "rally_core",
        policy: readPolicy,
        result: { output: attachmentReadPage(resourceA, "read-a-cursor"), summary: "Read A" },
      } as never);
      guard.onStarted({
        type: "tool_started",
        toolCallId: `tool-issuer-b-${index}`,
        toolName: scenario.toolName,
        pluginId: "rally_core",
        policy: { capability: scenario.capability },
        input: { resourceId: resourceB },
      } as never);
      guard.onCompleted({
        type: "tool_completed",
        toolCallId: `tool-issuer-b-${index}`,
        toolName: scenario.toolName,
        pluginId: "rally_core",
        policy: { capability: scenario.capability },
        result: { output: scenario.output, summary: "Issued B cursor" },
      } as never);

      const failedToolCallId = `tool-read-corrupted-b-${index}`;
      guard.onStarted({
        type: "tool_started",
        toolCallId: failedToolCallId,
        toolName: "read_resource",
        pluginId: "rally_core",
        policy: readPolicy,
        input: { cursor: "corrupted-b-cursor" },
      } as never);
      guard.onFailed({
        type: "tool_failed",
        toolCallId: failedToolCallId,
        toolName: "read_resource",
        pluginId: "rally_core",
        policy: readPolicy,
        error: "Attachment cursor is invalid",
        data: { code: "invalid_cursor" },
        phase: "execution",
        outcome: "definitive_failure",
      } as never);
      expect(guard.boundary()).toContain(failedToolCallId);
      expect(guard.boundary()).not.toContain(resourceA);
      expect(guard.boundary()).not.toContain(resourceB);

      guard.onStarted({
        type: "tool_started",
        toolCallId: `tool-read-a-recovery-${index}`,
        toolName: "read_resource",
        pluginId: "rally_core",
        policy: readPolicy,
        input: { resourceId: resourceA, startCharacter: 12_000 },
      } as never);
      guard.onCompleted({
        type: "tool_completed",
        toolCallId: `tool-read-a-recovery-${index}`,
        toolName: "read_resource",
        pluginId: "rally_core",
        policy: readPolicy,
        result: {
          output: attachmentReadPage(resourceA, null, "read-a-previous", 12_000),
          summary: "Read A recovery",
        },
      } as never);
      expect(guard.boundary()).toContain(failedToolCallId);
    }
  });

  it("rebuilds cursor provenance from completed outputs before restoring failures", async () => {
    const guard = new __integrationTesting.AttachmentGroundingGuard();
    const resourceId = "00000000-0000-7000-8000-000000000784";
    const outputs = new Map<string, unknown>([
      ["output:first", attachmentReadPage(resourceId, "issued-cursor")],
      ["output:recovery", attachmentReadPage(resourceId, null, null, 12_000)],
    ]);
    const loadOutput = async (receipt: { outputRef: string | null }) => receipt.outputRef
      ? outputs.get(receipt.outputRef) ?? null
      : null;
    await guard.restoreReceipts([
      attachmentReceipt({
        effectIntentId: "effect-first-page",
        toolCallId: "tool-first-page",
        inputJson: JSON.stringify({ resourceId }),
        outputRef: "output:first",
        startedAt: 1,
        settledAt: 2,
      }),
      attachmentReceipt({
        effectIntentId: "effect-corrupted-cursor",
        toolCallId: "tool-corrupted-cursor",
        inputJson: JSON.stringify({ cursor: "issued-curs0r" }),
        status: "failed",
        outputRef: null,
        errorJson: JSON.stringify({
          code: "tool_failed",
          data: { code: "invalid_cursor" },
        }),
        startedAt: 3,
        settledAt: 4,
      }),
    ] as never, loadOutput as never);
    expect(guard.boundary()).toContain(resourceId);

    await guard.restoreReceipts([
      attachmentReceipt({
        effectIntentId: "effect-recovery",
        toolCallId: "tool-recovery",
        inputJson: JSON.stringify({ resourceId, startCharacter: 12_000 }),
        outputRef: "output:recovery",
        startedAt: 5,
        settledAt: 6,
      }),
    ] as never, loadOutput as never);
    expect(guard.boundary()).toBeNull();
  });

  it("does not let a restored executing call borrow later cursor provenance", async () => {
    const guard = new __integrationTesting.AttachmentGroundingGuard();
    const resourceId = "00000000-0000-7000-8000-000000000785";
    await guard.restoreReceipts([
      attachmentReceipt({
        effectIntentId: "effect-restored-running",
        toolCallId: "tool-restored-running",
        inputJson: JSON.stringify({ cursor: "unknown-cursor" }),
        status: "executing",
        outputRef: null,
        settledAt: null,
      }),
    ] as never);

    const policy = { capability: "workstream.resources.read" };
    guard.onStarted({
      type: "tool_started",
      toolCallId: "tool-new-read",
      toolName: "read_resource",
      pluginId: "rally_core",
      policy,
      input: { resourceId },
    } as never);
    guard.onCompleted({
      type: "tool_completed",
      toolCallId: "tool-new-read",
      toolName: "read_resource",
      pluginId: "rally_core",
      policy,
      result: { output: attachmentReadPage(resourceId, "new-cursor"), summary: "Read new page" },
    } as never);
    guard.onFailed({
      type: "tool_failed",
      toolCallId: "tool-restored-running",
      toolName: "read_resource",
      pluginId: "rally_core",
      policy,
      error: "Attachment cursor is invalid",
      data: { code: "invalid_cursor" },
      phase: "execution",
      outcome: "definitive_failure",
    } as never);

    expect(guard.boundary()).toContain("tool-restored-running");
    expect(guard.boundary()).not.toContain(resourceId);
  });

  it("keeps a corrupted cursor anonymous when more than one read continuation is active", () => {
    const guard = new __integrationTesting.AttachmentGroundingGuard();
    const policy = { capability: "workstream.resources.read" };
    const resourceIds = [
      "00000000-0000-7000-8000-000000000775",
      "00000000-0000-7000-8000-000000000776",
    ];
    resourceIds.forEach((resourceId, index) => {
      const toolCallId = `tool-read-page-${index}`;
      guard.onStarted({
        type: "tool_started",
        toolCallId,
        toolName: "read_resource",
        pluginId: "rally_core",
        policy,
        input: { resourceId },
      } as never);
      guard.onCompleted({
        type: "tool_completed",
        toolCallId,
        toolName: "read_resource",
        pluginId: "rally_core",
        policy,
        result: {
          output: attachmentReadPage(resourceId, `issued-cursor-${index}`),
          summary: "Read first page",
        },
      } as never);
    });

    guard.onStarted({
      type: "tool_started",
      toolCallId: "tool-read-ambiguous-corrupted-cursor",
      toolName: "read_resource",
      pluginId: "rally_core",
      policy,
      input: { cursor: "unknown-corrupted-cursor" },
    } as never);
    guard.onFailed({
      type: "tool_failed",
      toolCallId: "tool-read-ambiguous-corrupted-cursor",
      toolName: "read_resource",
      pluginId: "rally_core",
      policy,
      error: "Attachment cursor is invalid",
      data: { code: "invalid_cursor" },
      phase: "execution",
      outcome: "definitive_failure",
    } as never);

    const boundary = guard.boundary();
    expect(boundary).toContain("tool-read-ambiguous-corrupted-cursor");
    expect(boundary).not.toContain(resourceIds[0]);
    expect(boundary).not.toContain(resourceIds[1]);
  });

  it("returns preload candidates to Bind only after their activation is persisted", async () => {
    const order: string[] = [];
    const persisted = new Set<string>();
    const prepared = new Set<string>();
    let releaseChecks!: () => void;
    const checksGate = new Promise<void>((resolve) => { releaseChecks = resolve; });
    let checksStarted = 0;
    let signalPersistStarted!: () => void;
    let releasePersistence!: () => void;
    const persistStarted = new Promise<void>((resolve) => { signalPersistStarted = resolve; });
    const persistenceGate = new Promise<void>((resolve) => { releasePersistence = resolve; });

    const preparing = __integrationTesting.persistInitialPluginActivations(
      ["connection:preload", "connection:revoked", "connection:unavailable", "connection:preload"],
      async (pluginId) => {
        order.push(`reauthorize:${pluginId}`);
        checksStarted += 1;
        await checksGate;
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

    try {
      await vi.waitFor(() => expect(checksStarted).toBe(3));
      expect(persisted.size).toBe(0);
    } finally {
      releaseChecks();
    }
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
      "reauthorize:connection:revoked",
      "reauthorize:connection:unavailable",
      "prepare:connection:preload",
      "persist:start:connection:preload",
      "persist:finish:connection:preload",
      "prepare:connection:unavailable",
    ]);
  });

  it("omits a final message id for an empty elicitation needs-input run", () => {
    const messageId = "00000000-0000-4000-8000-000000000003";
    const result = __integrationTesting.workstreamHarnessTerminalResult({
      outcome: { status: "needs_input" },
      streamedText: "",
      finalTurnId: messageId,
      ambiguousToolOutcome: false,
      stoppedByUser: false,
    });

    expect(result).toEqual({ status: "needs_input" });
    expect("finalTurnId" in result).toBe(false);
    expect(__integrationTesting.workstreamHarnessTerminalResult({
      outcome: { status: "needs_input" },
      streamedText: "I need one detail before continuing.",
      finalTurnId: messageId,
      ambiguousToolOutcome: false,
      stoppedByUser: false,
    })).toEqual({ status: "needs_input", finalTurnId: messageId });
  });

  it("reads a run a tool ended as completed even when the model wrote nothing after it", () => {
    // This tests only the adapter's generic tool-ended outcome. Conversation
    // terminalization still requires a final turn; Sidekick authoring now
    // returns to the model for a reply, as the workerd regression proves.
    expect(__integrationTesting.workstreamHarnessTerminalResult({
      outcome: { status: "completed", completedByTool: true },
      streamedText: "",
      finalTurnId: null,
      ambiguousToolOutcome: false,
      stoppedByUser: false,
    })).toEqual({ status: "completed" });
    expect(__integrationTesting.workstreamHarnessTerminalResult({
      outcome: { status: "completed" },
      streamedText: "",
      finalTurnId: null,
      ambiguousToolOutcome: false,
      stoppedByUser: false,
    })).toMatchObject({ status: "failed", error: { code: "empty_completion" } });
  });

  it("says why an ambiguous halt stopped the run, which nothing else may record", () => {
    const messageId = "00000000-0000-4000-8000-000000000003";
    // An elicitation leaves a question in the transcript to answer. An
    // ambiguity that collided with an already-settled receipt leaves the row
    // untouched, so the run is the only thing left that can explain itself.
    expect(__integrationTesting.workstreamHarnessTerminalResult({
      outcome: { status: "completed" },
      streamedText: "I will locate the repository.",
      finalTurnId: messageId,
      ambiguousToolOutcome: true,
      stoppedByUser: false,
    })).toEqual({
      status: "needs_input",
      finalTurnId: messageId,
      error: {
        code: "ambiguous_external_write",
        message: "An external action's outcome could not be confirmed, so Rally stopped instead of repeating it",
      },
    });
  });
});
