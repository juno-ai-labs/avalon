import type { CanonicalModelId, ProviderId } from "./canonical-model";
import type { InferenceRequirements, RouteCandidate, RouteSkip } from "./plan";

export type TransportAvailability =
  | Readonly<{ available: true }>
  | Readonly<{ available: false; reason: string }>;

/**
 * What a transport reports when the planner asks it for an endpoint:
 * - `candidate` — a concrete, attemptable endpoint.
 * - `skip` — the transport knows about the model but cannot serve it
 *   (malformed binding, capability gap it detects itself); recorded as a
 *   plan diagnostic.
 * - `unserved` — the transport has no knowledge of this model (e.g. no Azure
 *   deployment mapping). Omitted silently, matching PRD §5.1's "wholly
 *   absent configuration is omitted" behavior.
 */
export type CandidateResolution =
  | Readonly<{ kind: "candidate"; candidate: RouteCandidate }>
  | Readonly<{ kind: "skip"; skip: RouteSkip }>
  | Readonly<{ kind: "unserved" }>;

/**
 * The planner-facing surface of an inference transport. This is the harness
 * subset of the PRD's `InferenceTransportContribution` (§4.3): request
 * construction (`createClient` / `buildRequest`) and provider error
 * classification stay with the host's transport adapters, because they
 * depend on the wire client. The planner needs only availability and
 * endpoint resolution.
 */
export interface PlannerTransport {
  readonly id: ProviderId;
  getAvailability(): TransportAvailability;
  resolveCandidate(
    model: CanonicalModelId,
    requirements: InferenceRequirements,
  ): CandidateResolution;
}
