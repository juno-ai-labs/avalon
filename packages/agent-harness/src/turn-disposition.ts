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
 * What a settled Rally turn calls for next, measured against its conversation's
 * purpose: carry it up to the parent, break a side question out, or nothing.
 *
 * The third JEV caller, written to the shape of `semantic-trigger-gate.ts`:
 * the state, the question, the criteria and the mapping live here, the
 * transport in `./jev`. Nothing here knows where a decision is stored or shown;
 * `docs/PRDs/2026-10-17_merge-and-breakout-suggestions/design.md` owns the
 * contract and the evidence behind each line of the criteria.
 */
export const TURN_DISPOSITION_CHOICES = [
  "worth_carrying_up",
  "side_question_worth_a_breakout",
  "continue_here",
] as const;
export type TurnDisposition = (typeof TURN_DISPOSITION_CHOICES)[number];

/** The kind of thing a carried turn would be, asked for the chip's wording alone. */
export const CARRIED_ITEM_KINDS = ["deliverable", "decision", "answer", "update", "question"] as const;
export type CarriedItemKind = (typeof CARRIED_ITEM_KINDS)[number];

export const TurnDispositionStateSchema = z.object({
  conversation: z.object({
    kind: z.enum(["thread", "breakout"]),
    purpose: z.string(),
    title: z.string(),
  }),
  settled_turn: z.object({
    text: z.string(),
    artifacts: z.array(z.object({ title: z.string(), kind: z.string() })).optional(),
  }),
  conversation_context: z.object({
    recent_messages: z.array(z.object({
      author: z.enum(["person", "rally"]),
      text: z.string(),
    })),
  }),
});
export type TurnDispositionState = z.infer<typeof TurnDispositionStateSchema>;

/**
 * The bounds the state is sent under. Ten messages of a thousand code points
 * each is addressing's measured context bound, reused rather than re-derived;
 * the settled turn is kept whole up to a budget that holds every production
 * Breakout turn the first corpus contained, with its opening and its
 * conclusion kept around a middle ellipsis past that.
 */
export const TURN_DISPOSITION_MAX_RECENT_MESSAGES = 10;
export const TURN_DISPOSITION_MAX_RECENT_MESSAGE_CODE_POINTS = 1_000;
export const TURN_DISPOSITION_MAX_TURN_CODE_POINTS = 6_000;

function centerTruncate(value: string, limit: number): string {
  const characters = Array.from(value);
  if (characters.length <= limit) return value;
  const retained = limit - 1;
  const prefix = Math.ceil(retained / 2);
  const suffix = retained - prefix;
  return `${characters.slice(0, prefix).join("")}…${characters.slice(characters.length - suffix).join("")}`;
}

/** The exact state a request carries: the caller's state under the bounds above. */
export function boundTurnDispositionState(state: TurnDispositionState): TurnDispositionState {
  return {
    conversation: state.conversation,
    settled_turn: {
      text: centerTruncate(state.settled_turn.text, TURN_DISPOSITION_MAX_TURN_CODE_POINTS),
      ...(state.settled_turn.artifacts ? { artifacts: state.settled_turn.artifacts } : {}),
    },
    conversation_context: {
      recent_messages: state.conversation_context.recent_messages
        .slice(-TURN_DISPOSITION_MAX_RECENT_MESSAGES)
        .map((message) => ({
          author: message.author,
          text: centerTruncate(message.text, TURN_DISPOSITION_MAX_RECENT_MESSAGE_CODE_POINTS),
        })),
    },
  };
}

/**
 * The questions, as data, so an evaluation can hold the exact request beside
 * the answer it produced. The revision line under `worth_carrying_up` is the
 * one criterion the first live probe earned: without it a deliverable revised
 * as asked ("nothing else changed") sat on the threshold as an update.
 */
export const turnDispositionQuestions = {
  disposition: jevChoiceQuestion<TurnDisposition>({
    instructions: {
      question: "Measured against `conversation.purpose`, what does `settled_turn` call for next?",
      focus: "Judge the settled turn. `conversation.purpose` is what this conversation exists to do. Use `conversation_context.recent_messages` only to tell whether the purpose is still in motion here, and whether a side question is new rather than the purpose itself.",
      decision: "Choose exactly one.",
    },
    criteria: {
      worth_carrying_up: {
        meaning: "The turn holds something the parent conversation's readers need now, in words they could use without this transcript: a deliverable, a decision, an answer to what they asked, a recommendation, a milestone, or a question only they can settle.",
        include: [
          "A finished deliverable or draft",
          "A deliverable revised the way the people here asked, now done",
          "A decision the people here reached",
          "The answer to the purpose",
          "A question this conversation cannot settle and the parent can",
          "A milestone the parent is waiting on",
        ],
        exclude: [
          "A draft the turn itself calls preliminary or asks the people here to review",
          "Routine progress, however long",
          "A question to the people here",
          "An answer to a narrow question that is not the purpose",
        ],
      },
      side_question_worth_a_breakout: {
        meaning: "The turn, or the exchange that led to it, opened a distinct piece of work beside the purpose: large enough to need its own conversation, likely to crowd this one.",
        include: [
          "A sub-problem the turn proposes to work separately",
          "A second deliverable the people asked for that the purpose does not cover",
          "A line of questions on another subject that has run for several turns",
        ],
        exclude: [
          "A clarification or follow-up about the purpose itself",
          "A one-line aside",
          "The next step of the purpose",
        ],
      },
      continue_here: {
        meaning: "The turn is a step of the work here, and nothing in it is for the parent's readers yet.",
        include: [
          "Partial work, a question to a person here, a status update",
          "A result that answers a small part of the purpose",
        ],
        exclude: [
          "Something the parent's readers need now",
          "A deliverable revised as asked and now done",
          "A distinct piece of work beside the purpose",
        ],
      },
    },
  }),
  carried_item_kind: jevChoiceQuestion<CarriedItemKind>({
    instructions: {
      question: "If `settled_turn` were carried to the parent conversation, what kind of thing would it be?",
      focus: "Name the kind of the turn's main content. Judge the turn alone.",
      decision: "Choose exactly one.",
    },
    criteria: {
      deliverable: {
        meaning: "A finished piece of work: a draft, a document, a sequence, a design.",
        include: ["A result with an artifact attached", "A written piece the people asked for"],
        exclude: ["A decision about work", "A status report about work"],
      },
      decision: {
        meaning: "A choice made between options, or a recommendation of one.",
        include: ["A price, a plan, a yes or no", "A recommendation with its reasons"],
        exclude: ["A question still open", "A deliverable that embodies a decision without stating one"],
      },
      answer: {
        meaning: "A direct reply to a question that was asked.",
        include: ["A fact, a figure, a source"],
        exclude: ["A decision", "A deliverable"],
      },
      update: {
        meaning: "A report on where the work stands, a milestone reached or a status.",
        include: ["A cutover completed", "A stage done with more to come"],
        exclude: ["A finished deliverable", "A decision"],
      },
      question: {
        meaning: "Something the turn asks that remains open.",
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
 * The confidence a positive answer needs before a chip is written. Provisional:
 * the design reads this off the shadow sweep, and nothing here is gated on it
 * until the surface exists. The comparison is `>`, matching the other two
 * classifiers, so a confidence equal to it stays quiet.
 */
export const TURN_DISPOSITION_CONFIDENCE_THRESHOLD = 0.5;

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
