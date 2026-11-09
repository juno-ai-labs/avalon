import { z } from "zod";
import {
  canonicalModelIdSchema,
  providerIdSchema,
  type CanonicalModelId,
  type ProviderId,
} from "./canonical-model";

/**
 * Policy order and semantics are versioned; the version string travels into
 * telemetry (LLM Provider Routing PRD §4.2) so a routing-behavior change is
 * distinguishable from a configuration change after the fact.
 */
export const ROUTE_POLICY_VERSION = "provider-router-v1";
export type RoutePolicyVersion = typeof ROUTE_POLICY_VERSION;

const orderedPolicySchema = z
  .strictObject({
    mode: z.literal("ordered"),
    providers: z
      .array(providerIdSchema)
      .min(1)
      .refine(
        (providers) => new Set(providers).size === providers.length,
        "duplicate provider ids in ordered policy",
      ),
  })
  .readonly();

const onlyPolicySchema = z
  .strictObject({
    mode: z.literal("only"),
    provider: providerIdSchema,
  })
  .readonly();

/**
 * `ordered` tries each listed provider in order, skipping unavailable or
 * incapable endpoints. `only` is a hard fence: the marked canonical model is
 * never attempted through another provider. A separately configured fallback
 * model still expands under its own policy (PRD §4.2).
 */
export const providerPolicySchema = z.discriminatedUnion("mode", [
  orderedPolicySchema,
  onlyPolicySchema,
]);

export type ProviderPolicy = z.infer<typeof providerPolicySchema>;

/**
 * The checked-in route registry. It contains policy only — never endpoints,
 * deployment names, credentials, prices, quota, or tenant-specific values.
 *
 * Naming note: the PRD draft called the bound default `azureBoundDefault`.
 * The harness is provider-agnostic, so the registry generalizes it to
 * `boundDefault`, applied when the host reports at least one provider
 * binding for the model (see `resolveProviderPolicy`).
 */
export const modelRouteRegistrySchema = z
  .strictObject({
    version: z.literal(ROUTE_POLICY_VERSION),
    /** Used when a model has no explicit policy and no provider binding. */
    unboundDefault: providerPolicySchema,
    /** Used when a model has no explicit policy but has ≥1 provider binding. */
    boundDefault: providerPolicySchema,
    /** Keys are canonical model ids; parsing rejects deployment names. */
    models: z.record(canonicalModelIdSchema, providerPolicySchema),
  })
  .readonly();

export type ModelRouteRegistry = z.infer<typeof modelRouteRegistrySchema>;

/**
 * Parse and freeze a checked-in registry object at module initialization.
 * `satisfies` on the literal is not a runtime-validation substitute
 * (PRD §4.2) — hosts must call this on their checked-in object.
 */
export function parseModelRouteRegistry(input: unknown): ModelRouteRegistry {
  const registry = modelRouteRegistrySchema.parse(input);
  for (const policy of Object.values(registry.models)) {
    if (policy.mode === "ordered") Object.freeze(policy.providers);
    Object.freeze(policy);
  }
  Object.freeze(registry.models);
  return Object.freeze(registry);
}

/**
 * Policy precedence (PRD §4.2): exact canonical-model entry, then the bound
 * default when the host reports a provider binding for this model, then the
 * unbound default. An explicit policy always wins — in particular, an
 * explicit single-provider model does not become bound-first merely because
 * a binding is later added.
 *
 * `boundProviders` is the host's report of which providers have an explicit
 * binding for this model (e.g. an Azure deployment mapping). A catch-all
 * transport that serves every model without per-model configuration should
 * not be reported as a binding.
 */
export function resolveProviderPolicy(
  registry: ModelRouteRegistry,
  model: CanonicalModelId,
  boundProviders: ReadonlySet<ProviderId>,
): ProviderPolicy {
  const explicit = registry.models[model];
  if (explicit !== undefined) return explicit;
  return boundProviders.size > 0 ? registry.boundDefault : registry.unboundDefault;
}

/** The provider order a policy prescribes; `only` is a single-entry order. */
export function policyProviderOrder(policy: ProviderPolicy): readonly ProviderId[] {
  switch (policy.mode) {
    case "ordered":
      return policy.providers;
    case "only":
      return [policy.provider];
    default: {
      const _exhaustive: never = policy;
      throw new Error(`unknown policy mode: ${JSON.stringify(_exhaustive)}`);
    }
  }
}
