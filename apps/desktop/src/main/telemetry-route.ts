import type { Region } from "@rally/contracts/regions";
import { TelemetryBootstrapResponseSchema, type TelemetryBootstrapResponse } from '@rally/contracts';

export interface ResolvedTelemetryRoute {
  route: Region;
  basis: 'explicit_binding' | 'ip_geolocation' | 'geolocation_fallback';
  anonymous: TelemetryBootstrapResponse | null;
}

export async function resolveTelemetryRoute(input: {
  explicitRegion: Region | null;
  anonymousEpochId: string;
  globalApiBaseUrl: string;
  fetch: typeof globalThis.fetch;
  timeoutMs?: number;
}): Promise<ResolvedTelemetryRoute> {
  if (input.explicitRegion) {
    return { route: input.explicitRegion, basis: 'explicit_binding', anonymous: null };
  }
  try {
    const response = await input.fetch(`${input.globalApiBaseUrl}/telemetry/bootstrap`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ anonymousEpochId: input.anonymousEpochId }),
      signal: AbortSignal.timeout(input.timeoutMs ?? 2_000),
    });
    if (!response.ok) throw new Error('telemetry_bootstrap_rejected');
    const anonymous = TelemetryBootstrapResponseSchema.parse(await response.json());
    return { route: anonymous.route, basis: anonymous.routingBasis, anonymous };
  } catch {
    return { route: 'global', basis: 'geolocation_fallback', anonymous: null };
  }
}

export async function refreshTelemetryCapability(input: {
  current: ResolvedTelemetryRoute;
  anonymousEpochId: string;
  globalApiBaseUrl: string;
  fetch: typeof globalThis.fetch;
  timeoutMs?: number;
}): Promise<TelemetryBootstrapResponse | null> {
  if (!input.current.anonymous) return null;
  try {
    const response = await input.fetch(`${input.globalApiBaseUrl}/telemetry/bootstrap`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ anonymousEpochId: input.anonymousEpochId }),
      signal: AbortSignal.timeout(input.timeoutMs ?? 2_000),
    });
    if (!response.ok) return null;
    const refreshed = TelemetryBootstrapResponseSchema.parse(await response.json());
    if (
      refreshed.journeyId !== input.current.anonymous.journeyId
      || refreshed.route !== input.current.route
      || refreshed.routingBasis !== input.current.anonymous.routingBasis
    ) return null;
    return refreshed;
  } catch {
    return null;
  }
}
