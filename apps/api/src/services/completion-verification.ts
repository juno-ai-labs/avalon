import {
  COMPLETION_VERIFICATION_SOURCE, completionConversationContext, completionVerificationPrompt,
  type judgeCompletionStop, type ModelMessage, type CompletionState,
} from "@rally/agent-harness";
import type { CompletionVerificationSnapshot } from "../durable-objects/completion-verification-storage";

/** Re-read lifecycle after network I/O. Persistence of the returned derived
 * message consumes recovery atomically with its delivery to the model. */
export async function completionVerificationNudge(input: {
  runId: string;
  assistantContent: string;
  messages: readonly ModelMessage[];
  snapshot: () => CompletionVerificationSnapshot;
  pendingDelegation: () => Promise<boolean>;
  judge: (state: CompletionState) => ReturnType<typeof judgeCompletionStop>;
  signal: AbortSignal;
}) {
  input.signal.throwIfAborted();
  const snapshot = input.snapshot();
  if (snapshot.lifecycle !== "ready") return null;
  if (snapshot.handedOff && await input.pendingDelegation()) return null;
  input.signal.throwIfAborted();
  const context = completionConversationContext(input.messages);
  if (context.at(-1)?.role === "assistant" && context.at(-1)?.text === input.assistantContent) context.pop();
  const state: CompletionState = {
    triggering_request: snapshot.trigger ?? { id: input.runId, text: "", origin: "unresolved_activation" },
    linked_context: context, candidate_final: input.assistantContent, tool_receipts: snapshot.receipts,
    context_status: snapshot.trigger?.text ? "resolved" : "unresolved",
    evidence_coverage: "Exact trigger and candidate final; all conversation text retained in the acting model's current projection, including compaction checkpoints and in-run input. Current-execution receipt statuses and summaries; no full tool payloads or post-decision outcomes. Older compacted details may be unavailable.",
  };
  const decision = await input.judge(state);
  input.signal.throwIfAborted();
  if (!decision.reprompt || input.snapshot().lifecycle !== "ready") return null;
  return { message: completionVerificationPrompt,
    provenance: { originKind: "derived" as const, sourceKind: COMPLETION_VERIFICATION_SOURCE,
      sourceId: input.runId, sourceRevision: null } };
}
