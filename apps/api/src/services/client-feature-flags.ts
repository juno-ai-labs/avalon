import type { ClientFeatureFlags } from "@rally/contracts";
import type { Env, IdentityAuthContext } from "../env";
import { FEATURE_FLAGS, FEATURE_FLAG_ENV_KEYS } from "@rally/contracts/runtime-config";
import { logStructuredEvent } from "../observability/logger";

interface ClientFeatureFlagSubject {
  userId: string;
  workspaceId?: string | null;
}

function resolveBooleanFlag(env: Env, key: keyof ClientFeatureFlags): boolean {
  const variable = FEATURE_FLAG_ENV_KEYS[key];
  const raw = env[variable];
  if (raw === undefined || raw === null) return FEATURE_FLAGS[key];
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : raw;
  if (value === "") return FEATURE_FLAGS[key];
  if (typeof value === "boolean") return value;
  if (value === 1) return true;
  if (value === 0) return false;
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  logStructuredEvent(env, "warn", "feature_flag_override_invalid", { variable });
  return FEATURE_FLAGS[key];
}

/** Kept async for the existing HTTP and socket callers; no external I/O. */
export async function resolveClientFeatureFlags(
  env: Env,
  auth: IdentityAuthContext,
): Promise<ClientFeatureFlags> {
  return resolveClientFeatureFlagsForSubject(env, auth);
}

export async function resolveClientFeatureFlagsForSubject(
  env: Env,
  subject: ClientFeatureFlagSubject,
): Promise<ClientFeatureFlags> {
  void subject; // Existing callers pass identity; configuration is deployment-wide.
  return {
    developerSettings: resolveBooleanFlag(env, "developerSettings"),
    multipleWorkspacesEnabled: resolveBooleanFlag(env, "multipleWorkspacesEnabled"),
    pushNotificationsEnabled: resolveBooleanFlag(env, "pushNotificationsEnabled"),
  };
}

export async function resolvePushNotificationsEnabled(env: Env, subject: ClientFeatureFlagSubject): Promise<boolean> {
  void subject;
  return resolveBooleanFlag(env, "pushNotificationsEnabled");
}
