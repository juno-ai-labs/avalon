import type { ModelMessage, OpenRouterTraceContext, StructuredModelDiagnostic } from "./index";
import { askJev, jevFailureKind } from "./jev";
import { answers, questions, type CompletionAnswer, type CompletionState } from "./completion-verification-question";

export type { CompletionState } from "./completion-verification-question";
export const COMPLETION_VERIFICATION_SOURCE = "completion_verification";
// User-selected policy, measured in evals/premature-stop. This is confidence
// required to accept a stop, not confidence required to continue.
export const COMPLETION_STOP_CONFIDENCE = 0.70;
export const completionVerificationPrompt = "Review the latest user request and relevant earlier instructions against what you have actually delivered. If requested work remains and you can complete it with available tools, continue now and deliver it. Do not treat a plan or progress update as completion. Check existing artifacts and tool receipts before repeating any action. If already complete, briefly identify the delivered result. If blocked or waiting on existing work, state the specific dependency without starting duplicate work.";

export function needsCompletionVerification(state: Pick<CompletionState, "context_status">, answer: CompletionAnswer | null, threshold = COMPLETION_STOP_CONFIDENCE): boolean {
  return state.context_status === "unresolved" || answer === null
    || answer.confidence <= threshold || answer.choice === "unclear"
    || answer.choice === "announces_unfinished_work";
}

/** Retain all surviving conversation text, including compaction checkpoints
 * and nonadjacent requests. Do not send system instructions or tool payloads;
 * the host supplies current-execution receipts separately. */
export function completionConversationContext(messages: readonly ModelMessage[]): CompletionState["linked_context"] {
  return messages.flatMap((message, index) => {
    if (message.role !== "user" && message.role !== "assistant") return [];
    const text = typeof message.content === "string" ? message.content
      : (message.content ?? []).flatMap((part) => part.type === "text" ? [part.text] : []).join("\n");
    return text ? [{ id: `context:${index}`, role: message.role, text,
      relation: "Ordered conversation context available to the acting model; may include a compaction checkpoint or an in-run correction." }] : [];
  });
}

export async function judgeCompletionStop(input: {
  apiKey?: string | undefined;
  state: CompletionState;
  signal?: AbortSignal | undefined;
  fetch?: typeof globalThis.fetch | undefined;
  onDiagnostic?: ((event: StructuredModelDiagnostic) => void | Promise<void>) | undefined;
  traceContext?: OpenRouterTraceContext | undefined;
}) {
  input.signal?.throwIfAborted();
  if (!input.apiKey) return { reprompt: true, answer: null, model: null, failureKind: "credential_missing" };
  try {
    const result = await askJev({
      apiKey: input.apiKey, model: "jev-1.14.0", timeoutMs: 1000,
      schemaName: "premature_stop_evaluation", state: input.state, questions, answers,
      signal: input.signal, fetch: input.fetch, onDiagnostic: input.onDiagnostic, traceContext: input.traceContext,
    });
    input.signal?.throwIfAborted();
    return { reprompt: needsCompletionVerification(input.state, result.answers.stopping),
      answer: result.answers.stopping, model: result.model, failureKind: null };
  } catch (error) {
    if (input.signal?.aborted) throw error;
    return { reprompt: true, answer: null, model: null, failureKind: jevFailureKind(error) };
  }
}
