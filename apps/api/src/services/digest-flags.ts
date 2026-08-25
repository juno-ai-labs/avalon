import type { Env } from "../env";
import { logStructuredEvent } from "../observability/logger";
import { loadFlagTargetingAttributes } from "./flag-targeting-attributes";

/**
 * Whether scheduled digests are allowed to fire at all — the fourth reader of
 * `env.FLAGS`, and its own module for the same reason `control-tower-flags.ts`
 * is: it is neither of the other two kinds. `agent-model-flags.ts` decides
 * which model an agent runs on and never leaves the Worker; `client-feature-flags.ts`
 * decides what the desktop may *offer* and fails closed, because a feature
 * nobody has been given yet is what an outage has to reproduce. A digest is
 * the opposite of that: it is already on by default for every existing person
 * (see `docs/digests.md`), so the behavior an outage has to reproduce is
 * delivery *continuing*. This flag therefore fails **open** — to `true` — the
 * same direction as a model flag and for the same reason: only an operator's
 * explicit `false` should ever stop a digest from sending, never a Flagship
 * hiccup.
 *
 * Not Ace-managed. Ace's editor and its Queue fan-out exist to push a changed
 * value to connected desktop sockets within Flagship's propagation window;
 * this flag is read fresh by the scheduler each time one occurrence is about
 * to fire, which is at most a few times a day per person and never from a
 * live socket, so there is no propagation problem for Ace's machinery to
 * solve. It is provisioned and changed the way the agent-model flags and the
 * Control Tower cadence are — `wrangler flagship flags`, documented in
 * `docs/feature-flags.md` — and `docs/ace.md`'s boundary section names it
 * alongside them.
 *
 * The flag gates firing only. It is read at the top of `fireDigestSchedule`,
 * before the occurrence is claimed, so an occurrence skipped for this reason
 * writes no `digest_deliveries` row and never advances the cursor — the same
 * shape a person's own `digest_schedules.enabled = 0` already produces.
 * Turning the flag back on costs nothing: the next occurrence to fire reads
 * `previousCursor` exactly as it always does and catches up on whatever was
 * missed, bounded by the same window the digest already applies to a quiet
 * schedule.
 */

/** Flagship flag key. Boolean; defaults to on, so an outage cannot silently stop delivery. */
export const DIGESTS_ENABLED_FLAG_KEY = "digests-enabled";

interface DigestsEnabledSubject {
  userId: string;
  workspaceId: string;
}

function unreachableFlagLevel(env: Env): "debug" | "warn" {
  return env.APP_ENV === "development" || env.APP_ENV === "test" ? "debug" : "warn";
}

/**
 * Resolve whether one person's digest may fire right now.
 *
 * Never throws, and never resolves to `false` except on an explicit `false`
 * variation actually served by Flagship: no binding, an unreachable binding, an
 * unresolved flag, and a non-boolean value are all the same answer as a flag
 * that was never created — digests keep sending exactly as they did before
 * this flag existed.
 */
export async function resolveDigestsEnabled(
  env: Env,
  subject: DigestsEnabledSubject,
): Promise<boolean> {
  const fallback = true;
  const flags = env.FLAGS;
  if (!flags) return fallback;
  // Loaded outside the try below, which is written for the one expected
  // condition it names. The loader guarantees its own no-throw contract.
  const attributes = await loadFlagTargetingAttributes(env, subject);
  let details: FlagshipEvaluationDetails<boolean>;
  try {
    details = await flags.getBooleanDetails(DIGESTS_ENABLED_FLAG_KEY, fallback, {
      // Attributes first, so a loaded fact cannot shadow the ids a percentage
      // rollout buckets on.
      ...attributes,
      region: env.AVALON_REGION,
      appEnv: env.APP_ENV,
      userId: subject.userId,
      workspaceId: subject.workspaceId,
    });
  } catch (error) {
    // `wrangler dev --local` binds this always-remote binding as an object
    // whose every call throws `Binding FLAGS needs to be run remotely`, so this
    // is the normal local path and must not warn on every digest fire.
    logStructuredEvent(env, unreachableFlagLevel(env), "digests_enabled_flag_unavailable", {
      user_id: subject.userId,
      workspace_id: subject.workspaceId,
      flag_key: DIGESTS_ENABLED_FLAG_KEY,
      error_name: error instanceof Error ? error.name : "UnknownError",
    });
    return fallback;
  }
  // Flagship answers a missing, disabled, or type-mismatched flag with the
  // default rather than throwing, so `errorCode` is the only thing separating a
  // mistyped key from a flag that is provisioned and on.
  if (details.errorCode) {
    logStructuredEvent(env, "warn", "digests_enabled_flag_unresolved", {
      user_id: subject.userId,
      workspace_id: subject.workspaceId,
      flag_key: DIGESTS_ENABLED_FLAG_KEY,
      reason: details.reason,
      error_code: details.errorCode,
      error_message: details.errorMessage,
    });
    return fallback;
  }
  // The mirror of `client-feature-flags.ts`'s `details.value === true`: there,
  // anything but an explicit `true` is off; here, anything but an explicit
  // `false` is on, because this flag fails toward delivery continuing.
  const enabled = details.value !== false;
  // The variant and reason are what confirm a targeting rule actually matched
  // this person, which is the only way to tell a rule that excluded them from
  // one that never fired. The attribute *names* say whether the fact a rule is
  // written against was even available, and carry none of the values.
  logStructuredEvent(env, "debug", "digests_enabled_flag_resolved", {
    user_id: subject.userId,
    workspace_id: subject.workspaceId,
    flag_key: DIGESTS_ENABLED_FLAG_KEY,
    attributes: Object.keys(attributes).sort(),
    variant: details.variant,
    reason: details.reason,
    enabled,
  });
  return enabled;
}
