import type { TelemetryEnvelope } from "@rally/contracts/telemetry";

export interface GlobalTelemetryDeliveryRow {
  eventId: string;
  envelope: TelemetryEnvelope;
  analyticsSubjectId: string;
  workspaceAnalyticsId: string | null;
  normalizedTimestamp: string;
  /** Regionally resolved application locations. Source contents and paths are never included. */
  symbolicatedFrames?: string[];
}

export interface GlobalCrashDeliveryRow {
  crashId: string;
  deviceId: string;
  analyticsSubjectId: string;
  workspaceAnalyticsId: string | null;
  processPersonProfile: boolean;
  receivedAt: string;
  release: string;
  buildId: string;
  platform: "darwin" | "win32" | "linux";
  architecture: "arm64" | "x64";
  processRole: "main" | "renderer" | "utility" | "gpu" | "unknown";
  launchId: string;
  channel: "development" | "alpha" | "beta" | "stable";
  parserState: "symbolicated" | "unsymbolicated" | "malformed";
  fingerprint: string;
  report: unknown;
}

export interface GlobalProfileDeliveryRow {
  jobId: string;
  kind: "epoch_transition" | "person_profile" | "group_profile";
  destinationAnalyticsId: string;
  anonymousEpochId: string | null;
  properties: Record<string, string>;
  createdAt: string;
}

export type TelemetryDestinationResult = {
  result: "delivered" | "retry" | "terminal";
  /** Provider diagnostic only; callers never use it for delivery decisions. */
  requestId: string | null;
  retryAfterMs: number | null;
};

/**
 * One independent outcome per destination attempted by the delivery Worker.
 * Adding a destination widens this object instead of creating another Worker
 * or collapsing unrelated retry lifecycles into one aggregate status.
 */
export interface TelemetryDeliveryRpcResult {
  postHog: TelemetryDestinationResult;
}

/** Treats private-binding transport/runtime rejection like retryable failure of every attempted destination. */
export async function telemetryDeliveryRpcCall(
  call: () => Promise<TelemetryDeliveryRpcResult>,
): Promise<TelemetryDeliveryRpcResult> {
  try {
    return await call();
  } catch {
    return {
      postHog: { result: "retry", requestId: null, retryAfterMs: null },
    };
  }
}

/**
 * Global-only, non-HTTP telemetry destination contract. Operations stay
 * explicit and typed; this is not an arbitrary event or provider-command API.
 */
export interface TelemetryDeliveryRpcBinding {
  deliverTelemetryBatch(input: {
    host: string;
    projectToken: string;
    webBaseUrl: string;
    rows: GlobalTelemetryDeliveryRow[];
  }): Promise<TelemetryDeliveryRpcResult>;
  deliverJavascriptExceptionBatch(input: {
    host: string;
    projectToken: string;
    rows: GlobalTelemetryDeliveryRow[];
  }): Promise<TelemetryDeliveryRpcResult>;
  deliverCrashBatch(input: {
    host: string;
    projectToken: string;
    rows: GlobalCrashDeliveryRow[];
  }): Promise<TelemetryDeliveryRpcResult>;
  deliverProfileBatch(input: {
    host: string;
    projectToken: string;
    rows: GlobalProfileDeliveryRow[];
  }): Promise<TelemetryDeliveryRpcResult>;
}
