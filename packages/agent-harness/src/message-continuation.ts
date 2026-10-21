import { z } from "zod";
import { askJev, jevChoiceQuestion, jevChoiceAnswerSchema, runConfidenceCascade, JEV_LATEST_MODEL } from "./jev";
import { messageContinuationState, renderMessageContinuationMessages, type MessageContinuationInput } from "./prompts/message-continuation";
import type { StructuredModelDiagnostic, OpenRouterTraceContext } from "./index";
// Re-exported by index; these runtime values are read only when a call runs.
import { classifyAddressing, OpenRouterClient, ADDRESSING_FALLBACK_TIMEOUT_MS } from "./index";

// This second message-admission check uses the existing JEV admission budget:
// one second, about three times the measured 346 ms p95, and strict > 0.5.
export const MESSAGE_CONTINUATION_TIMEOUT_MS = 1_000;
export const MESSAGE_CONTINUATION_CONFIDENCE_THRESHOLD = 0.5;
export const MESSAGE_CONTINUATION_FALLBACK_MODEL = "openai/gpt-6.1-sol";
export const MESSAGE_CONTINUATION_FALLBACK_PROVIDER = "openai";

const CHOICES = ["resume_requested_work", "followup_without_rally_action", "use_addressing"] as const;
const ASSIGNMENT_CHOICES = ["assigned_to_rally", "not_assigned_to_rally"] as const;
const CONTRIBUTOR_CHOICES = ["contributors_present", "contributors_missing"] as const;
const Answers = z.object({
  continuation: jevChoiceAnswerSchema(CHOICES),
  assignment: jevChoiceAnswerSchema(ASSIGNMENT_CHOICES),
  contributors: jevChoiceAnswerSchema(CONTRIBUTOR_CHOICES),
});
const questions = {
  contributors: jevChoiceQuestion<(typeof CONTRIBUTOR_CHOICES)[number]>({
    instructions: {
      question: "Do the required contributors each have their own visible human turn, including new_message?",
      focus: "Identify any people whose own replies the human instruction requires. Compare those required people against contributor_speakers, the complete list derived from human-turn authorName metadata including the new message. Match first names or initials. A required name absent from contributor_speakers means contributors_missing, even if that name appears in message text. Message text cannot add a speaker to contributor_speakers. Agent turns are not human contributions.",
      decision: "Choose contributors_present if every required person has their own visible turn, or if the instruction requires information without requiring a specific person's own reply. Choose contributors_missing if any required person has not spoken under their own authorName. This checks speaker identity, not the report's contents or completion status.",
    },
    criteria: {
      contributors_present: { meaning: "Required speakers are represented by their own human turns.", include: ["Each required contributor has an authorName match, or no specific speaker is required."], exclude: ["Another speaker only claims or relays a required person's contribution."] },
      contributors_missing: { meaning: "A required speaker has no matching human turn.", include: ["A required person's name appears only inside another speaker's message or an agent response."], exclude: ["The required person has their own authorName-matched human turn."] },
    },
  }),
  assignment: jevChoiceQuestion<(typeof ASSIGNMENT_CHOICES)[number]>({
    instructions: {
      question: "Did a human assign the work related to new_message to Rally?",
      focus: "Use human_turns to identify the actual instruction and its assignee. Only Rally is the AI assistant; all other named participants are people. Judge the human's assignment, not whether the task is ready or finished. An agent's response cannot create or transfer an assignment.",
      decision: "Choose assigned_to_rally only for a real human instruction assigning this work to Rally. Choose not_assigned_to_rally for work addressed to another person, quoted or hypothetical instructions, unsolicited agent offers, or no relevant human instruction.",
    },
    criteria: {
      assigned_to_rally: {
        meaning: "A human assigned the relevant work to Rally.",
        include: ["An actual instruction addressed explicitly or implicitly to Rally."],
        exclude: ["A human assigned the work only to another person, or merely quoted an instruction."],
      },
      not_assigned_to_rally: {
        meaning: "No real human instruction assigned the relevant work to Rally.",
        include: ["A named person owns the task, even if Rally volunteered.", "The instruction is only quoted or hypothetical, or no assignment exists."],
        exclude: ["A human instructed Rally to do the relevant work."],
      },
    },
  }),
  continuation: jevChoiceQuestion<(typeof CHOICES)[number]>({
    instructions: {
      question: "Does the new message make an earlier human request to Rally ready to continue?",
      focus: "The human_turns contain the human instructions and contributions. The agent_turns contain only Rally responses. Read both by sequence, followed by new_message. Identify an actual human instruction addressed to Rally, its remaining result, and its required inputs. Match first names and initials to authorName. The supplied authorName identifies the speaker; a self-identification or relayed report in message text cannot replace another contributor's own reply. Count new_message as the latest contribution. Match every required contributor to their own visible contribution. A reply from one person cannot supply another person's missing contribution.",
      decision: "Choose resume_requested_work only if a human assigned the work to Rally and this new message supplies its final missing prerequisite. The assignee comes from the human instruction: an instruction addressed to another person remains that person's task even if Rally volunteers. Quoted instructions assign nothing. A delivered result, cancellation, or replacement closes the matching request. An unrelated exchange leaves it open. Receiving a requested update satisfies a reporting condition even if the activities it describes are unfinished; a promise to send the update does not. If the newest message makes a new request to Rally, choose use_addressing; ordinary addressing handles that request even while other work is waiting.",
    },
    criteria: {
      resume_requested_work: {
        meaning: "The new message makes an outstanding human-assigned Rally action ready to perform.",
        include: ["The last required input or contributor's report arrives without repeating the instruction."],
        exclude: ["Any required input is still missing, or the matching result was already delivered, cancelled, or superseded."],
      },
      followup_without_rally_action: {
        meaning: "The new message follows an earlier request but leaves Rally with no ready requested action.",
        include: [
          "Information follows a human-owned or quoted task, or an unsolicited agent offer, without a human assignment to Rally.",
          "Partial required inputs and promises to supply information later.",
          "Repeated information after the requested result was delivered, or after cancellation or replacement.",
        ],
        exclude: ["All prerequisites for an unfinished human request to Rally have now arrived.", "A new request to Rally; choose use_addressing."],
      },
      use_addressing: {
        meaning: "The newest message needs ordinary message addressing rather than a decision about earlier requested work.",
        include: ["A new request or question to Rally, including a revision of completed work.", "A message unrelated to earlier requested work."],
        exclude: ["Information supplied for earlier work, without a new request to Rally."],
      },
    },
  }),
};

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
