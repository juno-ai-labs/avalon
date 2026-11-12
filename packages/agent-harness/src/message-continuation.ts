import { MESSAGE_CONTINUATION_FALLBACK_MODEL } from "@rally/contracts/runtime-config";
import { z } from "zod";
import { askJev, jevChoiceAnswerSchema, runConfidenceCascade, JEV_LATEST_MODEL } from "./jev";
import { messageContinuationState, renderMessageContinuationMessages, type MessageContinuationInput } from "./prompts/message-continuation";
import type { StructuredModelDiagnostic, OpenRouterTraceContext } from "./index";
// Re-exported by index; these runtime values are read only when a call runs.
import { classifyAddressing, OpenRouterClient, ADDRESSING_FALLBACK_TIMEOUT_MS } from "./index";
import { questions } from "./prompts/message-continuation-question";

// This second message-admission check uses the existing JEV admission budget:
// one second, about three times the measured 346 ms p95, and strict > 0.5.
export const MESSAGE_CONTINUATION_TIMEOUT_MS = 1_000;
export const MESSAGE_CONTINUATION_CONFIDENCE_THRESHOLD = 0.5;
export { MESSAGE_CONTINUATION_FALLBACK_MODEL };
export const MESSAGE_CONTINUATION_FALLBACK_PROVIDER = "openai";

export const CHOICES = ["resume_requested_work", "followup_without_rally_action", "use_addressing"] as const;
export const ASSIGNMENT_CHOICES = ["assigned_to_rally", "not_assigned_to_rally"] as const;
export const CONTRIBUTOR_CHOICES = ["contributors_present", "contributors_missing"] as const;
const Answers = z.object({
  continuation: jevChoiceAnswerSchema(CHOICES),
  assignment: jevChoiceAnswerSchema(ASSIGNMENT_CHOICES),
  contributors: jevChoiceAnswerSchema(CONTRIBUTOR_CHOICES),
});
interface ClassifierInput extends MessageContinuationInput {
  typesafeApiKey: string;
  signal?: AbortSignal;
  fetch?: typeof globalThis.fetch;
  onDiagnostic?: (event: StructuredModelDiagnostic) => void | Promise<void>;
  traceContext?: OpenRouterTraceContext;
}

export async function classifyMessageContinuationWithTypeSafe(input: ClassifierInput) {
  const result = await askJev({
    apiKey: input.typesafeApiKey,
    model: JEV_LATEST_MODEL,
    schemaName: "message_continuation",
    timeoutMs: MESSAGE_CONTINUATION_TIMEOUT_MS,
    state: messageContinuationState(input),
    questions,
    answers: Answers,
    signal: input.signal,
    fetch: input.fetch,
    onDiagnostic: input.onDiagnostic,
    traceContext: input.traceContext,
  });
  const answer = result.answers.continuation;
  const assignment = result.answers.assignment;
  const contributors = result.answers.contributors;
  const requiresReview = answer.choice === "resume_requested_work"
    && (assignment.choice !== "assigned_to_rally"
      || assignment.confidence <= MESSAGE_CONTINUATION_CONFIDENCE_THRESHOLD
      || contributors.choice !== "contributors_present"
      || contributors.confidence <= MESSAGE_CONTINUATION_CONFIDENCE_THRESHOLD);
  return { ...answer, ...(requiresReview ? { requiresReview: true as const } : {}) };
}

const Decision = z.object({ decision: z.enum(CHOICES), confidence: z.number().min(0).max(1) });

export async function classifyMessageContinuation(input: ClassifierInput & { apiKey: string }) {
  const result = await runConfidenceCascade({
    primary: async () => {
      const answer = await classifyMessageContinuationWithTypeSafe(input);
      return { decision: answer.choice, confidence: answer.confidence, ...(answer.requiresReview ? { requiresReview: true as const } : {}) };
    },
    accept: (answer) => answer.confidence > MESSAGE_CONTINUATION_CONFIDENCE_THRESHOLD && !answer.requiresReview,
    fallback: {
      timeoutMs: ADDRESSING_FALLBACK_TIMEOUT_MS,
      run: (signal) => {
        const client = new OpenRouterClient({
          apiKey: input.apiKey,
          primaryModel: MESSAGE_CONTINUATION_FALLBACK_MODEL,
          fallbackModels: [],
          ...(input.fetch ? { fetch: input.fetch } : {}),
          ...(input.traceContext ? { traceContext: input.traceContext } : {}),
        });
        return client.structured({
          messages: renderMessageContinuationMessages(input),
          schemaName: "message_continuation",
          jsonSchema: {
            type: "object",
            additionalProperties: false,
            properties: { decision: { type: "string", enum: [...CHOICES] }, confidence: { type: "number", minimum: 0, maximum: 1 } },
            required: ["decision", "confidence"],
          },
          parse: (value) => Decision.parse(value),
          provider: { only: [MESSAGE_CONTINUATION_FALLBACK_PROVIDER], allowFallbacks: false, requireParameters: true },
          reasoningEffort: "low",
          signal,
          ...(input.onDiagnostic ? { onDiagnostic: input.onDiagnostic } : {}),
        });
      },
    },
    // Unavailable continuation providers preserve the existing addressing result.
    floor: () => ({ decision: "use_addressing" as const, confidence: 0 }),
    signal: input.signal,
  });
  const answer = result.answer.confidence > MESSAGE_CONTINUATION_CONFIDENCE_THRESHOLD
    ? result.answer : { decision: "use_addressing" as const, confidence: result.answer.confidence };
  return { ...answer, stage: result.stage };
}

/** Follow-ups are their own decision; ordinary addressing handles everything else. */
export async function classifyMessageAdmission(
  input: Parameters<typeof classifyAddressing>[0] & { authorName?: string | null },
) {
  const addressingAbort = new AbortController();
  const signal = input.signal ? AbortSignal.any([input.signal, addressingAbort.signal]) : addressingAbort.signal;
  // Observe rejection immediately, even when continuation settles admission first.
  const addressing = classifyAddressing({ ...input, signal }).then(
    (answer) => ({ answer }),
    (error: unknown) => ({ error }),
  );
  try {
    const continuation = input.typesafeApiKey && input.recentMessages?.length
      ? await classifyMessageContinuation({
        ...input,
        typesafeApiKey: input.typesafeApiKey,
        recentMessages: input.recentMessages,
      })
      : undefined;
    if (continuation?.decision === "resume_requested_work") {
      return {
        classification: { classification: "agent_action" as const, confidence: continuation.confidence, rationaleCode: "deferred_request" as const },
        continuation,
      };
    }
    // Continuation has no authority over connector addressing or a running task.
    // Preserve ordinary addressing's richer signals on those paths.
    if (continuation?.decision === "followup_without_rally_action"
      && (input.activeTask || input.connectorMentions?.length)) {
      continuation.decision = "use_addressing";
    }
    if (continuation?.decision === "followup_without_rally_action") {
      return {
        classification: { classification: "human_only" as const, confidence: continuation.confidence, rationaleCode: "human_coordination" as const },
        continuation,
      };
    }
    const result = await addressing;
    if ("error" in result) throw result.error;
    return { classification: result.answer, continuation };
  } finally {
    addressingAbort.abort();
  }
}
