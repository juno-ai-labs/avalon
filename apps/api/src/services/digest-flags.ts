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
 * Ace-managed: it is in `MANAGED_FLAGS` (`apps/ace/src/protocol.ts`) and
 * provisioned by `apps/ace/scripts/deploy.mjs` alongside the four
 * presentation flags, so an operator has exactly one editor for every Boolean
 * flag they might need to change by hand. A save triggers Ace's ordinary
 * Queue fan-out to connected desktop sockets, which now has a real client
 * consumer — see below — where it once only re-sent the other four flags'
 * unchanged values. See `docs/ace.md` and `docs/feature-flags.md`.
 *
 * The flag gates firing on the server, and — since `client-feature-flags.ts`
 * added a `digestsEnabled` field — visibility on the client, from this same
 * function both places. It is read at the top of `fireDigestSchedule`, before
 * the occurrence is claimed, so an occurrence skipped for this reason writes
 * no `digest_deliveries` row and never advances the cursor — the same shape a
 * person's own `digest_schedules.enabled = 0` already produces. Turning the
 * flag back on costs nothing: the next occurrence to fire reads
 * `previousCursor` exactly as it always does and catches up on whatever was
 * missed, bounded by the same window the digest already applies to a quiet
 * schedule. The client side costs nothing either: the Digest settings section
 * simply stops rendering and starts again, since nothing about a person's own
 * saved configuration ever changes underneath it.
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
  // Resolving to disabled logs at `info`, not `debug`, because `debug` sits
  // below both regions' configured production level and this is the one trace
  // an operator has that the flag took effect — no delivery row is written
  // either, by design, so there is nothing else to check to answer "why did
  // nobody get a digest." Two callers reach this now: `fireDigestSchedule`, a
  // few times a day per person, and `client-feature-flags.ts`'s
  // `digestsEnabled`, resolved on every reconnect and poll — still bounded by
  // how often a person's client actually does that, not a hot request path,
  // but a wider volume than the scheduler alone would produce. Deliberately
  // one function logging the same way for both rather than a caller-specific
  // level: the level answers "is this worth an operator seeing," which does
  // not change with who asked.
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
