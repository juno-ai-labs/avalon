import { CONTROL_TOWER_REFRESH_SECONDS } from "@rally/contracts";
import type { Env } from "../env";
import { logStructuredEvent } from "../observability/logger";
import { loadFlagTargetingAttributes } from "./flag-targeting-attributes";

/**
 * Control Tower's refresh cadence, served from Flagship.
 *
 * This is the third reader of `env.FLAGS`, and it is its own module because it
 * is neither of the other two kinds. `agent-model-flags.ts` decides which model
 * an agent runs on and never leaves the Worker; `client-feature-flags.ts`
 * decides what the desktop may *offer* and fails closed to off. A cadence has
 * no off — a recording that never refreshes is not a safe answer to an outage —
 * so this one fails the way a model flag does, to a checked-in default that
 * reproduces today's behavior.
 *
 * Two callers read it and they must agree. The desktop reads it through
 * `GET /feature-flags` to set the timer that commits a transcript segment and
 * asks for the next briefing; the meeting-notes generator reads it to tell the
 * model how soon it runs again, which is what licenses the prompt's "reuse what
 * you wrote last time". A cadence the client acts on and the prompt describes
 * differently is a briefing written for a schedule nobody is keeping.
 */

/** Flagship flag key. Number, in seconds; defaults to the checked-in cadence. */
export const CONTROL_TOWER_REFRESH_FLAG_KEY = "control-tower-refresh-seconds";

interface ControlTowerFlagSubject {
  userId: string;
  workspaceId?: string;
}

function unreachableFlagLevel(env: Env): "debug" | "warn" {
  return env.APP_ENV === "development" || env.APP_ENV === "test" ? "debug" : "warn";
}

/**
 * Resolve the refresh cadence in seconds for one person.
 *
 * Never throws, and never returns a cadence outside
 * `CONTROL_TOWER_REFRESH_SECONDS`. The clamp is not defensive tidiness: every
 * refresh is an inference and a segment write, so a flag typed in milliseconds
 * would otherwise turn one meeting into thousands of runs before anyone noticed.
 * A clamped value is logged rather than silently accepted, because the number
 * that was served is the only evidence of the mistake.
 */
export async function resolveControlTowerRefreshSeconds(
  env: Env,
  subject: ControlTowerFlagSubject,
): Promise<number> {
  const fallback = CONTROL_TOWER_REFRESH_SECONDS.default;
  const flags = env.FLAGS;
  if (!flags) return fallback;
  // Loaded outside the try below, which is written for the one expected
  // condition it names. The loader guarantees its own no-throw contract.
  const attributes = await loadFlagTargetingAttributes(env, subject);
  let details: FlagshipEvaluationDetails<number>;
  try {
    details = await flags.getNumberDetails(CONTROL_TOWER_REFRESH_FLAG_KEY, fallback, {
      // Attributes first, so a loaded fact cannot shadow the ids a percentage
      // rollout buckets on.
      ...attributes,
      region: env.AVALON_REGION,
      appEnv: env.APP_ENV,
      userId: subject.userId,
      ...(subject.workspaceId ? { workspaceId: subject.workspaceId } : {}),
    });
  } catch (error) {
    // `wrangler dev --local` binds this always-remote binding as an object whose
    // every call throws `Binding FLAGS needs to be run remotely`, so this is the
    // normal local path and must not warn on every meeting refresh.
    logStructuredEvent(env, unreachableFlagLevel(env), "control_tower_refresh_flag_unavailable", {
      user_id: subject.userId,
      workspace_id: subject.workspaceId,
      flag_key: CONTROL_TOWER_REFRESH_FLAG_KEY,
      error_name: error instanceof Error ? error.name : "UnknownError",
      refresh_seconds: fallback,
    });
    return fallback;
  }
  // Flagship answers a missing, disabled, or type-mismatched flag with the
  // default rather than throwing, so `errorCode` is the only thing separating a
  // mistyped key from a flag provisioned at the default cadence.
  if (details.errorCode) {
    logStructuredEvent(env, "warn", "control_tower_refresh_flag_unresolved", {
      user_id: subject.userId,
      workspace_id: subject.workspaceId,
      flag_key: CONTROL_TOWER_REFRESH_FLAG_KEY,
      reason: details.reason,
      error_code: details.errorCode,
      error_message: details.errorMessage,
      refresh_seconds: fallback,
    });
    return fallback;
  }
  const served = details.value;
  if (!Number.isFinite(served)) {
    logStructuredEvent(env, "warn", "control_tower_refresh_flag_invalid", {
      user_id: subject.userId,
      workspace_id: subject.workspaceId,
      flag_key: CONTROL_TOWER_REFRESH_FLAG_KEY,
      variant: details.variant,
      refresh_seconds: fallback,
    });
    return fallback;
  }
  const seconds = Math.min(
    CONTROL_TOWER_REFRESH_SECONDS.maximum,
    Math.max(CONTROL_TOWER_REFRESH_SECONDS.minimum, Math.round(served)),
  );
  if (seconds !== served) {
    logStructuredEvent(env, "warn", "control_tower_refresh_flag_clamped", {
      user_id: subject.userId,
      workspace_id: subject.workspaceId,
      flag_key: CONTROL_TOWER_REFRESH_FLAG_KEY,
      variant: details.variant,
      served_seconds: served,
      refresh_seconds: seconds,
    });
    return seconds;
  }
  // The variant and reason confirm a staged rollout reached this person; the
  // attribute *names* say which rules could have applied at all, and carry none
  // of their values.
  logStructuredEvent(env, "debug", "control_tower_refresh_flag_resolved", {
    user_id: subject.userId,
    workspace_id: subject.workspaceId,
    flag_key: CONTROL_TOWER_REFRESH_FLAG_KEY,
    attributes: Object.keys(attributes).sort(),
    variant: details.variant,
    reason: details.reason,
    refresh_seconds: seconds,
  });
  return seconds;
}
