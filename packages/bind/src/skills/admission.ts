import {
  SKILL_MAX_ACTIVE_BODY_TOKENS,
  SKILL_MAX_ACTIVE_PER_SESSION,
  estimateSkillTokens,
} from "./types";

/**
 * Whether a run may load one more skill.
 *
 * Two bounds, and they are not redundant. The **count** is cheap and is checked
 * before anything is resolved. The **token total** is the one that actually
 * protects the context window: twelve short skills fit and three long ones do
 * not, so a count cap alone bounds the wrong quantity. Without the second, a
 * model in a loop loads its way to a context-limit error mid-run, which reads
 * to a user as the agent breaking rather than as it over-reaching.
 *
 * Shaped like `admitChildRun` in `run/children.ts`, and for the same reason:
 * **the host measures, the harness judges.** Estimating the token cost of the
 * would-be active set means resolving bodies, which is I/O; comparing a number
 * to a limit is not. So each bound arrives with the measurement it judges, and
 * a bound whose number the host could not produce is simply omitted — a rule
 * that silently never fires is worse than one that is visibly absent.
 */

export type SkillLoadRefusal =
  | { kind: "active_count"; active: number; max: number }
  | { kind: "active_body_tokens"; tokens: number; max: number };

export type SkillLoadDecision =
  | { admitted: true }
  | {
      admitted: false;
      refusal: SkillLoadRefusal;
      /**
       * A noun phrase, carrying no identifiers. Hosts surface a refusal to the
       * model as a tool error and sometimes to a person, so it must be safe to
       * render in both places and must read after a host's own prefix.
       */
      reason: string;
    };

export interface SkillLoadBounds {
  /**
   * Refs already active. Omit the pair to skip the count bound; a non-finite or
   * negative count **refuses**, because a broken measurement is not evidence
   * that there is room.
   */
  activeCount?: number;
  maxActive?: number;
  /**
   * Estimated tokens of the instruction set the load would produce — the whole
   * would-be active set, not the increment. Omit the pair to skip the bound.
   */
  projectedBodyTokens?: number;
  maxBodyTokens?: number;
}

function bounded(measurement: number | undefined): measurement is number {
  return measurement !== undefined;
}

/**
 * Judge a `load_skill` against the active-set bounds. A skill that is already
 * active is never subject to either bound — reloading it adds nothing — so
 * callers should short-circuit before calling.
 */
export function admitSkillLoad(bounds: SkillLoadBounds): SkillLoadDecision {
  const maxActive = bounds.maxActive ?? SKILL_MAX_ACTIVE_PER_SESSION;
  if (bounded(bounds.activeCount)) {
    const active = bounds.activeCount;
    // `!(active < max)` rather than `active >= max`: every comparison is false
    // against NaN, so the naive form admits on a broken count instead of
    // refusing on one.
    if (!(Number.isFinite(active) && active >= 0 && active < maxActive)) {
      return {
        admitted: false,
        refusal: { kind: "active_count", active, max: maxActive },
        reason: `active-skill limit reached (${maxActive} loaded). Work from the skills already loaded rather than loading more.`,
      };
    }
  }

  const maxBodyTokens = bounds.maxBodyTokens ?? SKILL_MAX_ACTIVE_BODY_TOKENS;
  if (bounded(bounds.projectedBodyTokens)) {
    const tokens = bounds.projectedBodyTokens;
    if (!(Number.isFinite(tokens) && tokens >= 0 && tokens <= maxBodyTokens)) {
      return {
        admitted: false,
        refusal: { kind: "active_body_tokens", tokens, max: maxBodyTokens },
        reason: `loading this skill would take the loaded instructions to about ${tokens} tokens, over the ${maxBodyTokens}-token budget. Work from the skills already loaded instead of loading more.`,
      };
    }
  }

  return { admitted: true };
}

/** Estimated token cost of a resolved instruction set — the input to the body bound. */
export function estimateSkillBodyTokens(instructions: readonly string[]): number {
  return instructions.reduce((total, body) => total + estimateSkillTokens(body), 0);
}
