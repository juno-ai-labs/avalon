import { describe, expect, it } from "vitest";
import {
  canonicalModelIdSchema,
  providerIdSchema,
  planIsEmpty,
  type CanonicalModelId,
  type InferenceRequirements,
  type PlannerTransport,
  type ProviderId,
  type ProviderPolicy,
  type RouteCandidate,
} from "../index";
import { buildRoutePlanWithConfigDegradation } from "../plan-degradation";

const MODEL = canonicalModelIdSchema.parse("openai/gpt-example");
const FALLBACK_MODEL = canonicalModelIdSchema.parse("openai/fallback-model");
const AZURE = providerIdSchema.parse("azure");
const OPENROUTER = providerIdSchema.parse("openrouter");

const DEFAULT_POLICY: ProviderPolicy = { mode: "only", provider: OPENROUTER };

const REQUIREMENTS: InferenceRequirements = {
  capabilities: new Set(["chat_completions", "streaming"]),
  requestedMaxCompletionTokens: null,
};

function candidate(provider: ProviderId, model: CanonicalModelId): RouteCandidate {
  return {
    providerId: provider,
    canonicalModelId: model,
    providerInvocationModel: String(model),
    credentialSource: "platform",
    creditEligible: false,
    capabilities: new Set(["chat_completions", "streaming"]),
    maxCompletionTokens: null,
    pricingBasis: { kind: "provider_reported" },
    bindingFingerprint: "test",
  };
}

function serving(provider: ProviderId): PlannerTransport {
  return {
    id: provider,
    getAvailability: () => ({ available: true }),
    resolveCandidate: (model) => ({ kind: "candidate", candidate: candidate(provider, model) }),
  };
}

function unconfigured(provider: ProviderId): PlannerTransport {
  return {
    id: provider,
    getAvailability: () => ({ available: false, reason: "missing keys" }),
    resolveCandidate: () => ({ kind: "unserved" }),
  };
}

function request(
  policy: ProviderPolicy,
  transports: readonly PlannerTransport[],
  fallbackModel: CanonicalModelId | null = null,
) {
  return {
    primaryModel: MODEL,
    fallbackModel,
    requirements: REQUIREMENTS,
    policyFor: (model: CanonicalModelId) =>
      model === MODEL ? policy : DEFAULT_POLICY,
    transports: new Map(transports.map((transport) => [transport.id, transport])),
  };
}

describe("buildRoutePlanWithConfigDegradation", () => {
  it("degrades an `only` fence to the default when the fenced provider is unconfigured", () => {
    const result = buildRoutePlanWithConfigDegradation(
      request({ mode: "only", provider: AZURE }, [unconfigured(AZURE), serving(OPENROUTER)]),
      DEFAULT_POLICY,
    );
    expect(result.degraded).toHaveLength(1);
    expect(result.degraded[0]?.model).toBe(MODEL);
    expect(result.degraded[0]?.fromPolicy).toEqual({ mode: "only", provider: AZURE });
    expect(result.degraded[0]?.skips[0]?.kind).toBe("transport_unavailable");
    expect(result.plan.stages[0]?.candidates.map((c) => c.providerId)).toEqual([
      OPENROUTER,
    ]);
  });

  it("does not degrade an ordered policy that already reaches the default provider", () => {
    const result = buildRoutePlanWithConfigDegradation(
      request(
        { mode: "ordered", providers: [AZURE, OPENROUTER] },
        [unconfigured(AZURE), serving(OPENROUTER)],
      ),
      DEFAULT_POLICY,
    );
    expect(result.degraded).toHaveLength(0);
    expect(result.plan.stages[0]?.candidates.map((c) => c.providerId)).toEqual([
      OPENROUTER,
    ]);
  });

  it("respects the fence when the fenced provider is configured", () => {
    const result = buildRoutePlanWithConfigDegradation(
      request({ mode: "only", provider: AZURE }, [serving(AZURE), serving(OPENROUTER)]),
      DEFAULT_POLICY,
    );
    expect(result.degraded).toHaveLength(0);
    expect(result.plan.stages[0]?.candidates.map((c) => c.providerId)).toEqual([AZURE]);
  });

  it("degrades a fenced model whose provider serves but has no binding for it", () => {
    const azureWithoutBinding: PlannerTransport = {
      id: AZURE,
      getAvailability: () => ({ available: true }),
      resolveCandidate: () => ({ kind: "unserved" }),
    };
    const result = buildRoutePlanWithConfigDegradation(
      request({ mode: "only", provider: AZURE }, [azureWithoutBinding, serving(OPENROUTER)]),
      DEFAULT_POLICY,
    );
    expect(result.degraded).toHaveLength(1);
    expect(result.plan.stages[0]?.candidates.map((c) => c.providerId)).toEqual([
      OPENROUTER,
    ]);
  });

  it("degrades only the empty stage, leaving the healthy fallback stage alone", () => {
    const result = buildRoutePlanWithConfigDegradation(
      request(
        { mode: "only", provider: AZURE },
        [unconfigured(AZURE), serving(OPENROUTER)],
        FALLBACK_MODEL,
      ),
      DEFAULT_POLICY,
    );
    expect(result.degraded).toHaveLength(1);
    expect(result.plan.stages).toHaveLength(2);
    expect(result.plan.stages[0]?.candidates.map((c) => c.providerId)).toEqual([
      OPENROUTER,
    ]);
    expect(result.plan.stages[1]?.candidates.map((c) => c.providerId)).toEqual([
      OPENROUTER,
    ]);
  });

  it("leaves the plan empty when the default provider is also unconfigured", () => {
    const result = buildRoutePlanWithConfigDegradation(
      request({ mode: "only", provider: AZURE }, [
        unconfigured(AZURE),
        unconfigured(OPENROUTER),
      ]),
      DEFAULT_POLICY,
    );
    expect(result.degraded).toHaveLength(1);
    expect(planIsEmpty(result.plan)).toBe(true);
  });

  it("never rebuilds a stage already under the default policy", () => {
    const result = buildRoutePlanWithConfigDegradation(
      request(DEFAULT_POLICY, [unconfigured(OPENROUTER)]),
      DEFAULT_POLICY,
    );
    expect(result.degraded).toHaveLength(0);
    expect(planIsEmpty(result.plan)).toBe(true);
  });
});
