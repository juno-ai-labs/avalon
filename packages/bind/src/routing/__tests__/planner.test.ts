import { describe, expect, it } from "vitest";
import { buildRoutePlan } from "../planner";
import { planIsEmpty, type InferenceCapability } from "../plan";
import type { ProviderPolicy } from "../policy";
import {
  cmid,
  pid,
  makeCandidate,
  makeTransport,
  requirements,
  transportMap,
} from "./fixtures";

const PRIMARY = cmid("openai/primary-model");
const FALLBACK = cmid("openai/fallback-model");

const azureFirst: ProviderPolicy = {
  mode: "ordered",
  providers: [pid("azure"), pid("openrouter")],
};

function servingTransport(provider: string, deployment?: string) {
  return makeTransport(provider, (model) => ({
    kind: "candidate",
    candidate: makeCandidate(provider, model, {
      providerInvocationModel: deployment ?? model,
    }),
  }));
}

describe("buildRoutePlan", () => {
  it("expands ordered policy in policy order with per-stage policies", () => {
    const { plan, skips } = buildRoutePlan({
      primaryModel: PRIMARY,
      fallbackModel: FALLBACK,
      requirements: requirements(),
      policyFor: (model) =>
        model === PRIMARY ? azureFirst : { mode: "only", provider: pid("openrouter") },
      transports: transportMap([
        servingTransport("openrouter"),
        servingTransport("azure", "primary-deployment"),
      ]),
    });

    expect(skips).toEqual([]);
    expect(plan.stages).toHaveLength(2);
    expect(plan.stages[0]?.candidates.map((c) => c.providerId)).toEqual([
      pid("azure"),
      pid("openrouter"),
    ]);
    // The fallback model expands under its own policy — the provider-only
    // fence on the fallback keeps azure out of stage 2 (PRD §4.2).
    expect(plan.stages[1]?.candidates.map((c) => c.providerId)).toEqual([
      pid("openrouter"),
    ]);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.stages[0]?.candidates)).toBe(true);
  });

  it("is deterministic: identical inputs produce identical plans", () => {
    const build = () =>
      buildRoutePlan({
        primaryModel: PRIMARY,
        fallbackModel: FALLBACK,
        requirements: requirements(),
        policyFor: () => azureFirst,
        transports: transportMap([
          servingTransport("azure"),
          servingTransport("openrouter"),
        ]),
      });
    expect(build().plan).toEqual(build().plan);
  });

  it("omits an unavailable transport with a transport_unavailable skip", () => {
    const { plan, skips } = buildRoutePlan({
      primaryModel: PRIMARY,
      fallbackModel: null,
      requirements: requirements(),
      policyFor: () => azureFirst,
      transports: transportMap([
        makeTransport("azure", () => ({ kind: "unserved" }), {
          available: false,
          unavailableReason: "partial configuration",
        }),
        servingTransport("openrouter"),
      ]),
    });

    expect(plan.stages[0]?.candidates.map((c) => c.providerId)).toEqual([
      pid("openrouter"),
    ]);
    expect(skips).toEqual([
      {
        kind: "transport_unavailable",
        providerId: pid("azure"),
        canonicalModelId: PRIMARY,
        reason: "partial configuration",
      },
    ]);
  });

  it("records a skip for a policy provider with no registered transport", () => {
    const { plan, skips } = buildRoutePlan({
      primaryModel: PRIMARY,
      fallbackModel: null,
      requirements: requirements(),
      policyFor: () => azureFirst,
      transports: transportMap([servingTransport("openrouter")]),
    });
    expect(plan.stages[0]?.candidates).toHaveLength(1);
    expect(skips[0]?.kind).toBe("transport_unavailable");
  });

  it("skips a capability-incapable candidate before any request", () => {
    const noTools = makeTransport("azure", (model) => ({
      kind: "candidate",
      candidate: makeCandidate("azure", model, {
        capabilities: new Set<InferenceCapability>(["chat_completions", "streaming"]),
      }),
    }));
    const { plan, skips } = buildRoutePlan({
      primaryModel: PRIMARY,
      fallbackModel: null,
      requirements: requirements({
        capabilities: new Set(["chat_completions", "streaming", "tools"]),
      }),
      policyFor: () => azureFirst,
      transports: transportMap([noTools, servingTransport("openrouter")]),
    });

    expect(plan.stages[0]?.candidates.map((c) => c.providerId)).toEqual([
      pid("openrouter"),
    ]);
    expect(skips).toEqual([
      {
        kind: "unsupported_capability",
        providerId: pid("azure"),
        canonicalModelId: PRIMARY,
        capability: "tools",
      },
    ]);
  });

  it("treats a token-ceiling violation as an unsupported capability", () => {
    const small = makeTransport("azure", (model) => ({
      kind: "candidate",
      candidate: makeCandidate("azure", model, { maxCompletionTokens: 1000 }),
    }));
    const { plan, skips } = buildRoutePlan({
      primaryModel: PRIMARY,
      fallbackModel: null,
      requirements: requirements({ requestedMaxCompletionTokens: 4000 }),
      policyFor: () => ({ mode: "only", provider: pid("azure") }),
      transports: transportMap([small]),
    });
    expect(planIsEmpty(plan)).toBe(true);
    expect(skips).toEqual([
      {
        kind: "unsupported_capability",
        providerId: pid("azure"),
        canonicalModelId: PRIMARY,
        capability: "max_completion_tokens",
      },
    ]);
  });

  it("de-duplicates identical (provider, invocation model) endpoints across stages", () => {
    // Both canonical models resolve to the same OpenRouter endpoint name —
    // simulating a stale fallback binding pointing at the primary deployment.
    const sameEndpoint = makeTransport("openrouter", (model) => ({
      kind: "candidate",
      candidate: makeCandidate("openrouter", model, {
        providerInvocationModel: "shared-endpoint",
      }),
    }));
    const { plan } = buildRoutePlan({
      primaryModel: PRIMARY,
      fallbackModel: FALLBACK,
      requirements: requirements(),
      policyFor: () => ({ mode: "only", provider: pid("openrouter") }),
      transports: transportMap([sameEndpoint]),
    });
    expect(plan.stages[0]?.candidates).toHaveLength(1);
    expect(plan.stages[1]?.candidates).toHaveLength(0);
  });

  it("ignores a fallback model equal to the primary", () => {
    const { plan } = buildRoutePlan({
      primaryModel: PRIMARY,
      fallbackModel: PRIMARY,
      requirements: requirements(),
      policyFor: () => azureFirst,
      transports: transportMap([servingTransport("azure")]),
    });
    expect(plan.stages).toHaveLength(1);
  });

  it("an `only` fence never includes another provider even when available", () => {
    const { plan } = buildRoutePlan({
      primaryModel: PRIMARY,
      fallbackModel: null,
      requirements: requirements(),
      policyFor: () => ({ mode: "only", provider: pid("azure") }),
      transports: transportMap([
        servingTransport("azure"),
        servingTransport("openrouter"),
      ]),
    });
    expect(plan.stages[0]?.candidates.map((c) => c.providerId)).toEqual([pid("azure")]);
  });

  it("produces an empty plan when nothing is viable", () => {
    const { plan, skips } = buildRoutePlan({
      primaryModel: PRIMARY,
      fallbackModel: null,
      requirements: requirements(),
      policyFor: () => azureFirst,
      transports: transportMap([]),
    });
    expect(planIsEmpty(plan)).toBe(true);
    expect(skips).toHaveLength(2);
  });

  it("propagates transport-reported invalid_binding skips", () => {
    const malformed = makeTransport("azure", (model) => ({
      kind: "skip",
      skip: {
        kind: "invalid_binding",
        providerId: pid("azure"),
        canonicalModelId: model,
        reason: "binding missing required price fields",
      },
    }));
    const { skips } = buildRoutePlan({
      primaryModel: PRIMARY,
      fallbackModel: null,
      requirements: requirements(),
      policyFor: () => ({ mode: "only", provider: pid("azure") }),
      transports: transportMap([malformed]),
    });
    expect(skips[0]?.kind).toBe("invalid_binding");
  });
});
