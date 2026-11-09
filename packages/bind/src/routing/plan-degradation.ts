import type { CanonicalModelId } from "./canonical-model";
import type { RouteSkip } from "./plan";
import {
  buildRoutePlan,
  planRoute,
  type RoutePlanRequest,
  type RoutePlanResult,
} from "./planner";
import { policyProviderOrder, type ProviderPolicy } from "./policy";

/**
 * Configuration-degradation wrapper around the harness planner.
 *
 * Policy: even when a provider has priority over the default (an explicit
 * `only` fence or an ordered policy naming it first), **missing keys or
 * configuration must never make inference unavailable** — the call degrades
 * to the default provider and the caller logs an error. This keeps
 * development environments that hold only an OpenRouter key fully working
 * while a checked-in policy prioritizes (say) Azure, and keeps production
 * serving through a provider-config regression instead of hard-failing.
 *
 * Scope: PLAN-TIME emptiness only — a stage with zero attemptable candidates
 * (transport unconfigured/invalid, no binding for the model, capability
 * mismatch). A viable endpoint can already belong to an earlier stage after
 * deduplication. Runtime failures keep the fence semantics: a configured `only`
 * provider that errors at request time is never retried through another
 * provider; the executor's cross-provider traversal applies only
 * within the plan the policy allowed.
 */

export interface DegradedStage {
  readonly model: CanonicalModelId;
  /** The policy that produced an empty stage. */
  readonly fromPolicy: ProviderPolicy;
  /** Plan skips recorded for this model under the original policy. */
  readonly skips: readonly RouteSkip[];
}

export interface DegradedPlanResult extends RoutePlanResult {
  /** Stages rebuilt under the degraded default; empty when nothing degraded. */
  readonly degraded: readonly DegradedStage[];
}

function policiesEqual(a: ProviderPolicy, b: ProviderPolicy): boolean {
  const aOrder = policyProviderOrder(a);
  const bOrder = policyProviderOrder(b);
  return (
    a.mode === b.mode &&
    aOrder.length === bOrder.length &&
    aOrder.every((provider, index) => provider === bOrder[index])
  );
}

export function buildRoutePlanWithConfigDegradation(
  request: RoutePlanRequest,
  degradedPolicy: ProviderPolicy,
): DegradedPlanResult {
  const first = planRoute(request);

  const emptyStagePolicies = new Map<CanonicalModelId, ProviderPolicy>();
  for (const stage of first.unavailableStages) {
    if (!policiesEqual(stage.policy, degradedPolicy)) {
      emptyStagePolicies.set(stage.canonicalModelId, stage.policy);
    }
  }
  if (emptyStagePolicies.size === 0) {
    return { plan: first.plan, skips: first.skips, degraded: [] };
  }

  // Deterministic rebuild: identical inputs except the empty stages' models
  // now resolve to the degraded default policy. If the default provider is
  // ALSO unavailable (e.g. no OpenRouter key at all) the rebuilt stage stays
  // empty and the caller's no-viable-endpoint handling applies unchanged.
  const second = buildRoutePlan({
    ...request,
    policyFor: (model) =>
      emptyStagePolicies.get(model) !== undefined
        ? degradedPolicy
        : request.policyFor(model),
  });

  const degraded = [...emptyStagePolicies.entries()].map(
    ([model, fromPolicy]): DegradedStage => ({
      model,
      fromPolicy,
      skips: first.skips.filter((skip) => skip.canonicalModelId === model),
    }),
  );
  return { plan: second.plan, skips: second.skips, degraded };
}
