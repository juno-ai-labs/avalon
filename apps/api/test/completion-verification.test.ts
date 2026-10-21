import { expect, it, vi } from "vitest";
import { completionVerificationNudge } from "../src/services/completion-verification";
import type { CompletionVerificationSnapshot } from "../src/durable-objects/completion-verification-storage";

const ready: CompletionVerificationSnapshot = {
  lifecycle: "ready", receipts: [],
  trigger: { id: "request", text: "Build the article", origin: "human" },
};
function setup(snapshot: CompletionVerificationSnapshot = ready) {
  const judge = vi.fn(async () => ({ reprompt: true, answer: null, model: null, failureKind: "timeout" }));
  return { runId: "execution-1", assistantContent: "I'm writing it now.", messages: [],
    snapshot: vi.fn(() => snapshot), pendingDelegation: vi.fn(async () => false), judge,
    signal: new AbortController().signal };
}

it.each(["cancelled", "input_required", "background_pending", "ambiguous_write", "recovery_used", "unknown"] as const)("does not judge or recover lifecycle %s", async (lifecycle) => {
  const input = setup({ ...ready, lifecycle });
  expect(await completionVerificationNudge(input)).toBeNull();
  expect(input.judge).not.toHaveBeenCalled();
});

it("returns a durable execution-scoped nudge for judge failure", async () => {
  const input = setup();
  expect(await completionVerificationNudge(input)).toMatchObject({
    message: expect.stringContaining("Check existing artifacts and tool receipts"),
    provenance: { originKind: "derived", sourceKind: "completion_verification", sourceId: "execution-1", sourceRevision: null },
  });
  expect(input.judge).toHaveBeenCalledTimes(1);
  expect(input.pendingDelegation).toHaveBeenCalledTimes(1);
});

it("defers to delegated work from an earlier execution without a current handoff receipt", async () => {
  const input = setup();
  input.pendingDelegation.mockResolvedValue(true);
  expect(await completionVerificationNudge(input)).toBeNull();
  expect(input.judge).not.toHaveBeenCalled();
});

it("rechecks lifecycle after the classifier responds", async () => {
  const input = setup();
  input.snapshot.mockReturnValueOnce(ready).mockReturnValue({ ...ready, lifecycle: "input_required" });
  expect(await completionVerificationNudge(input)).toBeNull();
  expect(input.judge).toHaveBeenCalledTimes(1);
});

it("does not replace cancellation during the judge with recovery", async () => {
  const controller = new AbortController();
  const input = setup();
  input.judge.mockImplementation(async () => {
    controller.abort(new Error("cancelled"));
    return { reprompt: true, answer: null, model: null, failureKind: "timeout" };
  });
  await expect(completionVerificationNudge({ ...input, signal: controller.signal })).rejects.toThrow("cancelled");
});
