import { RegionSchema } from "@rally/contracts/regions";
import type { Region } from "@rally/contracts/regions";
import { IdSchema } from '@rally/contracts';
import { TelemetryEnvelopeSchema, type TelemetryEnvelope } from "@rally/contracts/telemetry";
import { z } from "zod";
import { TelemetryCollector, type TelemetryAcceptanceResult } from "./collector";
import type { Env } from "../env";
import { ensurePersonAnalyticsId, ensureWorkspaceAnalyticsId } from './authenticated';

const AnonymousTelemetryProjectionSchema = z.strictObject({
  event: TelemetryEnvelopeSchema,
  route: RegionSchema,
  routingBasis: z.enum(["ip_geolocation", "geolocation_fallback"]),
  analyticsSubjectId: z.string().uuid(),
  subjectUserId: z.null(),
  workspaceAnalyticsId: z.null(),
});

export interface AnonymousTelemetryProjection {
  event: TelemetryEnvelope;
  route: Region;
  routingBasis: "ip_geolocation" | "geolocation_fallback";
  analyticsSubjectId: string;
  subjectUserId: null;
  workspaceAnalyticsId: null;
}

export interface RegionalTelemetryBridgeRpcBinding {
  acceptAnonymous(input: unknown): Promise<TelemetryAcceptanceResult>;
  acceptApiOutcome(input: unknown): Promise<TelemetryAcceptanceResult>;
}

const ApiOutcomeProjectionSchema = z.strictObject({
  event: TelemetryEnvelopeSchema,
  route: RegionSchema,
  subjectUserId: IdSchema,
  workspaceId: IdSchema.nullable(),
});

export async function acceptAnonymousTelemetryProjection(
  env: Env,
  input: unknown,
): Promise<TelemetryAcceptanceResult> {
  const parsed = AnonymousTelemetryProjectionSchema.parse(input);
  return new TelemetryCollector(env).accept(parsed.event as TelemetryEnvelope, parsed);
}

export async function acceptApiOutcomeProjection(
  env: Env,
  input: unknown,
): Promise<TelemetryAcceptanceResult> {
  const parsed = ApiOutcomeProjectionSchema.parse(input);
  if (parsed.event.source !== 'api' || parsed.event.context.region !== env.AVALON_REGION) {
    throw new Error('telemetry_api_projection_forbidden');
  }
  const personAnalyticsId = await ensurePersonAnalyticsId(env, parsed.subjectUserId);
  const workspaceAnalyticsId = parsed.workspaceId && parsed.event.identityScope === 'workspace-user'
    ? await ensureWorkspaceAnalyticsId(env, parsed.workspaceId)
    : null;
  return new TelemetryCollector(env).accept(parsed.event as TelemetryEnvelope, {
    route: env.AVALON_REGION,
    routingBasis: 'explicit_selection',
    analyticsSubjectId: personAnalyticsId,
    subjectUserId: parsed.subjectUserId,
    workspaceAnalyticsId,
  });
}
