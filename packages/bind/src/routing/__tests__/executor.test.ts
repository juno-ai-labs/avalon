import { describe, expect, it } from "vitest";
import { executeRoutePlan, type AttemptOutcome } from "../executor";
import { ROUTE_POLICY_VERSION } from "../policy";
import type { RouteCandidate, RoutePlan, RouteStage } from "../plan";
import type { RouteAttemptCursor } from "../errors";
import type {
  BreakerKey,
  EndpointAdmission,
  RecordFailureOptions,
  RouteCircuitBreaker,
} from "../circuit-breaker";
import { cmid, httpError, makeCandidate, requirements, target } from "./fixtures";

const PRIMARY = cmid("openai/primary-model");
const FALLBACK = cmid("openai/fallback-model");

function stage(
  kind: RouteStage["kind"],
  model: typeof PRIMARY,
  candidates: readonly RouteCandidate[],
): RouteStage {
  return {
    kind,
    canonicalModelId: model,
    policy: { mode: "ordered", providers: candidates.map((c) => c.providerId) },
    candidates,
  };
}

function plan(stages: readonly RouteStage[]): RoutePlan {
  return { policyVersion: ROUTE_POLICY_VERSION, requirements: requirements(), stages };
}

const AZ = makeCandidate("azure", PRIMARY, { providerInvocationModel: "primary-prod" });
const OR = makeCandidate("openrouter", PRIMARY);
const FB = makeCandidate("openrouter", FALLBACK);
const FB_AZ = makeCandidate("azure", FALLBACK, { providerInvocationModel: "fb-prod" });

type Script = (
  candidate: RouteCandidate,
  cursor: RouteAttemptCursor,
) => AttemptOutcome<string>;

function scripted(script: Script) {
  const cursors: RouteAttemptCursor[] = [];
  const attempted: string[] = [];
  return {
    cursors,
    attempted,
    attempt: (candidate: RouteCandidate, cursor: RouteAttemptCursor) => {
      cursors.push(cursor);
      attempted.push(`${candidate.providerId}:${candidate.providerInvocationModel}`);
      return Promise.resolve(script(candidate, cursor));
    },
  };
}

function recordingBreaker(
  refuse: ReadonlySet<string> = new Set(),
  probing: ReadonlySet<string> = new Set(),
): {
  breaker: RouteCircuitBreaker;
  failures: Array<{ key: BreakerKey; options: RecordFailureOptions | undefined }>;
  successes: BreakerKey[];
  releasedProbes: BreakerKey[];
} {
  const failures: Array<{ key: BreakerKey; options: RecordFailureOptions | undefined }> =
    [];
  const successes: BreakerKey[] = [];
  const releasedProbes: BreakerKey[] = [];
  return {
    failures,
    successes,
    releasedProbes,
    breaker: {
      admit(key): EndpointAdmission {
        return refuse.has(key.invocationModel)
          ? { admitted: false, retryAtMs: 1 }
          : { admitted: true, halfOpenProbe: probing.has(key.invocationModel) };
      },
      recordSuccess(key) {
        successes.push(key);
      },
      recordFailure(key, options) {
        failures.push({ key, options });
      },
      releaseProbe(key) {
        releasedProbes.push(key);
      },
    },
  };
}

describe("executeRoutePlan", () => {
  it("returns the first success with fallbackKind none", async () => {
    const script = scripted(() => ({ kind: "success", value: "ok" }));
    const result = await executeRoutePlan({
      plan: plan([stage("primary", PRIMARY, [AZ, OR])]),
      attempt: script.attempt,
    });
    expect(result).toMatchObject({
      ok: true,
      value: "ok",
      fallbackKind: "none",
      attemptCount: 1,
    });
    expect(script.cursors).toEqual([
      { structuredOutputAttempt: 0, stageIndex: 0, candidateIndex: 0, endpointAttempt: 0 },
    ]);
  });

  it("falls over to the next provider for the same model on a 5xx", async () => {
    const script = scripted((candidate, cursor) =>
      candidate.providerId === AZ.providerId
        ? {
            kind: "failure",
            error: httpError(candidate, cursor, 500, "server_error"),
          }
        : { kind: "success", value: "served" },
    );
    const result = await executeRoutePlan({
      plan: plan([stage("primary", PRIMARY, [AZ, OR])]),
      attempt: script.attempt,
    });
    expect(result).toMatchObject({ ok: true, fallbackKind: "provider", attemptCount: 2 });
    expect(script.attempted).toEqual([
      "azure:primary-prod",
      `openrouter:${PRIMARY}`,
    ]);
  });

  it("traverses into the fallback-model stage after primary exhaustion", async () => {
    const script = scripted((candidate, cursor) =>
      candidate.canonicalModelId === PRIMARY
        ? {
            kind: "failure",
            error: httpError(candidate, cursor, 429, "rate_limit"),
          }
        : { kind: "success", value: "served" },
    );
    const result = await executeRoutePlan({
      plan: plan([
        stage("primary", PRIMARY, [AZ, OR]),
        stage("fallback_model", FALLBACK, [FB_AZ, FB]),
      ]),
      attempt: script.attempt,
    });
    expect(result).toMatchObject({ ok: true, fallbackKind: "model", attemptCount: 3 });
    if (result.ok) expect(result.served.canonicalModelId).toBe(FALLBACK);
  });

  it("reports provider_and_model when the fallback stage's second provider serves", async () => {
    const script = scripted((candidate, cursor) =>
      candidate.providerInvocationModel === String(FB.providerInvocationModel) &&
      candidate.canonicalModelId === FALLBACK
        ? { kind: "success", value: "served" }
        : {
            kind: "failure",
            error: httpError(candidate, cursor, 503, "server_error"),
          },
    );
    const result = await executeRoutePlan({
      plan: plan([
        stage("primary", PRIMARY, [AZ]),
        stage("fallback_model", FALLBACK, [FB_AZ, FB]),
      ]),
      attempt: script.attempt,
    });
    expect(result).toMatchObject({ ok: true, fallbackKind: "provider_and_model" });
  });

  it("spends the same-endpoint defect budget before moving providers", async () => {
    const script = scripted((candidate, cursor) =>
      candidate.providerId === AZ.providerId
        ? {
            kind: "failure",
            error: {
              kind: "completion_defect",
              defect: "empty_completion",
              target: target(candidate, cursor),
              cause: new Error("empty"),
            },
          }
        : { kind: "success", value: "served" },
    );
    const result = await executeRoutePlan({
      plan: plan([stage("primary", PRIMARY, [AZ, OR])]),
      attempt: script.attempt,
    });
    expect(result).toMatchObject({ ok: true, attemptCount: 4 });
    expect(script.cursors.map((c) => `${c.candidateIndex}.${c.endpointAttempt}`)).toEqual(
      ["0.0", "0.1", "0.2", "1.0"],
    );
  });

  it("propagates caller aborts immediately without further attempts", async () => {
    const script = scripted((candidate, cursor) => ({
      kind: "failure",
      error: { kind: "aborted", target: target(candidate, cursor), cause: new Error("x") },
    }));
    const result = await executeRoutePlan({
      plan: plan([stage("primary", PRIMARY, [AZ, OR])]),
      attempt: script.attempt,
    });
    expect(result).toMatchObject({ ok: false, reason: "attempts_exhausted", attemptCount: 1 });
    expect(script.attempted).toHaveLength(1);
  });

  it("releases a half-open probe on an abort so the endpoint is never stuck", async () => {
    // The Azure candidate is admitted as a half-open probe, then the attempt
    // aborts (breaker effect "none"). The executor must free the probe slot —
    // otherwise every future admit refuses until process restart.
    const recording = recordingBreaker(new Set(), new Set(["primary-prod"]));
    const script = scripted((candidate, cursor) => ({
      kind: "failure",
      error: { kind: "aborted", target: target(candidate, cursor), cause: new Error("x") },
    }));
    const result = await executeRoutePlan({
      plan: plan([stage("primary", PRIMARY, [AZ, OR])]),
      attempt: script.attempt,
      breaker: recording.breaker,
    });
    expect(result).toMatchObject({ ok: false, reason: "attempts_exhausted" });
    expect(recording.releasedProbes).toHaveLength(1);
    expect(recording.releasedProbes[0]?.invocationModel).toBe("primary-prod");
    expect(recording.failures).toHaveLength(0);
  });

  it("does not release a probe on failures the breaker records itself", async () => {
    const recording = recordingBreaker(new Set(), new Set(["primary-prod"]));
    const script = scripted((candidate, cursor) =>
      candidate.providerId === AZ.providerId
        ? { kind: "failure", error: httpError(candidate, cursor, 500, "server_error") }
        : { kind: "success", value: "served" },
    );
    await executeRoutePlan({
      plan: plan([stage("primary", PRIMARY, [AZ, OR])]),
      attempt: script.attempt,
      breaker: recording.breaker,
    });
    // recordFailure resolves the probe internally; releaseProbe must not fire.
    expect(recording.releasedProbes).toHaveLength(0);
    expect(recording.failures).toHaveLength(1);
  });

  it("scopes the breaker key with the candidate's breakerScope", async () => {
    const recording = recordingBreaker();
    const scoped: RouteCandidate = { ...OR, breakerScope: "tenant:ten_a" };
    const script = scripted((candidate, cursor) => ({
      kind: "failure",
      error: httpError(candidate, cursor, 401, "credential"),
    }));
    await executeRoutePlan({
      plan: plan([stage("primary", PRIMARY, [scoped])]),
      attempt: script.attempt,
      breaker: recording.breaker,
    });
    expect(recording.failures[0]?.key.credentialScope).toBe("tenant:ten_a");
  });

  it("propagates non-retriable client errors immediately", async () => {
    const script = scripted((candidate, cursor) => ({
      kind: "failure",
      error: httpError(candidate, cursor, 404, "client_error"),
    }));
    const result = await executeRoutePlan({
      plan: plan([stage("primary", PRIMARY, [AZ, OR])]),
      attempt: script.attempt,
    });
    expect(result).toMatchObject({ ok: false, attemptCount: 1 });
  });

  it("skips breaker-refused endpoints while preserving candidate order", async () => {
    const { breaker } = recordingBreaker(new Set(["primary-prod"]));
    const script = scripted(() => ({ kind: "success", value: "served" }));
    const result = await executeRoutePlan({
      plan: plan([stage("primary", PRIMARY, [AZ, OR])]),
      attempt: script.attempt,
      breaker,
    });
    expect(result).toMatchObject({ ok: true });
    expect(script.attempted).toEqual([`openrouter:${PRIMARY}`]);
  });

  it("records breaker success/failure with the disposition's effect", async () => {
    const recording = recordingBreaker();
    const script = scripted((candidate, cursor) =>
      candidate.providerId === AZ.providerId
        ? {
            kind: "failure",
            error: httpError(candidate, cursor, 401, "credential", 5_000),
          }
        : { kind: "success", value: "served" },
    );
    await executeRoutePlan({
      plan: plan([stage("primary", PRIMARY, [AZ, OR])]),
      attempt: script.attempt,
      breaker: recording.breaker,
    });
    expect(recording.failures).toEqual([
      {
        key: {
          providerId: AZ.providerId,
          invocationModel: "primary-prod",
          credentialSource: "platform",
        },
        options: { openImmediately: true, retryAfterMs: 5_000 },
      },
    ]);
    expect(recording.successes).toHaveLength(1);
  });

  it("returns no_viable_endpoints for an empty plan", async () => {
    const script = scripted(() => ({ kind: "success", value: "never" }));
    const result = await executeRoutePlan({
      plan: plan([stage("primary", PRIMARY, [])]),
      attempt: script.attempt,
    });
    expect(result).toEqual({
      ok: false,
      reason: "no_viable_endpoints",
      attemptCount: 0,
      failures: [],
    });
    expect(script.attempted).toHaveLength(0);
  });

  it("returns no_viable_endpoints when every candidate is breaker-refused", async () => {
    const { breaker } = recordingBreaker(new Set(["primary-prod", PRIMARY]));
    const script = scripted(() => ({ kind: "success", value: "never" }));
    const result = await executeRoutePlan({
      plan: plan([stage("primary", PRIMARY, [AZ, OR])]),
      attempt: script.attempt,
      breaker,
    });
    expect(result).toMatchObject({ ok: false, reason: "no_viable_endpoints" });
  });

  it("stamps the caller's structured-output attempt into every cursor", async () => {
    const script = scripted((candidate, cursor) => ({
      kind: "failure",
      error: httpError(candidate, cursor, 500, "server_error"),
    }));
    await executeRoutePlan({
      plan: plan([stage("primary", PRIMARY, [AZ, OR])]),
      attempt: script.attempt,
      structuredOutputAttempt: 2,
    });
    expect(script.cursors.every((c) => c.structuredOutputAttempt === 2)).toBe(true);
  });

  it("prefers a retriable primary error over a non-retriable fallback error", async () => {
    // Primary exhausts its defect budget (caller-retriable); the stale
    // fallback binding 400s (traverses, but NOT caller-retriable). PRD §5.2
    // step 6: surface the primary error so the host's queue retry still fires.
    const script = scripted((candidate, cursor) =>
      candidate.canonicalModelId === PRIMARY
        ? {
            kind: "failure",
            error: {
              kind: "completion_defect",
              defect: "empty_completion",
              target: target(candidate, cursor),
              cause: new Error("empty"),
            },
          }
        : {
            kind: "failure",
            error: httpError(candidate, cursor, 400, "provider_bad_request"),
          },
    );
    const result = await executeRoutePlan({
      plan: plan([
        stage("primary", PRIMARY, [AZ]),
        stage("fallback_model", FALLBACK, [FB]),
      ]),
      attempt: script.attempt,
    });
    expect(result).toMatchObject({ ok: false, reason: "attempts_exhausted" });
    if (!result.ok && result.reason === "attempts_exhausted") {
      expect(result.error.kind).toBe("completion_defect");
      expect(result.error.target.cursor.stageIndex).toBe(0);
    }
  });

  it("reports the final classified failure when all endpoints fail", async () => {
    const script = scripted((candidate, cursor) => ({
      kind: "failure",
      error: httpError(candidate, cursor, 500, "server_error"),
    }));
    const result = await executeRoutePlan({
      plan: plan([
        stage("primary", PRIMARY, [AZ]),
        stage("fallback_model", FALLBACK, [FB]),
      ]),
      attempt: script.attempt,
    });
    expect(result).toMatchObject({
      ok: false,
      reason: "attempts_exhausted",
      attemptCount: 2,
    });
    if (!result.ok && result.reason === "attempts_exhausted") {
      expect(result.error.target.cursor.stageIndex).toBe(1);
      expect(result.failures).toHaveLength(2);
    }
  });
});

describe("an attempt that already produced output is never replayed", () => {
  // The rule this exists for: a transport that forwards deltas to a live view
  // has shown the user tokens by the time it fails. Retrying the same endpoint
  // — or trying another provider, which re-renders the same turn — appends a
  // second partial answer to what they are already reading.
  //
  // Every other input to the disposition is a property of the ERROR; this one
  // is a property of the ATTEMPT, so only the transport can report it.
  const defectAfterOutput = (): AttemptOutcome<string> => ({
    kind: "failure",
    error: {
      kind: "completion_defect",
      defect: "truncated_tool_call",
      target: target(AZ, { structuredOutputAttempt: 0, stageIndex: 0, candidateIndex: 0, endpointAttempt: 0 }),
      cause: new Error("stream cut mid-arguments"),
    },
    producedOutput: true,
  });

  it("withholds the same-endpoint retry a defect would normally get", async () => {
    const script = scripted(() => defectAfterOutput());
    const result = await executeRoutePlan({
      plan: plan([stage("primary", PRIMARY, [AZ, OR])]),
      attempt: script.attempt,
    });
    expect(result.ok).toBe(false);
    // Without the clamp this is 3 (1 + 2 defect retries) and then traverses to
    // openrouter for 3 more.
    expect(result.attemptCount).toBe(1);
    expect(script.attempted).toEqual(["azure:primary-prod"]);
  });

  it("withholds provider traversal and the fallback model stage", async () => {
    const script = scripted(() => defectAfterOutput());
    const result = await executeRoutePlan({
      plan: plan([
        stage("primary", PRIMARY, [AZ, OR]),
        stage("fallback_model", FALLBACK, [FB, FB_AZ]),
      ]),
      attempt: script.attempt,
    });
    expect(result.ok).toBe(false);
    expect(script.attempted).toEqual(["azure:primary-prod"]);
  });

  it("still records the breaker failure — the endpoint really did fail", async () => {
    // Suppressing this would hide a dying endpoint from every later call
    // precisely BECAUSE it dies late, which is backwards.
    const rec = recordingBreaker();
    const script = scripted(() => defectAfterOutput());
    await executeRoutePlan({
      plan: plan([stage("primary", PRIMARY, [AZ])]),
      attempt: script.attempt,
      breaker: rec.breaker,
    });
    expect(rec.failures).toHaveLength(1);
    expect(rec.failures[0]?.key.invocationModel).toBe("primary-prod");
  });

  it("omitting the flag keeps the normal traversal — a buffering transport can replay", async () => {
    const script = scripted(() => ({
      kind: "failure" as const,
      error: {
        kind: "completion_defect" as const,
        defect: "truncated_tool_call" as const,
        target: target(AZ, { structuredOutputAttempt: 0, stageIndex: 0, candidateIndex: 0, endpointAttempt: 0 }),
        cause: new Error("stream cut mid-arguments"),
      },
    }));
    const result = await executeRoutePlan({
      plan: plan([stage("primary", PRIMARY, [AZ, OR])]),
      attempt: script.attempt,
    });
    expect(result.ok).toBe(false);
    expect(result.attemptCount).toBeGreaterThan(1);
  });

  it("a retriable HTTP failure after output propagates rather than traversing", async () => {
    // The clamp is about the attempt, not the error kind — a 503 that arrives
    // after the first token is as unreplayable as a truncated stream.
    const script = scripted(() => ({
      kind: "failure" as const,
      error: httpError(AZ, { structuredOutputAttempt: 0, stageIndex: 0, candidateIndex: 0, endpointAttempt: 0 }, 503, "server_error"),
      producedOutput: true,
    }));
    const result = await executeRoutePlan({
      plan: plan([stage("primary", PRIMARY, [AZ, OR])]),
      attempt: script.attempt,
    });
    expect(result.ok).toBe(false);
    expect(script.attempted).toEqual(["azure:primary-prod"]);
  });
});
