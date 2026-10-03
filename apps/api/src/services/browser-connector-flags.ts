import { BROWSER_CONNECTABLE_CAPABILITIES_DEFAULT } from "@rally/contracts";
import { z } from "zod";
import type { Env } from "../env";
import { logStructuredEvent } from "../observability/logger";

/**
 * Which connector capabilities the browser may start an authorization for.
 * A JSON flag rather than a Boolean, so it lives outside
 * `client-feature-flags.ts`, which fails every flag closed: this one has no
 * "off". An unbound binding, an unreachable Flagship, a missing flag or a value
 * that is not a list of capability names all serve the launch set, which is
 * the product decision recorded in the full browser client PRD.
 */
export const BROWSER_CONNECTABLE_CAPABILITIES_FLAG_KEY = "browser-connectable-capabilities";

const CapabilityListSchema = z.array(z.string().min(1));

export async function resolveBrowserConnectableCapabilities(
  env: Env,
  userId: string,
  context: FlagshipEvaluationContext,
): Promise<string[]> {
  const fallback = [...BROWSER_CONNECTABLE_CAPABILITIES_DEFAULT];
  const flags = env.FLAGS;
  if (!flags) return fallback;
  try {
    const details = await flags.getObjectDetails(BROWSER_CONNECTABLE_CAPABILITIES_FLAG_KEY, fallback, context);
    const parsed = CapabilityListSchema.safeParse(details.value);
    if (details.errorCode || !parsed.success) {
      logStructuredEvent(env, "warn", "client_flag_unresolved", {
        user_id: userId,
        flag_key: BROWSER_CONNECTABLE_CAPABILITIES_FLAG_KEY,
        reason: details.reason,
        error_code: details.errorCode ?? (parsed.success ? undefined : "invalid_capability_list"),
      });
      return fallback;
    }
    return parsed.data;
  } catch (error) {
    logStructuredEvent(env, env.APP_ENV === "development" || env.APP_ENV === "test" ? "debug" : "warn", "client_flag_unavailable", {
      user_id: userId,
      flag_key: BROWSER_CONNECTABLE_CAPABILITIES_FLAG_KEY,
      error_name: error instanceof Error ? error.name : "UnknownError",
    });
    return fallback;
  }
}
