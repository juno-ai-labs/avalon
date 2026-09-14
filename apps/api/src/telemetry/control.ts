import { RegionSchema } from "@rally/contracts/regions";
import { z } from 'zod';
import type { Env } from '../env';
import { TelemetryBootstrapService } from './bootstrap';
import {
  applyCanonicalPreferenceMutation,
  type CanonicalPreferenceResult,
} from './preference';

const CapabilityCommandSchema = z.strictObject({
  capability: z.string().min(32).max(2_048),
  expectedRoute: RegionSchema,
});

const CapabilityProjectionSchema = z.strictObject({
  route: RegionSchema,
  anonymousEpochId: z.string().uuid(),
  closed: z.boolean(),
});

export type CapabilityProjection = z.infer<typeof CapabilityProjectionSchema>;

/** Regional-to-Global control-plane RPC. None of its commands accepts a platform user
 * id, regional database id, event payload, crash payload, or analytics id. */
export interface GlobalTelemetryControlRpcBinding {
  mutatePreference(input: unknown): Promise<CanonicalPreferenceResult>;
  authorizeJourneyLink(input: unknown): Promise<CapabilityProjection>;
  closeJourney(input: unknown): Promise<void>;
}

export function mutateCanonicalTelemetryPreference(
  env: Env,
  input: unknown,
): Promise<CanonicalPreferenceResult> {
  return applyCanonicalPreferenceMutation(env, input);
}

export async function authorizeEuJourneyLink(env: Env, input: unknown): Promise<CapabilityProjection> {
  const command = CapabilityCommandSchema.parse(input);
  return CapabilityProjectionSchema.parse(
    await new TelemetryBootstrapService(env).authorizeLink(command.capability, command.expectedRoute),
  );
}

export async function closeEuJourney(env: Env, input: unknown): Promise<void> {
  const command = CapabilityCommandSchema.parse(input);
  await new TelemetryBootstrapService(env).closeJourney(command.capability, command.expectedRoute);
}
