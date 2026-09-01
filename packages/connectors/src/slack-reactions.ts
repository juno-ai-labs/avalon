/**
 * Avalon's Slack reaction vocabulary.
 *
 * A reaction on the message that started a run is the only status a member sees
 * without opening the thread, so it is a state indicator rather than a receipt:
 * an acknowledgement while the prompt is admitted, a rotating working reaction
 * while the run is live, and one reaction naming the outcome when it ends. At
 * most one Avalon reaction sits on a message at a time — the alternative, adding
 * each state beside the last, leaves a row of pills and makes the current state
 * something the reader has to work out.
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
  /** Cycled while the run is live. Order is the rotation order. */
  working: readonly string[];
  /**
   * How long each working reaction stays before the next one replaces it.
   *
   * The floor is Slack's, not taste. `reactions.add` and `reactions.remove` are
   * Tier 3 methods — roughly 50 calls a minute, counted per method per workspace
   * per app — and one rotation step spends one call in each bucket. At six
   * seconds a single run spends ten of those fifty per minute, which leaves room
   * for about five concurrent runs in a workspace before Slack starts refusing.
   * Faster cycling looks better in a demo and stalls in a busy workspace, where
   * the refusals land on whichever run happens to tick last.
   */
  workingIntervalMs: number;
  outcomes: Readonly<Record<SlackReactionOutcome, string>>;
}

export const SLACK_DEFAULT_REACTIONS: SlackReactionSet = {
  acknowledgement: "eyes",
  // Deliberately drawn from different categories — thinking, searching,
  // writing, working — so the rotation reads as a run making progress rather
  // than one idea flickering.
  working: ["brain", "mag", "writing_hand", "gear"],
  workingIntervalMs: 6_000,
  outcomes: {
    completed: "white_check_mark",
    needs_input: "question",
    failed: "warning",
    stopped: "octagonal_sign",
  },
};

/**
 * A configured override. Every field is optional and an absent one inherits the
 * tier below, so a workspace that only wants its own checkmark writes only that.
 */
export const SlackReactionOverrideSchema = z.strictObject({
  acknowledgement: SlackEmojiNameSchema.optional(),
  working: z.array(SlackEmojiNameSchema).min(1).max(12).optional(),
  workingIntervalMs: z.number().int().min(3_000).max(60_000).optional(),
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
      working: parsed.data.working ?? resolved.working,
      workingIntervalMs: parsed.data.workingIntervalMs ?? resolved.workingIntervalMs,
      outcomes: { ...resolved.outcomes, ...stripUndefined(parsed.data.outcomes) },
    };
  }
  return resolved;
}

/** The working reaction at a rotation cursor, which wraps rather than ending. */
export function slackWorkingReaction(set: SlackReactionSet, cursor: number): string {
  const rotation = set.working.length ? set.working : SLACK_DEFAULT_REACTIONS.working;
  const index = ((cursor % rotation.length) + rotation.length) % rotation.length;
  return rotation[index]!;
}

/**
 * The default for a state, used when Slack rejects the configured emoji.
 *
 * Falling back to Avalon's own vocabulary is the point: a workspace that
 * configured an emoji that does not exist should see a working reaction, not
 * discover the feature silently switched itself off.
 */
export function slackDefaultReactionFor(
  state: "acknowledgement" | SlackReactionOutcome | "working",
  cursor = 0,
): string {
  if (state === "acknowledgement") return SLACK_DEFAULT_REACTIONS.acknowledgement;
  if (state === "working") return slackWorkingReaction(SLACK_DEFAULT_REACTIONS, cursor);
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
