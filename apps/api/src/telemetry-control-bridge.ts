import { WorkerEntrypoint } from 'cloudflare:workers';
import type { Env } from './env';
import {
  authorizeEuJourneyLink,
  closeEuJourney,
  mutateCanonicalTelemetryPreference,
} from './telemetry/control';

/** Regional-to-Global telemetry control-plane entrypoint. Each method has its own
 * strict projection and returns no Global identity or destination data. */
export class TelemetryControlBridge extends WorkerEntrypoint<Env> {
  mutatePreference(input: unknown) {
    return mutateCanonicalTelemetryPreference(this.env, input);
  }

  authorizeJourneyLink(input: unknown) {
    return authorizeEuJourneyLink(this.env, input);
  }

  closeJourney(input: unknown) {
    return closeEuJourney(this.env, input);
  }
}
