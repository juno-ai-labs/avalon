import type { CanonicalModelId, ProviderId } from "./canonical-model";
import type { ProviderPolicy, RoutePolicyVersion } from "./policy";

/**
 * Capabilities the planner checks before any network request (LLM Provider
 * Routing PRD §5.1/§5.3). `max_completion_tokens` is modeled as a capability
 * (a departure from the PRD draft, which listed the token-ceiling check in
 * §5.3 prose but not in the union) so a ceiling violation produces the same
 * `unsupported_capability` skip shape as any other mismatch.
 */
export const INFERENCE_CAPABILITIES = [
  "chat_completions",
  "streaming",
  "tools",
  "structured_outputs",
  "image_input",
  "reasoning_effort",
  "file_parser_plugin",
  "service_tier",
  "max_completion_tokens",
] as const;

export type InferenceCapability = (typeof INFERENCE_CAPABILITIES)[number];

export type CredentialSource = "platform" | "tenant";

export interface InferenceRequirements {
  readonly capabilities: ReadonlySet<InferenceCapability>;
  readonly requestedMaxCompletionTokens: number | null;
}

/**
 * How a provider reports cached input tokens relative to `prompt_tokens`:
 * `"subset"` — cached tokens are included in the prompt count (OpenAI);
 * `"disjoint"` — cached tokens are reported alongside it and may exceed it
 * (observed live on Grok served through Azure AI Foundry). Declared per
 * binding, never inferred from the relative counts — a disjoint provider can
 * legitimately report cached < prompt, which inference would misprice.
 */
export type CachedTokenSemantics = "subset" | "disjoint";

export type ProviderPricingBasis =
  | Readonly<{ kind: "provider_reported" }>
  | Readonly<{
      kind: "configured_token_rates";
      inputUsdPerM: number;
      cachedInputUsdPerM: number;
      outputUsdPerM: number;
      cachedTokenSemantics: CachedTokenSemantics;
    }>;

/**
 * One concrete endpoint the executor may attempt. Secret-free by contract:
 * no client, API key, base URL, prompt, or tenant secret — safe to inspect
 * in tests and structured diagnostics (PRD §5.1).
 */
export interface RouteCandidate {
  readonly providerId: ProviderId;
  readonly canonicalModelId: CanonicalModelId;
  readonly providerInvocationModel: string;
  readonly credentialSource: CredentialSource;
  readonly creditEligible: boolean;
  readonly capabilities: ReadonlySet<InferenceCapability>;
  /** null means the binding publishes no provider-side completion limit. */
  readonly maxCompletionTokens: number | null;
  readonly pricingBasis: ProviderPricingBasis;
  /** Stable hash/version of non-secret binding data for diagnostics. */
  readonly bindingFingerprint: string;
  /**
   * Optional non-secret credential identity used to scope circuit-breaker
   * state beyond `credentialSource` (e.g. an opaque per-tenant tag for BYOK
   * keys, so one tenant's revoked key never opens the circuit for other
   * tenants). Never key material.
   */
  readonly breakerScope?: string | undefined;
}

export interface RouteStage {
  readonly kind: "primary" | "fallback_model";
  readonly canonicalModelId: CanonicalModelId;
  readonly policy: ProviderPolicy;
  readonly candidates: readonly RouteCandidate[];
}

/**
 * The immutable, versioned route plan built once per logical call and reused
 * across structured-output retries (PRD §5.1). Contains no secrets and no
 * request content.
 */
export interface RoutePlan {
  readonly policyVersion: RoutePolicyVersion;
  readonly requirements: InferenceRequirements;
  readonly stages: readonly RouteStage[];
}

/**
 * A capability/configuration omission recorded at plan time. Skips are
 * planner diagnostics, not failed network attempts (PRD §7.1); `reason` is a
 * controlled internal string, never a raw provider/parser message.
 */
export type RouteSkip =
  | Readonly<{
      kind: "transport_unavailable";
      providerId: ProviderId;
      canonicalModelId: CanonicalModelId;
      reason: string;
    }>
  | Readonly<{
      kind: "unsupported_capability";
      providerId: ProviderId;
      canonicalModelId: CanonicalModelId;
      capability: InferenceCapability;
    }>
  | Readonly<{
      kind: "invalid_binding";
      providerId: ProviderId;
      canonicalModelId: CanonicalModelId;
      reason: string;
    }>;

/** True when no stage has an attemptable candidate. */
export function planIsEmpty(plan: RoutePlan): boolean {
  return plan.stages.every((stage) => stage.candidates.length === 0);
}
