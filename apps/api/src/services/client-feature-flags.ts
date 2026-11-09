const PUSH_NOTIFICATIONS_FLAG_KEY = "push-notifications-enabled";
import type { ClientFeatureFlags, ProductFeatureFlagKey } from "@rally/contracts";
import type { Env, IdentityAuthContext } from "../env";
import { logStructuredEvent } from "../observability/logger";
import { loadFlagTargetingAttributes } from "./flag-targeting-attributes";

/**
 * The Flagship flags a client is allowed to see, evaluated per signed-in
 * person. `agent-model-flags.ts` is the other reader of `env.FLAGS`; that one
 * decides which model an agent runs on and never leaves the Worker, while
 * these decide what the desktop is allowed to offer. Keeping them apart keeps
 * a client-visible flag from inheriting the model resolver's open default.
 *
 * Every *presentation* flag here fails **closed**. A model flag falls back to
 * the Worker variables because an agent still has to run; a feature nobody has
 * been given yet has nothing it must do, so an unbound binding, an unreachable
 * Flagship, a missing flag, and a mistyped value all resolve to off.
 *
 * The value is served here because this is the one route a client asks for
 * server-decided values. Anything else added with no safe "off" belongs in a
 * module of its own for the same reason, and is served from here the same way.
 *
 * **Who gets a feature is a Flagship targeting rule, never a condition in this
 * file.** A cohort encoded here would be invisible from the Flagship console,
 * would need a deploy to change, and would silently override whatever the flag
 * says. What the rules match on comes from `flag-targeting-attributes.ts`, the
 * same loader the model flags evaluate through — a client flag describes its
 * subject in the one vocabulary rules are already written in, and inherits the
 * boundary that keeps a person's data out of a flag-targeting system. See
 * `docs/feature-flags.md` for the rules each flag is provisioned with.
 */

/**
 * The `ProductFeatureFlagKey` annotation is the whole registration check, and
 * it is why these keys are not bare strings. That type is the enum Ace manages
 * its flags through, so a key missing from it fails `pnpm typecheck` right
 * here, listing the keys that do exist — before any test runs, and long before
 * a deploy. Adding it to the enum then drags the rest along: Ace's catalog is
 * pinned to the enum and its deploy script is pinned to the catalog, and the
 * deploy script is the only thing that creates a flag in Flagship.
 *
 * `multiple-workspaces-enabled` shipped in #464 without any of that and simply
 * did not exist in Flagship — off for everyone, with no operator able to turn
 * it on and nothing failing to say so.
 *
 * `developer-settings` deliberately sits outside Ace as a per-device staff
 * toggle driven through Wrangler. Ace's protocol test allowlists that key.
 */

/** Flagship flag key behind Application → Developer. Boolean; defaults to off. */
export const DEVELOPER_SETTINGS_FLAG_KEY = "developer-settings";
export const SUGGESTED_WORK_FLAG_KEY: ProductFeatureFlagKey = "suggested-work-enabled";
export const MULTIPLE_WORKSPACES_FLAG_KEY: ProductFeatureFlagKey = "multiple-workspaces-enabled";

interface ClientFeatureFlagSubject {
  userId: string;
  workspaceId?: string;
}

/**
 * Evaluate one boolean client flag. Off unless Flagship says otherwise, and
 * never throws: an unavailable binding, an unresolved flag, and a value that
 * is not exactly `true` are all the same answer as a flag that is simply off.
 */
async function resolveBooleanClientFlag(
  env: Env,
  subject: ClientFeatureFlagSubject,
  flagKey: string,
  context: FlagshipEvaluationContext,
): Promise<boolean> {
  const flags = env.FLAGS;
  if (!flags) return false;
  let details: FlagshipEvaluationDetails<boolean>;
  try {
    details = await flags.getBooleanDetails(flagKey, false, context);
  } catch (error) {
    // `wrangler dev --local` binds this always-remote binding as an object
    // whose every call throws `Binding FLAGS needs to be run remotely`, so this
    // is the normal local path and must not warn on every poll.
    logStructuredEvent(
      env,
      env.APP_ENV === "development" || env.APP_ENV === "test" ? "debug" : "warn",
      "client_flag_unavailable",
      {
        user_id: subject.userId,
        flag_key: flagKey,
        error_name: error instanceof Error ? error.name : "UnknownError",
      },
    );
    return false;
  }
  // Flagship answers a missing, disabled, or type-mismatched flag with the
  // default rather than a throw, so `errorCode` is the only thing separating a
  // mistyped key from a flag that is provisioned and off.
  if (details.errorCode) {
    logStructuredEvent(env, "warn", "client_flag_unresolved", {
      user_id: subject.userId,
      flag_key: flagKey,
      reason: details.reason,
      error_code: details.errorCode,
      error_message: details.errorMessage,
    });
    return false;
  }
  const enabled = details.value === true;
  // The variant and reason are what confirm a targeting rule actually matched
  // this person, which is the only way to tell a rule that excluded them from
  // one that never fired. The attribute *names* say whether the fact a rule is
  // written against was even sent — a rule on a missing attribute silently
  // never matches — and the names carry none of the values.
  logStructuredEvent(env, "debug", "client_flag_resolved", {
    user_id: subject.userId,
    flag_key: flagKey,
    attributes: Object.keys(context).sort(),
    variant: details.variant,
    reason: details.reason,
    enabled,
  });
  return enabled;
}

/**
 * Every client-visible flag, in the shape `GET /feature-flags` returns, all
 * evaluated against one description of the signed-in person.
 *
 * The context follows the same shape as an agent evaluation: the attributes
 * `flag-targeting-attributes.ts` loads for the subject, with the caller's
 * identity spread over the top so nothing read from D1 can redefine an id a
 * percentage rollout buckets on. A client flag always knows a `userId` — there
 * is a person asking, which is not true of most agent evaluations — so the
 * `user*` attributes are always available to a rule here.
 */
export async function resolveClientFeatureFlags(
  env: Env,
  auth: IdentityAuthContext,
): Promise<ClientFeatureFlags> {
  return resolveClientFeatureFlagsForSubject(env, {
    userId: auth.userId,
    ...(auth.workspaceId ? { workspaceId: auth.workspaceId } : {}),
  });
}

/** Resolve the same client contract for a socket attachment inside WorkspaceDO. */
export async function resolveClientFeatureFlagsForSubject(
  env: Env,
  subject: ClientFeatureFlagSubject,
): Promise<ClientFeatureFlags> {
  const attributes = await loadFlagTargetingAttributes(env, {
    userId: subject.userId,
    ...(subject.workspaceId ? { workspaceId: subject.workspaceId } : {}),
  });
  const context: FlagshipEvaluationContext = {
    ...attributes,
    region: env.AVALON_REGION,
    appEnv: env.APP_ENV,
    userId: subject.userId,
    ...(subject.workspaceId ? { workspaceId: subject.workspaceId } : {}),
  };
  const [
    developerSettings,
    suggestedWorkEnabled,
    multipleWorkspacesEnabled,
    pushNotificationsEnabled,
  ] = await Promise.all([
    resolveBooleanClientFlag(env, subject, DEVELOPER_SETTINGS_FLAG_KEY, context),
    resolveBooleanClientFlag(env, subject, SUGGESTED_WORK_FLAG_KEY, context),
    resolveBooleanClientFlag(env, subject, MULTIPLE_WORKSPACES_FLAG_KEY, context),
    resolveBooleanClientFlag(env, subject, PUSH_NOTIFICATIONS_FLAG_KEY, context),
  ]);
  return {
    developerSettings,
    suggestedWorkEnabled,
    multipleWorkspacesEnabled,
    pushNotificationsEnabled,
  };
}

export async function resolvePushNotificationsEnabled(env: Env, subject: ClientFeatureFlagSubject): Promise<boolean> {
  const attributes = await loadFlagTargetingAttributes(env, subject);
  return resolveBooleanClientFlag(env, subject, PUSH_NOTIFICATIONS_FLAG_KEY, {
    ...attributes, region: env.AVALON_REGION, appEnv: env.APP_ENV, ...subject,
  });
}
