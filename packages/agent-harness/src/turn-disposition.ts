import { z } from "zod";
import type { StructuredModelDiagnostic, OpenRouterTraceContext } from "./index";
import {
  askJev,
  jevChoiceAnswerSchema,
  jevChoiceQuestion,
  jevFailureKind,
  JEV_LATEST_MODEL,
} from "./jev";

/**
 * What a message in a conversation calls for next, read as the parent
 * conversation's owner would read it: carry it up to the parent, break a side
 * question out, or nothing.
 *
 * The third JEV caller, written to the shape of `semantic-trigger-gate.ts`:
 * the state, the question, the criteria and the mapping live here, the
 * transport in `./jev`. Nothing here knows where a decision is stored or shown;
 * `docs/PRDs/2026-10-17_merge-and-breakout-suggestions/design.md` owns the
 * contract and the evidence behind each line of the criteria and each field of
 * the state.
 */
export const TURN_DISPOSITION_CHOICES = [
  "worth_carrying_up",
  "side_question_worth_a_breakout",
  "continue_here",
] as const;
export type TurnDisposition = (typeof TURN_DISPOSITION_CHOICES)[number];

/** The kind of thing a carried message would be, asked for the chip's wording alone. */
export const CARRIED_ITEM_KINDS = ["deliverable", "decision", "answer", "update", "question"] as const;
export type CarriedItemKind = (typeof CARRIED_ITEM_KINDS)[number];

/**
 * The state is what a person who owns the parent conversation would want in
 * front of them before deciding, and nothing a person would not read:
 *
 * - `parent`: what the parent is about, because "new for the parent's readers"
 *   cannot be judged without knowing what they are doing.
 * - `conversation`: the charter. The opening request is the anchor; the
 *   purpose is the paraphrase that tracks how the work drifted.
 * - `so_far`: where the work stands. The compaction summary, when one exists,
 *   is exactly the handoff a person catching up would read. The earlier
 *   outputs are what let a reader tell the first deliverable from the fifth
 *   revision of it, and the carried-up count what they have already received.
 * - `recent_messages`: the last exchange, to tell whether the loop is still
 *   turning and whether a side question is new.
 * - `judged_message`: the message itself, who wrote it, its Breakout origin
 *   when merged here, and whether each output is appearing for the first time.
 */
export const TurnDispositionStateSchema = z.object({
  parent: z.object({
    kind: z.enum(["channel", "thread"]),
    title: z.string(),
    purpose: z.string().optional(),
  }),
  conversation: z.object({
    kind: z.enum(["thread", "breakout"]),
    title: z.string(),
    purpose: z.string(),
    opening_request: z.string().optional(),
    messages_before: z.number().int().nonnegative(),
  }),
  so_far: z.object({
    summary: z.string().optional(),
    earlier_outputs: z.array(z.object({
      title: z.string(),
      messages_ago: z.number().int().positive(),
    })),
    carried_up_before: z.number().int().nonnegative(),
  }),
  recent_messages: z.array(z.object({
    author: z.enum(["person", "rally"]),
    text: z.string(),
  })),
  judged_message: z.object({
    author: z.enum(["person", "rally"]),
    merged_from: z.object({ kind: z.literal("breakout"), title: z.string() }).optional(),
    text: z.string(),
    outputs: z.array(z.object({
      title: z.string(),
      first_time_here: z.boolean(),
    })),
  }),
});
export type TurnDispositionState = z.infer<typeof TurnDispositionStateSchema>;

/**
 * The bounds the state is sent under. Three recent messages rather than
 * addressing's ten: the summary and the output history carry what the older
 * messages carried, and the 2026-10-18 context ablation found three to score
 * the same as six on the holdout at a fifth fewer bytes, while putting the
 * judged message before the context cost three points of carry-up F1 and
 * dropping the parent cost precision; the judged message is kept whole up to a budget
 * that held every production turn the first corpus contained, with its
 * opening and its conclusion kept around a middle ellipsis past that. The
 * summary bound holds a full six-section compaction handoff.
 */
export const TURN_DISPOSITION_MAX_RECENT_MESSAGES = 3;
export const TURN_DISPOSITION_MAX_RECENT_MESSAGE_CODE_POINTS = 700;
export const TURN_DISPOSITION_MAX_TURN_CODE_POINTS = 6_000;
export const TURN_DISPOSITION_MAX_TITLE_CODE_POINTS = 200;
export const TURN_DISPOSITION_MAX_PURPOSE_CODE_POINTS = 1_000;
export const TURN_DISPOSITION_MAX_OPENING_REQUEST_CODE_POINTS = 1_200;
export const TURN_DISPOSITION_MAX_SUMMARY_CODE_POINTS = 2_500;
export const TURN_DISPOSITION_MAX_EARLIER_OUTPUTS = 8;
export const TURN_DISPOSITION_MAX_OUTPUTS = 10;
export const TURN_DISPOSITION_MAX_OUTPUT_TITLE_CODE_POINTS = 120;

function centerTruncate(value: string, limit: number): string {
  const characters = Array.from(value);
  if (characters.length <= limit) return value;
  const retained = limit - 1;
  const prefix = Math.ceil(retained / 2);
  const suffix = retained - prefix;
  return `${characters.slice(0, prefix).join("")}…${characters.slice(characters.length - suffix).join("")}`;
}

function headTruncate(value: string, limit: number): string {
  const characters = Array.from(value);
  return characters.length <= limit ? value : `${characters.slice(0, limit - 1).join("")}…`;
}

/** The exact state a request carries: the caller's state under the bounds above. */
export function boundTurnDispositionState(state: TurnDispositionState): TurnDispositionState {
  return {
    parent: {
      kind: state.parent.kind,
      title: headTruncate(state.parent.title, TURN_DISPOSITION_MAX_TITLE_CODE_POINTS),
      ...(state.parent.purpose !== undefined
        ? { purpose: headTruncate(state.parent.purpose, TURN_DISPOSITION_MAX_PURPOSE_CODE_POINTS) }
        : {}),
    },
    conversation: {
      kind: state.conversation.kind,
      title: headTruncate(state.conversation.title, TURN_DISPOSITION_MAX_TITLE_CODE_POINTS),
      purpose: headTruncate(state.conversation.purpose, TURN_DISPOSITION_MAX_PURPOSE_CODE_POINTS),
      ...(state.conversation.opening_request !== undefined
        ? { opening_request: centerTruncate(state.conversation.opening_request, TURN_DISPOSITION_MAX_OPENING_REQUEST_CODE_POINTS) }
        : {}),
      messages_before: state.conversation.messages_before,
    },
    so_far: {
      ...(state.so_far.summary !== undefined
        ? { summary: headTruncate(state.so_far.summary, TURN_DISPOSITION_MAX_SUMMARY_CODE_POINTS) }
        : {}),
      earlier_outputs: state.so_far.earlier_outputs
        .slice(-TURN_DISPOSITION_MAX_EARLIER_OUTPUTS)
        .map((output) => ({
          title: headTruncate(output.title, TURN_DISPOSITION_MAX_OUTPUT_TITLE_CODE_POINTS),
          messages_ago: output.messages_ago,
        })),
      carried_up_before: state.so_far.carried_up_before,
    },
    recent_messages: state.recent_messages
      .slice(-TURN_DISPOSITION_MAX_RECENT_MESSAGES)
      .map((message) => ({
        author: message.author,
        text: centerTruncate(message.text, TURN_DISPOSITION_MAX_RECENT_MESSAGE_CODE_POINTS),
      })),
    judged_message: {
      author: state.judged_message.author,
      ...(state.judged_message.merged_from ? { merged_from: {
        kind: state.judged_message.merged_from.kind,
        title: headTruncate(state.judged_message.merged_from.title, TURN_DISPOSITION_MAX_TITLE_CODE_POINTS),
      } } : {}),
      text: centerTruncate(state.judged_message.text, TURN_DISPOSITION_MAX_TURN_CODE_POINTS),
      outputs: state.judged_message.outputs
        .slice(0, TURN_DISPOSITION_MAX_OUTPUTS)
        .map((output) => ({
          title: headTruncate(output.title, TURN_DISPOSITION_MAX_OUTPUT_TITLE_CODE_POINTS),
          first_time_here: output.first_time_here,
        })),
    },
  };
}

/**
 * The questions, as data, so an evaluation can hold the exact request beside
 * the answer it produced. The exclusions under `worth_carrying_up` are the
 * ones the first production corpus earned: the messages the first criteria
 * over-flagged were revisions of a deliverable already made here, general
 * knowledge, and summaries of what the parent already had. The live probe's
 * opposite line ("a deliverable revised as asked, now done") was dropped for
 * that reason.
 */
export const turnDispositionQuestions = {
  disposition: jevChoiceQuestion<TurnDisposition>({
    instructions: {
      question: "Read as the owner of `parent`: what does `judged_message` call for?",
      focus: "`parent` is the conversation that would receive a merge and who reads it. `conversation.opening_request` and `conversation.purpose` are what this conversation exists to do. `so_far.summary`, when present, is where the work stood before the recent messages; `so_far.earlier_outputs` are the things already produced here, and `so_far.carried_up_before` how many times something was already carried to the parent. Use `recent_messages` only to tell whether the purpose is still in motion and whether a side question is new. `judged_message.outputs[].first_time_here` says whether an output is new or a revision. Optional `judged_message.merged_from` identifies a result carried here from a Breakout; origin alone does not mean the parent needs it.",
      decision: "Choose exactly one.",
    },
    criteria: {
      worth_carrying_up: {
        meaning: "The message holds something new for the parent's readers, in words they could use without this transcript: a deliverable, a finding, a decision, an answer to what they asked, a recommendation, a milestone, or a question only they can settle.",
        include: [
          "The first complete deliverable or draft for the purpose",
          "A finding, diagnosis or assessment the people here asked for",
          "A decision or recommendation the people here reached",
          "The answer to the purpose",
          "A correction that changes a result already carried",
          "A question this conversation cannot settle and the parent can",
          "A milestone the parent is waiting on, or a notice that a purpose the parent cares about is complete",
          "A person's message that states a decision or result the parent's readers need",
        ],
        exclude: [
          "A revision, addition, restyle, fix or expansion of a deliverable this conversation already produced",
          "A variation offered for taste, or a draft the message itself calls preliminary",
          "General knowledge, or an opinion the parent's work does not need",
          "A summary or explanation of material the parent already has",
          "The answer to a narrow follow-up question, inside or beside the purpose",
          "Routine progress, a blocked attempt, an acknowledgement, or a report to a coordinating agent",
          "A question to the people here about the purpose, or a person's request to Rally",
        ],
      },
      side_question_worth_a_breakout: {
        meaning: "The message, or the exchange that led to it, opened a distinct piece of work beside the purpose: large enough to need its own conversation, likely to crowd this one.",
        include: [
          "A sub-problem the message proposes to work separately",
          "A second deliverable the people asked for that the purpose does not cover",
          "A person's request or proposal that starts a different piece of work from the purpose, whoever it is addressed to",
          "A line of questions on another subject that has run for several messages",
        ],
        exclude: [
          "A clarification or follow-up about the purpose itself",
          "A one-line aside, or a general-knowledge question answered in one message",
          "The next step of the purpose",
        ],
      },
      continue_here: {
        meaning: "The message is a step of the work here, and nothing in it is new for the parent's readers.",
        include: [
          "Partial work, a question to a person here about the purpose, a status update, a person's request to Rally about the purpose",
          "A revision, addition, restyle or fix of a deliverable already produced here",
          "A variation offered for taste",
          "A narrow follow-up answer, general knowledge, or a summary of material the parent already has",
          "A result that answers a small part of the purpose",
        ],
        exclude: [
          "Something new that the parent's readers need now",
          "A distinct piece of work beside the purpose",
        ],
      },
    },
  }),
  carried_item_kind: jevChoiceQuestion<CarriedItemKind>({
    instructions: {
      question: "If `judged_message` were carried to the parent conversation, what kind of thing would it be?",
      focus: "Name the kind of the message's main content. Judge the message alone.",
      decision: "Choose exactly one.",
    },
    criteria: {
      deliverable: {
        meaning: "A finished piece of work: a draft, a document, a sequence, a design.",
        include: ["A result with an output attached", "A written piece the people asked for"],
        exclude: ["A decision about work", "A status report about work"],
      },
      decision: {
        meaning: "A choice made between options, or a recommendation of one.",
        include: ["A price, a plan, a yes or no", "A recommendation with its reasons", "An assessment that ends in a verdict"],
        exclude: ["A question still open", "A deliverable that embodies a decision without stating one"],
      },
      answer: {
        meaning: "A direct reply to a question that was asked.",
        include: ["A fact, a figure, a source", "A finding or diagnosis"],
        exclude: ["A decision", "A deliverable"],
      },
      update: {
        meaning: "A report on where the work stands, a milestone reached, a status, or a correction to something already reported.",
        include: ["A cutover completed", "A stage done with more to come", "A correction to a result already carried"],
        exclude: ["A finished deliverable", "A decision"],
      },
      question: {
        meaning: "Something the message asks that remains open.",
        include: ["A question for the parent's readers", "A question to the people here"],
        exclude: ["A rhetorical question inside an answer"],
      },
    },
  }),
} as const;

export const TurnDispositionAnswersSchema = z.object({
  disposition: jevChoiceAnswerSchema(TURN_DISPOSITION_CHOICES),
  carried_item_kind: jevChoiceAnswerSchema(CARRIED_ITEM_KINDS),
});

/**
 * The confidence a positive answer needs before a chip is written. Read off
 * the 2026-10-18 corpus sweep (`design.md`, "The first corpus evaluation"):
 * carry-up F1 is flat from 0.5 to 0.7 while precision climbs from 68% to 80%
 * and the suggestion rate on a person's messages falls from 7% to 5%, and
 * the product owner's price list weighs a false line above a miss, so the
 * upper end of the flat band is the one chosen. The comparison is `>`,
 * matching the other two classifiers, so a confidence equal to it stays quiet.
 */
export const TURN_DISPOSITION_CONFIDENCE_THRESHOLD = 0.6;

/**
 * JEV's own deadline for this decision: three times the measured p95 of about
 * 350 ms, the budget addressing and the semantic trigger carry against the same
 * provider. Here it bounds a settlement step behind a run that already ended.
 */
export const TURN_DISPOSITION_JEV_TIMEOUT_MS = 1_000;

export type TurnDispositionCode = TurnDisposition | "classifier_unavailable";

export interface TurnDispositionDecision {
  code: TurnDispositionCode;
  disposition: TurnDisposition | null;
  confidence: number | null;
  kind: CarriedItemKind | null;
  kindConfidence: number | null;
  /** The model that answered, which the alias makes distinct from the one requested. */
  model: string | null;
  /** Present when the classifier could not answer at all. */
  failureKind?: string;
}

export interface TurnDispositionInput {
  typesafeApiKey: string;
  state: TurnDispositionState;
  /** Overrides the owned deadline; an evaluation measuring tails passes a longer one. */
  timeoutMs?: number | undefined;
  signal?: AbortSignal | undefined;
  fetch?: typeof globalThis.fetch | undefined;
  onDiagnostic?: ((event: StructuredModelDiagnostic) => void | Promise<void>) | undefined;
  traceContext?: OpenRouterTraceContext | undefined;
}

/**
 * Judge one settled turn. Never throws: every way of not getting an answer
 * becomes `classifier_unavailable`, which the host treats as nothing to
 * suggest. A caller's cancellation is the one thing that propagates.
 */
export async function judgeTurnDisposition(input: TurnDispositionInput): Promise<TurnDispositionDecision> {
  try {
    const result = await askJev({
      apiKey: input.typesafeApiKey,
      model: JEV_LATEST_MODEL,
      schemaName: "turn_disposition",
      timeoutMs: input.timeoutMs ?? TURN_DISPOSITION_JEV_TIMEOUT_MS,
      state: boundTurnDispositionState(input.state),
      questions: turnDispositionQuestions,
      answers: TurnDispositionAnswersSchema,
      signal: input.signal,
      fetch: input.fetch,
      onDiagnostic: input.onDiagnostic,
      traceContext: input.traceContext,
    });
    const disposition = result.answers.disposition;
    const kind = result.answers.carried_item_kind;
    return {
      code: disposition.choice,
      disposition: disposition.choice,
      confidence: disposition.confidence,
      kind: kind.choice,
      kindConfidence: kind.confidence,
      model: result.model,
    };
  } catch (error) {
    if (input.signal?.aborted) throw error;
    return {
      code: "classifier_unavailable",
      disposition: null,
      confidence: null,
      kind: null,
      kindConfidence: null,
      model: null,
      failureKind: jevFailureKind(error, input.signal),
    };
  }
}

export type SuggestionKind = "merge_up" | "start_breakout";

/**
 * The host's mapping from a decision to a suggestion, by conversation kind.
 * A Breakout offers only `merge_up`: there are no nested Breakouts, so the
 * breakout outcome maps to nothing there. A confidence at or below the
 * threshold maps to nothing everywhere.
 */
export function suggestionForTurnDisposition(
  decision: TurnDispositionDecision,
  conversationKind: TurnDispositionState["conversation"]["kind"],
  threshold: number = TURN_DISPOSITION_CONFIDENCE_THRESHOLD,
): SuggestionKind | null {
  if (decision.disposition === null || decision.confidence === null) return null;
  if (!(decision.confidence > threshold)) return null;
  if (decision.disposition === "worth_carrying_up") return "merge_up";
  if (decision.disposition === "side_question_worth_a_breakout" && conversationKind === "thread") return "start_breakout";
  return null;
}
