import type { CanonicalModelId, ProviderId } from "./canonical-model";
import {
  ROUTE_POLICY_VERSION,
  policyProviderOrder,
  type ProviderPolicy,
} from "./policy";
import type {
  InferenceCapability,
  InferenceRequirements,
  RouteCandidate,
  RoutePlan,
  RouteSkip,
  RouteStage,
} from "./plan";
import type { PlannerTransport } from "./transport";

export interface RoutePlanRequest {
  readonly primaryModel: CanonicalModelId;
  /** A distinct fallback canonical model, or null. Equal to primary is ignored. */
  readonly fallbackModel: CanonicalModelId | null;
  readonly requirements: InferenceRequirements;
  /**
   * Policy resolution per canonical model — typically
   * `resolveProviderPolicy(registry, model, boundProviders)` partially
   * applied by the host. Injected as a function so the planner never reads
   * configuration itself.
   */
  readonly policyFor: (model: CanonicalModelId) => ProviderPolicy;
  /**
   * Composed transport registry. Map lookup by the provider ids the policy
   * names — registration/iteration order never determines priority
   * (PRD §4.3).
   */
  readonly transports: ReadonlyMap<ProviderId, PlannerTransport>;
}

export interface RoutePlanResult {
  readonly plan: RoutePlan;
  /** Configuration/capability omissions recorded while planning (PRD §7.1). */
  readonly skips: readonly RouteSkip[];
}

/**
 * Deterministically expand a canonical primary/fallback selection into an
 * immutable, ordered route plan (LLM Provider Routing PRD §5.1). The only
 * ordering inputs are the two model stages and each stage's policy provider
 * order. Identical `(provider, invocation model)` endpoints are de-duplicated
 * across the whole plan, first occurrence wins.
 */
export function buildRoutePlan(request: RoutePlanRequest): RoutePlanResult {
  const { plan, skips } = planRoute(request);
  return { plan, skips };
}

/** Also identify stages that had no viable endpoint before deduplication. */
export function planRoute(request: RoutePlanRequest): RoutePlanResult & {
  readonly unavailableStages: readonly RouteStage[];
} {
  const skips: RouteSkip[] = [];
  const seenEndpoints = new Set<string>();

  const stageModels: ReadonlyArray<{
    kind: RouteStage["kind"];
    model: CanonicalModelId;
  }> =
    request.fallbackModel !== null && request.fallbackModel !== request.primaryModel
      ? [
          { kind: "primary", model: request.primaryModel },
          { kind: "fallback_model", model: request.fallbackModel },
        ]
      : [{ kind: "primary", model: request.primaryModel }];

  const stages: RouteStage[] = [];
  const unavailableStages: RouteStage[] = [];
  for (const { kind, model } of stageModels) {
    const policy = request.policyFor(model);
    const candidates: RouteCandidate[] = [];
    let hasViableEndpoint = false;

    for (const providerId of policyProviderOrder(policy)) {
      const transport = request.transports.get(providerId);
      if (transport === undefined) {
        skips.push({
          kind: "transport_unavailable",
          providerId,
          canonicalModelId: model,
          reason: "no transport registered for provider",
        });
        continue;
      }

      const availability = transport.getAvailability();
      if (!availability.available) {
        skips.push({
          kind: "transport_unavailable",
          providerId,
          canonicalModelId: model,
          reason: availability.reason,
        });
        continue;
      }

      const resolution = transport.resolveCandidate(model, request.requirements);
      switch (resolution.kind) {
        case "unserved":
          continue;
        case "skip":
          skips.push(resolution.skip);
          continue;
        case "candidate":
          break;
        default: {
          const _exhaustive: never = resolution;
          throw new Error(`unknown resolution: ${JSON.stringify(_exhaustive)}`);
        }
      }

      const candidate = resolution.candidate;
      const missing = capabilityGaps(candidate, request.requirements);
      if (missing.length > 0) {
        for (const capability of missing) {
          skips.push({
            kind: "unsupported_capability",
            providerId,
            canonicalModelId: model,
            capability,
          });
        }
        continue;
      }

      hasViableEndpoint = true;
      const endpointKey = `${candidate.providerId}\u0000${candidate.providerInvocationModel}`;
      if (seenEndpoints.has(endpointKey)) continue;
      seenEndpoints.add(endpointKey);
      candidates.push(Object.freeze(candidate));
    }

    const stage = Object.freeze({
      kind,
      canonicalModelId: model,
      policy,
      candidates: Object.freeze(candidates),
    });
    stages.push(stage);
    if (!hasViableEndpoint) unavailableStages.push(stage);
  }

  const plan: RoutePlan = Object.freeze({
    policyVersion: ROUTE_POLICY_VERSION,
    requirements: request.requirements,
    stages: Object.freeze(stages),
  });

  return { plan, skips: Object.freeze(skips), unavailableStages };
}

function capabilityGaps(
  candidate: RouteCandidate,
  requirements: InferenceRequirements,
): readonly InferenceCapability[] {
  const missing: InferenceCapability[] = [];
  for (const capability of requirements.capabilities) {
    if (!candidate.capabilities.has(capability)) missing.push(capability);
  }
  if (
    requirements.requestedMaxCompletionTokens !== null &&
    candidate.maxCompletionTokens !== null &&
    requirements.requestedMaxCompletionTokens > candidate.maxCompletionTokens
  ) {
    missing.push("max_completion_tokens");
  }
  return missing;
}
