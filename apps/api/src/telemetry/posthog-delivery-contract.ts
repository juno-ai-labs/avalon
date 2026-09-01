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

export type PostHogDeliveryResult = {
  result: "delivered" | "retry" | "terminal";
  /** Provider diagnostic only; callers never use it for delivery decisions. */
  requestId: string | null;
  retryAfterMs: number | null;
};

/** Treats private-binding transport/runtime rejection like a retryable provider failure. */
export async function postHogDeliveryRpcCall(
  call: () => Promise<PostHogDeliveryResult>,
): Promise<PostHogDeliveryResult> {
  try {
    return await call();
  } catch {
    return { result: "retry", requestId: null, retryAfterMs: null };
  }
}

/** Global-only, non-HTTP Service Binding contract for PostHog delivery. */
export interface PostHogDeliveryRpcBinding {
  sendTelemetryBatch(input: {
    host: string;
    projectToken: string;
    webBaseUrl: string;
    rows: GlobalTelemetryDeliveryRow[];
  }): Promise<PostHogDeliveryResult>;
  sendJavascriptExceptionBatch(input: {
    host: string;
    projectToken: string;
    rows: GlobalTelemetryDeliveryRow[];
  }): Promise<PostHogDeliveryResult>;
  sendCrashBatch(input: {
    host: string;
    projectToken: string;
    rows: GlobalCrashDeliveryRow[];
  }): Promise<PostHogDeliveryResult>;
  sendProfileBatch(input: {
    host: string;
    projectToken: string;
    rows: GlobalProfileDeliveryRow[];
  }): Promise<PostHogDeliveryResult>;
}
