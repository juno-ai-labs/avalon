import type { ClientFeatureFlags } from "@avalon/contracts";
import type { Env, IdentityAuthContext } from "../env";
import { logStructuredEvent } from "../observability/logger";

/**
 * The Flagship flags a client is allowed to see, evaluated per signed-in
 * person. `agent-model-flags.ts` is the other reader of `env.FLAGS`; that one
 * decides which model an agent runs on and never leaves the Worker, while
 * these decide what the desktop is allowed to offer. Keeping them apart keeps
 * a client-visible flag from inheriting the model resolver's open default.
 *
 * Every flag here fails **closed**. A model flag falls back to the Worker
 * variables because an agent still has to run; a client flag has nothing it
 * must do, so an unbound binding, an unreachable Flagship, a missing flag, and
 * a mistyped value all resolve to off. See `docs/FEATURE_FLAGS.md`.
 */

/** Flagship flag key behind Application → Developer. Boolean; defaults to off. */
export const DEVELOPER_SETTINGS_FLAG_KEY = "developer-settings";

/**
 * The one email domain the Developer section may ever be offered to. This is a
 * property of the product, not of whoever last edited the flag: the flag can
 * withdraw the section from Juno staff, or stage its rollout among them, but it
 * can never hand it to a customer. Enforced here so a mis-scoped targeting rule
 * is inert rather than a release.
 */
export const DEVELOPER_SETTINGS_EMAIL_DOMAIN = "juno-labs.com";

/** The domain of `email`, lower-cased, or `null` when it has no single one. */
function emailDomain(email: string): string | null {
  const parts = email.trim().toLowerCase().split("@");
  return parts.length === 2 && parts[0] && parts[1] ? parts[1] : null;
}

/** Whether `email` belongs to the staff domain the Developer section is scoped to. */
export function developerSettingsEligibleEmail(email: string | null | undefined): boolean {
  return email ? emailDomain(email) === DEVELOPER_SETTINGS_EMAIL_DOMAIN : false;
}

async function signedInEmail(env: Env, userId: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT email FROM users WHERE id = ?")
    .bind(userId)
    .first<{ email: string | null }>();
  return row?.email ?? null;
}

/**
 * Whether Application → Developer may be offered to this person.
 *
 * Two gates, in this order: the account has to sit on the staff email domain,
 * and the flag has to be on for them. The first is checked before Flagship is
 * called at all, so an ineligible account cannot be reached by a targeting
 * rule, and its address never enters an evaluation context.
 *
 * Never throws — a flag failure is reported as off, the same as a flag that is
 * genuinely off, because there is nothing here worth failing a request over.
 */
export async function resolveDeveloperSettingsEnabled(
  env: Env,
  auth: IdentityAuthContext,
): Promise<boolean> {
  let email: string | null;
  try {
    email = await signedInEmail(env, auth.userId);
  } catch (error) {
    logStructuredEvent(env, "warn", "developer_settings_flag_unresolved", {
      user_id: auth.userId,
      reason: "account_unreadable",
      error_name: error instanceof Error ? error.name : "UnknownError",
    });
    return false;
  }
  if (!developerSettingsEligibleEmail(email)) return false;

  const flags = env.FLAGS;
  if (!flags) return false;
  const context = {
    region: env.AVALON_REGION,
    appEnv: env.APP_ENV,
    userId: auth.userId,
    emailDomain: DEVELOPER_SETTINGS_EMAIL_DOMAIN,
    ...(auth.workspaceId ? { workspaceId: auth.workspaceId } : {}),
  };
  let details: FlagshipEvaluationDetails<boolean>;
  try {
    details = await flags.getBooleanDetails(DEVELOPER_SETTINGS_FLAG_KEY, false, context);
  } catch (error) {
    // `wrangler dev --local` binds this always-remote binding as an object
    // whose every call throws `Binding FLAGS needs to be run remotely`, so this
    // is the normal local path and must not warn on every poll.
    logStructuredEvent(
      env,
      env.APP_ENV === "development" || env.APP_ENV === "test" ? "debug" : "warn",
      "developer_settings_flag_unavailable",
      {
        user_id: auth.userId,
        flag_key: DEVELOPER_SETTINGS_FLAG_KEY,
        error_name: error instanceof Error ? error.name : "UnknownError",
      },
    );
    return false;
  }
  // Flagship answers a missing, disabled, or type-mismatched flag with the
  // default rather than a throw, so `errorCode` is the only thing separating a
  // mistyped key from a flag that is provisioned and off.
  if (details.errorCode) {
    logStructuredEvent(env, "warn", "developer_settings_flag_unresolved", {
      user_id: auth.userId,
      flag_key: DEVELOPER_SETTINGS_FLAG_KEY,
      reason: details.reason,
      error_code: details.errorCode,
      error_message: details.errorMessage,
    });
    return false;
  }
  const enabled = details.value === true;
  logStructuredEvent(env, "debug", "developer_settings_flag_resolved", {
    user_id: auth.userId,
    flag_key: DEVELOPER_SETTINGS_FLAG_KEY,
    variant: details.variant,
    reason: details.reason,
    enabled,
  });
  return enabled;
}

/** Every client-visible flag, in the shape `GET /feature-flags` returns. */
export async function resolveClientFeatureFlags(
  env: Env,
  auth: IdentityAuthContext,
): Promise<ClientFeatureFlags> {
  return { developerSettings: await resolveDeveloperSettingsEnabled(env, auth) };
}
