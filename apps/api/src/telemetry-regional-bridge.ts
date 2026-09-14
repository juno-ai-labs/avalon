import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "./env";
import { acceptAnonymousTelemetryProjection, acceptApiOutcomeProjection } from "./telemetry/regional-bridge";

/** Exact Cross-deployment projection for already-routed anonymous onboarding events. */
export class TelemetryRegionalBridge extends WorkerEntrypoint<Env> {
  acceptAnonymous(input: unknown) {
    return acceptAnonymousTelemetryProjection(this.env, input);
  }

  acceptApiOutcome(input: unknown) {
    return acceptApiOutcomeProjection(this.env, input);
  }
}
