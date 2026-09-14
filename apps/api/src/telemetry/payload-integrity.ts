import type { Region } from "@rally/contracts/regions";
import { sha256 } from "../lib/crypto";

export interface TelemetryPayloadIdentity {
  route: Region;
  analyticsSubjectId: string;
  subjectUserId: string | null;
  workspaceAnalyticsId: string | null;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

export function canonicalTelemetryJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export async function telemetryPayloadHash(
  envelope: unknown,
  identity: TelemetryPayloadIdentity,
): Promise<string> {
  return sha256(canonicalTelemetryJson({
    envelope,
    route: identity.route,
    analyticsSubjectId: identity.analyticsSubjectId,
    subjectUserId: identity.subjectUserId,
    workspaceAnalyticsId: identity.workspaceAnalyticsId,
  }));
}
