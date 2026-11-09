import { describe, expect, it } from "vitest";
import { canonicalModelIdSchema } from "../canonical-model";
import {
  ROUTE_POLICY_VERSION,
  parseModelRouteRegistry,
  policyProviderOrder,
  resolveProviderPolicy,
} from "../policy";
import { cmid, pid } from "./fixtures";

describe("canonicalModelIdSchema", () => {
  it("accepts OpenRouter-style vendor/model ids and trims whitespace", () => {
    expect(canonicalModelIdSchema.parse("openai/gpt-example")).toBe(
      cmid("openai/gpt-example"),
    );
    expect(canonicalModelIdSchema.parse("  vendor/model.slug:free ")).toBe(
      cmid("vendor/model.slug:free"),
    );
  });

  it("rejects deployment names, extra segments, and whitespace", () => {
    expect(canonicalModelIdSchema.safeParse("gpt-example-prod").success).toBe(false);
    expect(canonicalModelIdSchema.safeParse("a/b/c").success).toBe(false);
    expect(canonicalModelIdSchema.safeParse("a b/c").success).toBe(false);
    expect(canonicalModelIdSchema.safeParse("/model").success).toBe(false);
    expect(canonicalModelIdSchema.safeParse("vendor/").success).toBe(false);
    expect(canonicalModelIdSchema.safeParse("").success).toBe(false);
  });
});

function validRegistryInput(): unknown {
  return {
    version: ROUTE_POLICY_VERSION,
    unboundDefault: { mode: "only", provider: "openrouter" },
    boundDefault: { mode: "ordered", providers: ["azure", "openrouter"] },
    models: {
      "openai/fenced-model": { mode: "only", provider: "azure" },
      "openai/openrouter-pinned": { mode: "only", provider: "openrouter" },
    },
  };
}

describe("parseModelRouteRegistry", () => {
  it("parses and freezes a valid registry", () => {
    const registry = parseModelRouteRegistry(validRegistryInput());
    expect(Object.isFrozen(registry)).toBe(true);
    expect(Object.isFrozen(registry.models)).toBe(true);
    expect(registry.models[cmid("openai/fenced-model")]?.mode).toBe("only");
  });

  it("rejects an unknown policy version", () => {
    const input = { ...(validRegistryInput() as Record<string, unknown>) };
    input.version = "provider-router-v2";
    expect(() => parseModelRouteRegistry(input)).toThrow();
  });

  it("rejects empty and duplicate provider lists", () => {
    const empty = validRegistryInput() as { boundDefault: unknown };
    empty.boundDefault = { mode: "ordered", providers: [] };
    expect(() => parseModelRouteRegistry(empty)).toThrow();

    const dup = validRegistryInput() as { boundDefault: unknown };
    dup.boundDefault = { mode: "ordered", providers: ["azure", "azure"] };
    expect(() => parseModelRouteRegistry(dup)).toThrow();
  });

  it("rejects deployment-name keys and unknown keys", () => {
    const badKey = validRegistryInput() as { models: Record<string, unknown> };
    badKey.models["gpt-example-prod"] = { mode: "only", provider: "azure" };
    expect(() => parseModelRouteRegistry(badKey)).toThrow();

    const extra = { ...(validRegistryInput() as Record<string, unknown>), quota: 3 };
    expect(() => parseModelRouteRegistry(extra)).toThrow();
  });
});

describe("resolveProviderPolicy", () => {
  const registry = parseModelRouteRegistry(validRegistryInput());
  const azure = pid("azure");

  it("prefers the exact model entry over both defaults", () => {
    const policy = resolveProviderPolicy(
      registry,
      cmid("openai/openrouter-pinned"),
      new Set([azure]),
    );
    // Explicit OpenRouter-only stays pinned even when an azure binding exists.
    expect(policy).toEqual({ mode: "only", provider: pid("openrouter") });
  });

  it("uses the bound default when a binding exists and no explicit entry", () => {
    const policy = resolveProviderPolicy(registry, cmid("openai/other"), new Set([azure]));
    expect(policyProviderOrder(policy)).toEqual([azure, pid("openrouter")]);
  });

  it("uses the unbound default when no binding and no explicit entry", () => {
    const policy = resolveProviderPolicy(registry, cmid("openai/other"), new Set());
    expect(policyProviderOrder(policy)).toEqual([pid("openrouter")]);
  });
});
