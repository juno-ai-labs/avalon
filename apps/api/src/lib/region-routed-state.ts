import type { Region } from "@rally/contracts";
import { ApiError } from "./api-error";

/**
 * OAuth state for a provider that accepts one callback URL across both regions.
 *
 * Such a callback lands on the Global ingress with nothing but `state` to say
 * which region started the attempt: the provider knows only its own tenant, and
 * Global deliberately holds no copy of the pending authorization. Prefixing the
 * region keeps the unpredictable half in the originating region's D1 — Global
 * never sees the verifier, the capabilities, or the workspace — and exposes only
 * the routing decision itself.
 *
 * The prefix is not a secret and is not treated as one. It selects a bridge; the
 * regional service still consumes the state row, and an attacker who edits the
 * prefix reaches a region that has no such row.
 */
export function createRegionRoutedState(region: Region, randomValue: string): string {
  if (!/^[A-Za-z0-9_-]{20,}$/u.test(randomValue)) {
    throw new Error("Region-routed state entropy is invalid");
  }
  return `${region}.${randomValue}`;
}

export function regionFromRoutedState(state: string, label: string): Region {
  const match = /^(global|eu)\.[A-Za-z0-9_-]{20,}$/u.exec(state);
  if (!match) {
    throw new ApiError(401, "invalid_oauth_state", `${label} state is invalid or expired`);
  }
  return match[1] as Region;
}
