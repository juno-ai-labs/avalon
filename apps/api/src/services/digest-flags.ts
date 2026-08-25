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
 * Ace-managed, but not client-visible: it is in `MANAGED_FLAGS`
 * (`apps/ace/src/protocol.ts`) and provisioned by `apps/ace/scripts/deploy.mjs`
 * alongside the four presentation flags, so an operator has exactly one editor
 * for every Boolean flag they might need to change by hand — but Electron
 * never reads it, and it is not part of `ClientFeatureFlagsSchema`. A save
 * still triggers Ace's ordinary Queue fan-out to connected desktop sockets;
 * that fan-out always re-evaluates and re-sends the complete client contract
 * regardless of which key changed, so it costs a harmless repeat of work
 * already safe to repeat rather than solving a propagation problem this flag
 * actually has — read fresh by the scheduler each time one occurrence is
 * about to fire, at most a few times a day per person, never from a live
 * socket. See `docs/ace.md` and `docs/feature-flags.md`.
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
  //
  // Resolving to disabled logs at `info`, not `debug`: this flag is an
  // operator's kill switch, and `debug` sits below both regions' configured
  // production level. Without this, flipping the flag off leaves no trace an
  // operator can find — no delivery row is written either, by design — so
  // there would be no way to confirm the flag took effect or to answer "why
  // did nobody get a digest" without reading this source file. Volume is
  // bounded by the same arithmetic that makes this flag cheap to evaluate: at
  // most a few resolutions per person per day, even with it off account-wide.
  logStructuredEvent(env, enabled ? "debug" : "info", "digests_enabled_flag_resolved", {
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
