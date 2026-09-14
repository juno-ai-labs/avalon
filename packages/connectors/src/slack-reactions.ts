/**
 * Avalon's Slack reaction vocabulary.
 *
 * A reaction on the message that started a run is the only status a member sees
 * without opening the thread, so it says the two things a member outside the
 * thread needs: that the prompt was taken, and how the run ended. At most one
 * Avalon reaction sits on a message at a time — the alternative, adding each
 * state beside the last, leaves a row of pills and makes the current state
 * something the reader has to work out.
 *
 * There is deliberately no third state between those two. A reaction that
 * changed while the run was live had to be redrawn by removing one emoji and
 * adding another, which Slack renders as the pill vanishing and reappearing;
 * a run that crossed several of them flickered in every channel it ran in.
 *
 * The sets are configurable because an installation's emoji are part of its
 * culture, and because Avalon cannot know which custom emoji a workspace has.
 * Slack offers no way to check that a name exists before using it, so a
 * configured emoji it rejects degrades to the default for that state rather than
 * leaving the message with no reaction at all.
 */
import { z } from "zod";

/** The terminal statuses a run reaches, and which a reaction has to name. */
export const SlackReactionOutcomes = ["completed", "needs_input", "failed", "stopped"] as const;
export type SlackReactionOutcome = (typeof SlackReactionOutcomes)[number];

/** Slack's own character set for an emoji name, custom emoji included. */
export const SlackEmojiNameSchema = z.string().min(1).max(100).regex(/^[a-zA-Z0-9_+-]+$/u);

export interface SlackReactionSet {
  /** Added the moment the prompt is admitted, before any context is gathered. */
  acknowledgement: string;
  outcomes: Readonly<Record<SlackReactionOutcome, string>>;
}

export const SLACK_DEFAULT_REACTIONS: SlackReactionSet = {
  acknowledgement: "eyes",
  outcomes: {
    completed: "white_check_mark",
    needs_input: "question",
    failed: "x",
    stopped: "octagonal_sign",
  },
};

/**
 * A configured override. Every field is optional and an absent one inherits the
 * tier below, so a workspace that only wants its own checkmark writes only that.
 */
export const SlackReactionOverrideSchema = z.strictObject({
  acknowledgement: SlackEmojiNameSchema.optional(),
  outcomes: z.strictObject({
    completed: SlackEmojiNameSchema.optional(),
    needs_input: SlackEmojiNameSchema.optional(),
    failed: SlackEmojiNameSchema.optional(),
    stopped: SlackEmojiNameSchema.optional(),
  }).optional(),
});
export type SlackReactionOverride = z.infer<typeof SlackReactionOverrideSchema>;

/**
 * Resolves reaction sets most-specific-wins, later overrides beating earlier
 * ones and the built-in defaults underneath them all.
 *
 * Anything that does not parse is dropped rather than throwing: a malformed
 * override is a configuration mistake, and failing a member's run over one would
 * be a worse answer than using the defaults.
 */
export function resolveSlackReactions(...overrides: readonly unknown[]): SlackReactionSet {
  let resolved: SlackReactionSet = SLACK_DEFAULT_REACTIONS;
  for (const candidate of overrides) {
    if (candidate === null || candidate === undefined) continue;
    const parsed = SlackReactionOverrideSchema.safeParse(candidate);
    if (!parsed.success) continue;
    resolved = {
      acknowledgement: parsed.data.acknowledgement ?? resolved.acknowledgement,
      outcomes: { ...resolved.outcomes, ...stripUndefined(parsed.data.outcomes) },
    };
  }
  return resolved;
}

/**
 * The default for a state, used when Slack rejects the configured emoji.
 *
 * Falling back to Avalon's own vocabulary is the point: a workspace that
 * configured an emoji that does not exist should see the acknowledgement or the
 * outcome, not discover the feature silently switched itself off.
 */
export function slackDefaultReactionFor(
  state: "acknowledgement" | SlackReactionOutcome,
): string {
  if (state === "acknowledgement") return SLACK_DEFAULT_REACTIONS.acknowledgement;
  return SLACK_DEFAULT_REACTIONS.outcomes[state];
}

function stripUndefined(
  outcomes: Partial<Record<SlackReactionOutcome, string | undefined>> | undefined,
): Partial<Record<SlackReactionOutcome, string>> {
  if (!outcomes) return {};
  const defined: Partial<Record<SlackReactionOutcome, string>> = {};
  for (const outcome of SlackReactionOutcomes) {
    const value = outcomes[outcome];
    if (value !== undefined) defined[outcome] = value;
  }
  return defined;
}
