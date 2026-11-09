/**
 * The routing executor composed with the pieces it is always deployed with:
 * the real circuit breaker, the real planner, and the stream watchdog.
 *
 * `executor.test.ts` gives the executor a hand-rolled breaker whose `admit` is a
 * `Set` lookup (`routing/__tests__/executor.test.ts:58-92`), and
 * `circuit-breaker.test.ts` never calls the executor. So the four-message
 * protocol between them — `admit` / `recordSuccess` / `recordFailure` /
 * `releaseProbe` — is asserted twice, from opposite sides, against two different
 * objects. Nothing checks that the two agree, and the half-open probe in
 * particular has a leak path (an `attempt` that throws) whose only guard is a
 * `try/catch` in the executor that the stub can never exercise meaningfully.
 */
import { describe, expect, test } from "vitest";
import {
  executeRoutePlan,
  fallbackKindOfCursor,
  type AttemptOutcome,
} from "../routing/executor";
import { createCircuitBreaker } from "../routing/circuit-breaker";
import { ROUTE_POLICY_VERSION } from "../routing/policy";
import type { RouteCandidate, RoutePlan, RouteStage } from "../routing/plan";
import { createStreamWatchdog } from "../completion/watchdog";
import { httpError, cmid, makeCandidate, requirements } from "../routing/__tests__/fixtures";

const PRIMARY = cmid("openai/primary-model");
const FALLBACK = cmid("openai/fallback-model");

const A = makeCandidate("provider-a", PRIMARY);
const B = makeCandidate("provider-b", PRIMARY);
const FB = makeCandidate("provider-c", FALLBACK);

function stage(
  kind: RouteStage["kind"],
  canonicalModelId: typeof PRIMARY,
  candidates: readonly RouteCandidate[],
): RouteStage {
  return {
    kind,
    canonicalModelId,
    policy: { mode: "ordered", providers: candidates.map((c) => c.providerId) },
    candidates,
  };
}

const PLAN: RoutePlan = {
  policyVersion: ROUTE_POLICY_VERSION,
  requirements: requirements(),
  stages: [stage("primary", PRIMARY, [A, B]), stage("fallback_model", FALLBACK, [FB])],
};

/** A clock a test advances by hand, so cooldowns are exact rather than slept. */
function fakeClock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

describe("the executor and the real circuit breaker, across turns and runs", () => {
  test("consecutive failures open an endpoint, and the next turn skips it entirely", async () => {
    const clock = fakeClock();
    const breaker = createCircuitBreaker({
      failureThreshold: 2,
      cooldownMs: 30_000,
      now: clock.now,
    });
    const attemptsPerTurn: string[][] = [];

    const runTurn = async (failA: boolean) => {
      const attempted: string[] = [];
      const result = await executeRoutePlan<string>({
        plan: PLAN,
        breaker,
        completionDefectRetries: 0,
        attempt: (candidate, cursor): Promise<AttemptOutcome<string>> => {
          attempted.push(String(candidate.providerId));
          if (failA && candidate.providerId === A.providerId) {
            return Promise.resolve({
              kind: "failure",
              error: httpError(candidate, cursor, 500, "server_error"),
            });
          }
          return Promise.resolve({ kind: "success", value: String(candidate.providerId) });
        },
      });
      attemptsPerTurn.push(attempted);
      return result;
    };

    await runTurn(true); // A fails once, B serves
    await runTurn(true); // A fails twice — threshold reached, circuit opens
    const third = await runTurn(true);

    expect(attemptsPerTurn[0]).toEqual(["provider-a", "provider-b"]);
    expect(attemptsPerTurn[1]).toEqual(["provider-a", "provider-b"]);
    // A is open: not attempted at all, so its failure never even happens.
    expect(attemptsPerTurn[2]).toEqual(["provider-b"]);
    expect(third.ok).toBe(true);
  });

  test("after the cooldown exactly ONE half-open probe is admitted", async () => {
    // The property a `Set`-lookup stub cannot express: admission is stateful and
    // single-flight. Two concurrent calls after a cooldown must not both probe a
    // recovering endpoint.
    const clock = fakeClock();
    const breaker = createCircuitBreaker({
      failureThreshold: 1,
      cooldownMs: 10_000,
      now: clock.now,
    });
    const key = {
      providerId: A.providerId,
      invocationModel: A.providerInvocationModel,
      credentialSource: A.credentialSource,
      credentialScope: A.breakerScope,
    };

    breaker.recordFailure(key, {});
    expect(breaker.admit(key).admitted).toBe(false);

    clock.advance(10_001);
    const first = breaker.admit(key);
    const second = breaker.admit(key);
    expect(first).toEqual({ admitted: true, halfOpenProbe: true });
    expect(second.admitted).toBe(false);
  });

  test("a probe that FAILS reopens the circuit rather than leaking the slot", async () => {
    const clock = fakeClock();
    const breaker = createCircuitBreaker({
      failureThreshold: 1,
      cooldownMs: 10_000,
      now: clock.now,
    });
    const attempted: string[] = [];
    const run = () =>
      executeRoutePlan<string>({
        plan: PLAN,
        breaker,
        completionDefectRetries: 0,
        attempt: (candidate, cursor): Promise<AttemptOutcome<string>> => {
          attempted.push(String(candidate.providerId));
          return candidate.providerId === A.providerId
            ? Promise.resolve({
                kind: "failure",
                error: httpError(candidate, cursor, 500, "server_error"),
              })
            : Promise.resolve({ kind: "success", value: "ok" });
        },
      });

    await run(); // A fails, opens
    attempted.length = 0;
    await run(); // A skipped
    expect(attempted).toEqual(["provider-b"]);

    clock.advance(10_001);
    attempted.length = 0;
    await run(); // probe admitted, probe fails, circuit reopens
    expect(attempted).toEqual(["provider-a", "provider-b"]);

    attempted.length = 0;
    await run(); // and it is closed again immediately, not left half-open
    expect(attempted).toEqual(["provider-b"]);
  });

  test("a probe that SUCCEEDS clears the endpoint's failure history", async () => {
    const clock = fakeClock();
    const breaker = createCircuitBreaker({
      failureThreshold: 2,
      cooldownMs: 5_000,
      now: clock.now,
    });
    let aFails = true;
    const attempted: string[] = [];
    const run = () =>
      executeRoutePlan<string>({
        plan: PLAN,
        breaker,
        completionDefectRetries: 0,
        attempt: (candidate, cursor): Promise<AttemptOutcome<string>> => {
          attempted.push(String(candidate.providerId));
          return aFails && candidate.providerId === A.providerId
            ? Promise.resolve({
                kind: "failure",
                error: httpError(candidate, cursor, 500, "server_error"),
              })
            : Promise.resolve({ kind: "success", value: "ok" });
        },
      });

    await run();
    await run(); // two failures — open
    clock.advance(5_001);
    aFails = false;
    attempted.length = 0;
    await run(); // probe succeeds

    attempted.length = 0;
    aFails = true;
    await run(); // one failure — must NOT reopen, the count was cleared
    expect(attempted).toEqual(["provider-a", "provider-b"]);
    attempted.length = 0;
    await run(); // second failure since recovery — now it opens
    attempted.length = 0;
    await run();
    expect(attempted).toEqual(["provider-b"]);
  });

  test("an attempt that THROWS releases its half-open probe", async () => {
    // The leak the executor's try/catch exists for: without it the probe slot
    // stays occupied for the process's lifetime and every later call for that
    // endpoint is refused, silently, with no failure recorded to ever reopen it.
    // Only reachable against a real breaker — a stub's `admit` has no slot.
    const clock = fakeClock();
    const breaker = createCircuitBreaker({
      failureThreshold: 1,
      cooldownMs: 1_000,
      now: clock.now,
    });
    const key = {
      providerId: A.providerId,
      invocationModel: A.providerInvocationModel,
      credentialSource: A.credentialSource,
      credentialScope: A.breakerScope,
    };
    breaker.recordFailure(key, {});
    clock.advance(1_001);

    await expect(
      executeRoutePlan<string>({
        plan: PLAN,
        breaker,
        completionDefectRetries: 0,
        attempt: () => {
          throw new Error("host bug");
        },
      }),
    ).rejects.toThrow("host bug");

    // The slot is not leaked. `releaseProbe` deliberately re-arms the cooldown
    // rather than closing — the probe told us nothing, and admitting another
    // caller at once would thrash a recovering endpoint — so the endpoint is
    // refused now and probe-able again after one more cooldown. The leak this
    // guards against is the slot staying occupied FOREVER, with no failure ever
    // recorded to reopen it.
    expect(breaker.admit(key).admitted).toBe(false);
    clock.advance(1_001);
    expect(breaker.admit(key)).toEqual({ admitted: true, halfOpenProbe: true });
  });

  test("a Retry-After extends the cooldown the executor's next call observes", async () => {
    const clock = fakeClock();
    const breaker = createCircuitBreaker({
      failureThreshold: 1,
      cooldownMs: 1_000,
      maxCooldownMs: 60_000,
      now: clock.now,
    });
    const attempted: string[] = [];
    const run = () =>
      executeRoutePlan<string>({
        plan: PLAN,
        breaker,
        completionDefectRetries: 0,
        attempt: (candidate, cursor): Promise<AttemptOutcome<string>> => {
          attempted.push(String(candidate.providerId));
          return candidate.providerId === A.providerId
            ? Promise.resolve({
                kind: "failure",
                error: httpError(candidate, cursor, 429, "rate_limit", 30_000),
              })
            : Promise.resolve({ kind: "success", value: "ok" });
        },
      });

    await run();
    clock.advance(2_000); // past the base cooldown, inside the Retry-After
    attempted.length = 0;
    await run();
    expect(attempted).toEqual(["provider-b"]);

    clock.advance(29_000); // past the Retry-After
    attempted.length = 0;
    await run();
    expect(attempted[0]).toBe("provider-a");
  });

  test("every endpoint open means no viable candidate, not a silent success", async () => {
    const clock = fakeClock();
    const breaker = createCircuitBreaker({ failureThreshold: 1, now: clock.now });
    for (const candidate of [A, B, FB]) {
      breaker.recordFailure({
        providerId: candidate.providerId,
        invocationModel: candidate.providerInvocationModel,
        credentialSource: candidate.credentialSource,
        credentialScope: candidate.breakerScope,
      }, {});
    }

    const result = await executeRoutePlan<string>({
      plan: PLAN,
      breaker,
      attempt: () => Promise.resolve({ kind: "success", value: "unreachable" }),
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe("no_viable_endpoints");
    expect(result.attemptCount).toBe(0);
  });
});

describe("the two derivations of FallbackKind must agree", () => {
  test("the cursor-derived kind matches the executor's for every position in a plan", async () => {
    // `fallbackKindFor` switches on `stage.kind`; `fallbackKindOfCursor` infers
    // from `stageIndex > 0`. They agree only because the planner always emits
    // `[primary, fallback_model?]`. Nothing pins that, the `RoutePlan` type is
    // public, and a host assembling its own plan gets two exported helpers that
    // disagree about the same attempt — one of them stamped onto its inference
    // log, the other driving its metrics.
    for (const [stageIndex, candidateIndex] of [
      [0, 0],
      [0, 1],
      [1, 0],
      [1, 1],
    ] as const) {
      const result = await executeRoutePlan<string>({
        plan: PLAN,
        completionDefectRetries: 0,
        attempt: (candidate, cursor): Promise<AttemptOutcome<string>> =>
          cursor.stageIndex === stageIndex && cursor.candidateIndex === candidateIndex
            ? Promise.resolve({ kind: "success", value: "ok" })
            : Promise.resolve({
                kind: "failure",
                error: httpError(candidate, cursor, 500, "server_error"),
              }),
      });
      if (!result.ok) continue; // (1,1) has no candidate in this plan
      expect(result.fallbackKind).toBe(fallbackKindOfCursor(result.cursor));
    }
  });

  test("they diverge on a plan whose stages are not [primary, fallback_model]", async () => {
    // The invariant made visible. A plan with two primary stages — legal by the
    // type — has the executor report `none` for stage 1 while the cursor helper
    // reports `model`.
    const twoPrimaries: RoutePlan = {
      policyVersion: ROUTE_POLICY_VERSION,
      requirements: requirements(),
      stages: [stage("primary", PRIMARY, [A]), stage("primary", PRIMARY, [B])],
    };
    const result = await executeRoutePlan<string>({
      plan: twoPrimaries,
      completionDefectRetries: 0,
      attempt: (candidate, cursor): Promise<AttemptOutcome<string>> =>
        candidate.providerId === B.providerId
          ? Promise.resolve({ kind: "success", value: "ok" })
          : Promise.resolve({
              kind: "failure",
              error: httpError(candidate, cursor, 500, "server_error"),
            }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fallbackKind).toBe("none");
    expect(fallbackKindOfCursor(result.cursor)).toBe("model");
    expect(result.fallbackKind).not.toBe(fallbackKindOfCursor(result.cursor));
  });
});

describe("a stream watchdog stalling inside a real executor attempt", () => {
  test("a time-to-first-token stall traverses to the next provider", async () => {
    // The watchdog reports a structured stall; the host classifies it as a
    // retriable transport error; the executor traverses. Three modules, one
    // path, and previously no test anywhere joined them.
    const attempted: string[] = [];
    const result = await executeRoutePlan<string>({
      plan: PLAN,
      completionDefectRetries: 0,
      attempt: async (candidate, cursor): Promise<AttemptOutcome<string>> => {
        attempted.push(String(candidate.providerId));
        if (candidate.providerId === A.providerId) {
          const watchdog = createStreamWatchdog({
            timeToFirstTokenMs: 5,
            interChunkMs: 5,
            maxCallDurationMs: 1_000,
          });
          try {
            watchdog.open(); // arm the idle budgets, as a transport does
            // A provider that opens the stream and then says nothing.
            await new Promise((resolve, reject) => {
              const timer = setTimeout(resolve, 200);
              watchdog.signal.addEventListener("abort", () => {
                clearTimeout(timer);
                reject(new Error("aborted"));
              });
            });
            return { kind: "success", value: "never" };
          } catch {
            const stall = watchdog.stall();
            expect(stall?.kind).toBe("time_to_first_token");
            return {
              kind: "failure",
              error: httpError(candidate, cursor, 504, "timeout"),
            };
          } finally {
            watchdog.dispose();
          }
        }
        return { kind: "success", value: "served by B" };
      },
    });

    expect(attempted).toEqual(["provider-a", "provider-b"]);
    expect(result.ok && result.value).toBe("served by B");
  });

  test("a healthy stream never arms the watchdog, so nothing traverses", async () => {
    // The control: the budget is tight, the chunks are timely, and the first
    // provider serves. Without this the test above would pass equally well
    // against a watchdog that fires unconditionally.
    const attempted: string[] = [];
    const result = await executeRoutePlan<string>({
      plan: PLAN,
      attempt: async (candidate): Promise<AttemptOutcome<string>> => {
        attempted.push(String(candidate.providerId));
        // Deliberately generous. The control's job is to prove the watchdog is
        // not unconditional, which a large budget shows just as well — and a
        // tight one flakes red under `--parallel`, where docs/tests.md records
        // ~16x slowdowns.
        const watchdog = createStreamWatchdog({
          timeToFirstTokenMs: 5_000,
          interChunkMs: 5_000,
          maxCallDurationMs: 30_000,
        });
        try {
          watchdog.open();
          for (let chunk = 0; chunk < 5; chunk++) {
            await new Promise((resolve) => setTimeout(resolve, 5));
            watchdog.observedChunk("answer");
          }
          expect(watchdog.stall()).toBeNull();
          return { kind: "success", value: "streamed" };
        } finally {
          watchdog.dispose();
        }
      },
    });

    expect(attempted).toEqual(["provider-a"]);
    expect(result.ok && result.value).toBe("streamed");
  });
});
