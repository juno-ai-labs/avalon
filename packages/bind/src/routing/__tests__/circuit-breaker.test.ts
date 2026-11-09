import { describe, expect, it } from "vitest";
import { createCircuitBreaker, type BreakerKey } from "../circuit-breaker";
import { pid } from "./fixtures";

const KEY: BreakerKey = {
  providerId: pid("azure"),
  invocationModel: "gpt-example-prod",
  credentialSource: "platform",
};

const OTHER_KEY: BreakerKey = {
  providerId: pid("azure"),
  invocationModel: "gpt-example-prod",
  credentialSource: "tenant",
};

function fakeClock(startMs = 0) {
  let atMs = startMs;
  return {
    now: () => atMs,
    advance: (ms: number) => {
      atMs += ms;
    },
  };
}

describe("createCircuitBreaker", () => {
  it("opens after three consecutive failures and refuses until cooldown", () => {
    const clock = fakeClock();
    const breaker = createCircuitBreaker({ now: clock.now });

    breaker.recordFailure(KEY);
    breaker.recordFailure(KEY);
    expect(breaker.admit(KEY)).toEqual({ admitted: true, halfOpenProbe: false });
    breaker.recordFailure(KEY);

    expect(breaker.admit(KEY)).toEqual({ admitted: false, retryAtMs: 60_000 });
    clock.advance(59_999);
    expect(breaker.admit(KEY).admitted).toBe(false);
  });

  it("keys state by credential source", () => {
    const breaker = createCircuitBreaker({ now: fakeClock().now });
    for (let i = 0; i < 3; i++) breaker.recordFailure(KEY);
    expect(breaker.admit(KEY).admitted).toBe(false);
    expect(breaker.admit(OTHER_KEY).admitted).toBe(true);
  });

  it("a success resets the consecutive-failure count", () => {
    const breaker = createCircuitBreaker({ now: fakeClock().now });
    breaker.recordFailure(KEY);
    breaker.recordFailure(KEY);
    breaker.recordSuccess(KEY);
    breaker.recordFailure(KEY);
    breaker.recordFailure(KEY);
    expect(breaker.admit(KEY).admitted).toBe(true);
  });

  it("admits exactly one half-open probe after cooldown", () => {
    const clock = fakeClock();
    const breaker = createCircuitBreaker({ now: clock.now });
    for (let i = 0; i < 3; i++) breaker.recordFailure(KEY);
    clock.advance(60_000);

    expect(breaker.admit(KEY)).toEqual({ admitted: true, halfOpenProbe: true });
    expect(breaker.admit(KEY).admitted).toBe(false);

    // Probe success closes the circuit for everyone.
    breaker.recordSuccess(KEY);
    expect(breaker.admit(KEY)).toEqual({ admitted: true, halfOpenProbe: false });
  });

  it("a failed probe reopens for another cooldown", () => {
    const clock = fakeClock();
    const breaker = createCircuitBreaker({ now: clock.now });
    for (let i = 0; i < 3; i++) breaker.recordFailure(KEY);
    clock.advance(60_000);
    expect(breaker.admit(KEY).admitted).toBe(true);
    breaker.recordFailure(KEY);
    expect(breaker.admit(KEY).admitted).toBe(false);
    clock.advance(60_000);
    expect(breaker.admit(KEY)).toEqual({ admitted: true, halfOpenProbe: true });
  });

  it("opens immediately for credential-style failures", () => {
    const breaker = createCircuitBreaker({ now: fakeClock().now });
    breaker.recordFailure(KEY, { openImmediately: true });
    expect(breaker.admit(KEY).admitted).toBe(false);
  });

  it("extends cooldown by Retry-After, capped at maxCooldownMs", () => {
    const clock = fakeClock();
    const breaker = createCircuitBreaker({
      now: clock.now,
      cooldownMs: 10_000,
      maxCooldownMs: 60_000,
    });
    breaker.recordFailure(KEY, { openImmediately: true, retryAfterMs: 30_000 });
    clock.advance(29_999);
    expect(breaker.admit(KEY).admitted).toBe(false);
    clock.advance(1);
    expect(breaker.admit(KEY).admitted).toBe(true);

    // A huge Retry-After is capped at the max.
    breaker.recordFailure(OTHER_KEY, { openImmediately: true, retryAfterMs: 900_000 });
    const refused = breaker.admit(OTHER_KEY);
    expect(refused.admitted).toBe(false);
    if (!refused.admitted) expect(refused.retryAtMs).toBe(clock.now() + 60_000);
  });

  it("releaseProbe frees an unresolved half-open probe instead of sticking forever", () => {
    const clock = fakeClock();
    const breaker = createCircuitBreaker({ now: clock.now });
    breaker.recordFailure(KEY, { openImmediately: true });
    clock.advance(60_000);
    expect(breaker.admit(KEY)).toEqual({ admitted: true, halfOpenProbe: true });

    // Probe ends in an abort: no success, no recordable failure. Without
    // releaseProbe every future admit would refuse with a stale retryAtMs.
    breaker.releaseProbe(KEY);
    // Cooldown is re-armed, not skipped: immediate re-admit is refused...
    expect(breaker.admit(KEY).admitted).toBe(false);
    clock.advance(60_000);
    // ...but after the fresh cooldown a NEW probe is admitted (never stuck).
    expect(breaker.admit(KEY)).toEqual({ admitted: true, halfOpenProbe: true });
    breaker.recordSuccess(KEY);
    expect(breaker.admit(KEY)).toEqual({ admitted: true, halfOpenProbe: false });
  });

  it("releaseProbe is a no-op when no probe is in flight", () => {
    const clock = fakeClock();
    const breaker = createCircuitBreaker({ now: clock.now });
    breaker.releaseProbe(KEY);
    expect(breaker.admit(KEY)).toEqual({ admitted: true, halfOpenProbe: false });
  });

  it("keys state by credentialScope so one tenant's key cannot trip another's", () => {
    const breaker = createCircuitBreaker({ now: fakeClock().now });
    const tenantA: BreakerKey = { ...OTHER_KEY, credentialScope: "tenant:ten_a" };
    const tenantB: BreakerKey = { ...OTHER_KEY, credentialScope: "tenant:ten_b" };
    breaker.recordFailure(tenantA, { openImmediately: true });
    expect(breaker.admit(tenantA).admitted).toBe(false);
    expect(breaker.admit(tenantB).admitted).toBe(true);
  });
});
