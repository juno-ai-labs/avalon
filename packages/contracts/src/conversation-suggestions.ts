import { z } from "zod";
import { IdSchema } from "./identifiers";

/**
 * A conversation suggestion: one quiet line under a message in a Thread or a
 * Breakout, offered by the turn-disposition classifier once a run settles,
 * saying the result might be worth carrying up to the parent (`merge_up`) or
 * that a side question might deserve its own Breakout (`start_breakout`), or
 * that the whole purpose is complete (`mark_resolved`).
 * It is conversation state keyed to the judged turn, not a transcript row:
 * one per turn, resolved in place, and never part of the model's history.
 * `docs/conversation-suggestions.md` owns the slot;
 * `docs/PRDs/2026-10-17_merge-and-breakout-suggestions/` is the design.
 */
export const CONVERSATION_SUGGESTION_KINDS = ["merge_up", "start_breakout", "mark_resolved"] as const;
export const ConversationSuggestionKindSchema = z.enum(CONVERSATION_SUGGESTION_KINDS);
export type ConversationSuggestionKind = z.infer<typeof ConversationSuggestionKindSchema>;

export const CONVERSATION_SUGGESTION_STATUSES = ["open", "accepted", "dismissed", "expired", "withdrawn"] as const;
export const ConversationSuggestionStatusSchema = z.enum(CONVERSATION_SUGGESTION_STATUSES);
export type ConversationSuggestionStatus = z.infer<typeof ConversationSuggestionStatusSchema>;

/**
 * How many of the conversation's newest messages a suggestion stays visible
 * on. People's messages and Rally's replies count; tool cards and system rows
 * do not. Once three newer messages exist the line is hidden for good, acted
 * on or not. A product number set by the product owner in the PRD
 * (`prd.md`, "How long it shows"), held here so the client that hides the
 * line and the object that records the outcome read one value.
 */
export const SUGGESTION_VISIBLE_WITHIN_NEWEST_TURNS = 3;

/**
 * Whether a suggestion's turn is still among the newest messages. `newestTurnIds`
 * is the conversation's readable turns in reading order (oldest first), the way
 * a feed holds them; the judged turn is visible while fewer than
 * {@link SUGGESTION_VISIBLE_WITHIN_NEWEST_TURNS} newer ones exist.
 */
export function suggestionTurnIsVisible(judgedTurnId: string, turnIdsOldestFirst: readonly string[]): boolean {
  const index = turnIdsOldestFirst.lastIndexOf(judgedTurnId);
  if (index === -1) return false;
  return turnIdsOldestFirst.length - index <= SUGGESTION_VISIBLE_WITHIN_NEWEST_TURNS;
}

/** The drafted words a suggestion carries: a merge note, or a Breakout's opening prompt and subject. */
export const ConversationSuggestionDraftSchema = z.object({
  status: z.enum(["pending", "ready", "failed"]),
  text: z.string().nullable(),
  subject: z.string().nullable(),
});
export type ConversationSuggestionDraft = z.infer<typeof ConversationSuggestionDraftSchema>;

/** Where a `merge_up` would land, computed the way the Merge label is; null when the server cannot say. */
export const ConversationSuggestionTargetSchema = z.object({
  kind: z.enum(["thread", "channel"]),
  id: IdSchema,
  title: z.string(),
});
export type ConversationSuggestionTarget = z.infer<typeof ConversationSuggestionTargetSchema>;

export const ConversationSuggestionSchema = z.object({
  suggestionId: IdSchema,
  kind: ConversationSuggestionKindSchema,
  judgedTurnId: z.string().min(1),
  status: ConversationSuggestionStatusSchema,
  draft: ConversationSuggestionDraftSchema,
  target: ConversationSuggestionTargetSchema.nullable(),
});
export type ConversationSuggestion = z.infer<typeof ConversationSuggestionSchema>;

export const ConversationSuggestionActionResultSchema = z.object({
  suggestionId: IdSchema,
  status: ConversationSuggestionStatusSchema,
  replayed: z.boolean(),
});
export type ConversationSuggestionActionResult = z.infer<typeof ConversationSuggestionActionResultSchema>;

export const ConversationSuggestionDismissResultSchema = ConversationSuggestionActionResultSchema;
export type ConversationSuggestionDismissResult = ConversationSuggestionActionResult;
