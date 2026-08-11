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
 * a mistyped value all resolve to off.
 *
 * **Who gets a feature is a Flagship targeting rule, never a condition in this
 * file.** This module's whole job is to describe the person accurately enough
 * for those rules to be written against, and to fail closed when it cannot. A
 * cohort encoded here would be invisible from the Flagship console, would need
 * a deploy to change, and would silently override whatever the flag says. See
 * `docs/FEATURE_FLAGS.md` for the rules each flag is provisioned with.
 */

/** Flagship flag key behind Application → Developer. Boolean; defaults to off. */
export const DEVELOPER_SETTINGS_FLAG_KEY = "developer-settings";

interface FlagSubject {
  email: string | null;
  createdAt: string | null;
}

async function flagSubject(env: Env, auth: IdentityAuthContext): Promise<FlagSubject> {
  try {
    const row = await env.DB.prepare("SELECT email, created_at FROM users WHERE id = ?")
      .bind(auth.userId)
      .first<{ email: string | null; created_at: string | null }>();
    return { email: row?.email ?? null, createdAt: row?.created_at ?? null };
  } catch (error) {
    // An unreadable account is not a reason to fail the request, and not a
    // reason to invent attributes either. Evaluation continues with the
    // identity alone, so a rule keyed on an attribute that is missing simply
    // does not match and the flag serves its default.
    logStructuredEvent(env, "warn", "client_flag_subject_unreadable", {
      user_id: auth.userId,
      error_name: error instanceof Error ? error.name : "UnknownError",
    });
    return { email: null, createdAt: null };
  }
}

/** The domain of `email`, lower-cased, or `null` when it has no single one. */
function emailDomain(email: string): string | null {
  const parts = email.trim().toLowerCase().split("@");
  return parts.length === 2 && parts[0] && parts[1] ? parts[1] : null;
}

/**
 * Everything a targeting rule may match a client flag on. Attributes are
 * omitted rather than sent empty, so `when=emailDomain equals …` cannot match
 * an account whose address could not be read.
 *
 * Add an attribute here rather than adding a condition to a resolver: this is
 * the vocabulary every client flag's rules are written in, and it is the whole
 * of what Flagship knows about the person.
 *
 * | Attribute | Value |
 * | --- | --- |
 * | `userId` | The account, and the right key to bucket a percentage rollout by |
 * | `email` | The full address, for targeting one person |
 * | `emailDomain` | Lower-cased domain, for targeting an organization such as staff |
 * | `accountCreatedAt` | ISO timestamp, for targeting by tenure |
 * | `workspaceId` | Present once an organization is chosen |
 * | `workspaceRole` | `owner`, `admin`, or `member`, likewise |
 * | `region` | `global` or `eu` |
 * | `appEnv` | `development`, `test`, `staging`, or `production` |
 */
export function clientFlagEvaluationContext(
  env: Env,
  auth: IdentityAuthContext,
  subject: FlagSubject,
): FlagshipEvaluationContext {
  const domain = subject.email ? emailDomain(subject.email) : null;
  return {
    userId: auth.userId,
    region: env.AVALON_REGION,
    appEnv: env.APP_ENV,
    ...(subject.email ? { email: subject.email.trim().toLowerCase() } : {}),
    ...(domain ? { emailDomain: domain } : {}),
    ...(subject.createdAt ? { accountCreatedAt: subject.createdAt } : {}),
    ...(auth.workspaceId ? { workspaceId: auth.workspaceId } : {}),
    ...(auth.role ? { workspaceRole: auth.role } : {}),
  };
}

/**
 * Evaluate one boolean client flag. Off unless Flagship says otherwise, and
 * never throws: an unavailable binding, an unresolved flag, and a value that
 * is not exactly `true` are all the same answer as a flag that is simply off.
 */
async function resolveBooleanClientFlag(
  env: Env,
  auth: IdentityAuthContext,
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
        user_id: auth.userId,
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
      user_id: auth.userId,
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
  // one that never fired. The domain is logged and the address is not: it is
  // enough to read a cohort rule by, and it identifies nobody.
  logStructuredEvent(env, "debug", "client_flag_resolved", {
    user_id: auth.userId,
    flag_key: flagKey,
    email_domain: context.emailDomain,
    variant: details.variant,
    reason: details.reason,
    enabled,
  });
  return enabled;
}

/**
 * Every client-visible flag, in the shape `GET /feature-flags` returns, all
 * evaluated against one description of the signed-in person.
 */
export async function resolveClientFeatureFlags(
  env: Env,
  auth: IdentityAuthContext,
): Promise<ClientFeatureFlags> {
  const context = clientFlagEvaluationContext(env, auth, await flagSubject(env, auth));
  return {
    developerSettings: await resolveBooleanClientFlag(
      env,
      auth,
      DEVELOPER_SETTINGS_FLAG_KEY,
      context,
    ),
  };
}

/** The Developer section's flag on its own, for a caller that wants only it. */
export async function resolveDeveloperSettingsEnabled(
  env: Env,
  auth: IdentityAuthContext,
): Promise<boolean> {
  return (await resolveClientFeatureFlags(env, auth)).developerSettings;
}
