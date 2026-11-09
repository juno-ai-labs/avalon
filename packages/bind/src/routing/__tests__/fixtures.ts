import {
  canonicalModelIdSchema,
  providerIdSchema,
  type CanonicalModelId,
  type ProviderId,
} from "../canonical-model";
import type {
  InferenceCapability,
  InferenceRequirements,
  RouteCandidate,
} from "../plan";
import type { CandidateResolution, PlannerTransport } from "../transport";
import type {
  AttemptTarget,
  InferenceAttemptError,
  RouteAttemptCursor,
} from "../errors";

export function cmid(id: string): CanonicalModelId {
  return canonicalModelIdSchema.parse(id);
}

export function pid(id: string): ProviderId {
  return providerIdSchema.parse(id);
}

export const BASE_CAPABILITIES: ReadonlySet<InferenceCapability> = new Set([
  "chat_completions",
  "streaming",
  "tools",
  "structured_outputs",
]);

export function requirements(
  overrides: Partial<InferenceRequirements> = {},
): InferenceRequirements {
  return {
    capabilities: overrides.capabilities ?? new Set(["chat_completions", "streaming"]),
    requestedMaxCompletionTokens: overrides.requestedMaxCompletionTokens ?? null,
  };
}

export function makeCandidate(
  provider: string,
  model: string,
  overrides: Partial<RouteCandidate> = {},
): RouteCandidate {
  return {
    providerId: pid(provider),
    canonicalModelId: cmid(model),
    providerInvocationModel: overrides.providerInvocationModel ?? model,
    credentialSource: overrides.credentialSource ?? "platform",
    creditEligible: overrides.creditEligible ?? false,
    capabilities: overrides.capabilities ?? BASE_CAPABILITIES,
    maxCompletionTokens: overrides.maxCompletionTokens ?? null,
    pricingBasis: overrides.pricingBasis ?? { kind: "provider_reported" },
    bindingFingerprint: overrides.bindingFingerprint ?? "fixture-v1",
    breakerScope: overrides.breakerScope,
  };
}

export function makeTransport(
  provider: string,
  resolve: (model: CanonicalModelId) => CandidateResolution,
  options: { available?: boolean; unavailableReason?: string } = {},
): PlannerTransport {
  return {
    id: pid(provider),
    getAvailability: () =>
      (options.available ?? true)
        ? { available: true }
        : { available: false, reason: options.unavailableReason ?? "not configured" },
    resolveCandidate: (model) => resolve(model),
  };
}

export function transportMap(
  transports: readonly PlannerTransport[],
): ReadonlyMap<ProviderId, PlannerTransport> {
  return new Map(transports.map((transport) => [transport.id, transport]));
}

export function target(
  candidate: RouteCandidate,
  cursor: RouteAttemptCursor,
): AttemptTarget {
  return {
    cursor,
    providerId: candidate.providerId,
    canonicalModelId: candidate.canonicalModelId,
    providerInvocationModel: candidate.providerInvocationModel,
    durationMs: 5,
  };
}

export function httpError(
  candidate: RouteCandidate,
  cursor: RouteAttemptCursor,
  statusCode: number,
  category: (InferenceAttemptError & { kind: "http" })["category"],
  retryAfterMs: number | null = null,
): InferenceAttemptError {
  return {
    kind: "http",
    category,
    statusCode,
    retryAfterMs,
    target: target(candidate, cursor),
    cause: new Error(`http ${statusCode}`),
  };
}
