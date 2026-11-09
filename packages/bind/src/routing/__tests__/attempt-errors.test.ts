import { describe, expect, test } from "vitest";
import {
  classifyAttemptError,
  isAbortByName,
  retryAfterMsFromHeaders,
  type AttemptClassification,
  type TransportFailure,
  type TransportFailureKind,
} from "../attempt-errors";
import { failureDisposition } from "../errors";
import type { AttemptTarget } from "../errors";
import { makeCandidate, target } from "./fixtures";

const CURSOR = {
  structuredOutputAttempt: 0,
  stageIndex: 0,
  candidateIndex: 0,
  endpointAttempt: 0,
} as const;

const CANDIDATE = makeCandidate("openrouter", "vendor/model");
const TARGET: AttemptTarget = target(CANDIDATE, CURSOR);

/** A host error class carrying its own classification, like a real transport's. */
class FakeTransportError extends Error {
  constructor(
    readonly failureKind: TransportFailureKind,
    readonly statusCode: number | null = null,
    readonly retryAfterMs: number | null = null,
  ) {
    super(`fake ${failureKind}`);
    this.name = "FakeTransportError";
  }
}

function classification(
  overrides: Partial<AttemptClassification> = {},
): AttemptClassification {
  return {
    asTransportFailure: (error): TransportFailure | null =>
      error instanceof FakeTransportError
        ? {
            kind: error.failureKind,
            statusCode: error.statusCode,
            retryAfterMs: error.retryAfterMs,
          }
        : null,
    ...overrides,
  };
}

function classify(error: unknown, overrides: Partial<AttemptClassification> = {}) {
  return classifyAttemptError(error, TARGET, classification(overrides));
}

describe("classifyAttemptError", () => {
  test("an AbortError is aborted and propagates", () => {
    const abort = new Error("Request was aborted.");
    abort.name = "AbortError";
    const classified = classify(abort);
    expect(classified.kind).toBe("aborted");
    expect(classified.cause).toBe(abort);
    expect(failureDisposition(classified).propagate).toBe(true);
  });

  test("an abort wins even when the host would classify it as a transport failure", () => {
    // A transport that wraps its own aborts must not have them routed as
    // retriable network faults — a cancelled run would burn the whole plan.
    const abort = new FakeTransportError("network");
    abort.name = "AbortError";
    expect(classify(abort).kind).toBe("aborted");
  });

  test("an unrecognized error is a propagating client_error, not a traversal", () => {
    // A TypeError escaping the transport is a bug, not an endpoint condition.
    // Traversing would retry the same bug against every provider and the
    // fallback model before surfacing the identical exception.
    const bug = new TypeError("cannot read properties of undefined");
    const classified = classify(bug);
    expect(classified).toMatchObject({ kind: "http", category: "client_error", statusCode: 0 });
    expect(classified.cause).toBe(bug);
    const disposition = failureDisposition(classified);
    expect(disposition.propagate).toBe(true);
    expect(disposition.nextProvider).toBe(false);
    expect(disposition.breaker).toBe("none");
  });

  test("a non-Error throw is wrapped rather than dropped", () => {
    const classified = classify("just a string");
    expect(classified.cause).toBeInstanceOf(Error);
    expect(classified.cause.message).toBe("just a string");
  });

  for (const defect of ["empty_completion", "truncated_tool_call"] as const) {
    test(`${defect} becomes a completion_defect eligible for a same-endpoint retry`, () => {
      const classified = classify(new FakeTransportError(defect));
      expect(classified).toMatchObject({ kind: "completion_defect", defect });
      expect(failureDisposition(classified).sameEndpointRetry).toBe(true);
    });
  }

  test("network stays network", () => {
    expect(classify(new FakeTransportError("network")).kind).toBe("network");
  });

  test("rate_limit, no_credits and server_error fall back to their conventional statuses", () => {
    // A transport that could not read a status must still produce a status the
    // logs and the breaker can attribute.
    expect(classify(new FakeTransportError("rate_limit"))).toMatchObject({
      category: "rate_limit",
      statusCode: 429,
    });
    expect(classify(new FakeTransportError("no_credits"))).toMatchObject({
      category: "credits",
      statusCode: 402,
    });
    expect(classify(new FakeTransportError("server_error"))).toMatchObject({
      category: "server_error",
      statusCode: 500,
    });
  });

  test("an explicit status is preserved over the fallback", () => {
    expect(classify(new FakeTransportError("rate_limit", 503))).toMatchObject({
      category: "rate_limit",
      statusCode: 503,
    });
  });

  test("retryAfterMs rides through to the classified error", () => {
    expect(classify(new FakeTransportError("rate_limit", 429, 4_000))).toMatchObject({
      retryAfterMs: 4_000,
    });
  });

  test("an `api` failure uses the neutral status mapping by default", () => {
    expect(classify(new FakeTransportError("api", 400))).toMatchObject({
      category: "provider_bad_request",
    });
    expect(classify(new FakeTransportError("api", 403))).toMatchObject({
      category: "credential",
    });
  });

  test("an `api` failure with no status propagates rather than traversing", () => {
    const classified = classify(new FakeTransportError("api", null));
    expect(classified).toMatchObject({ category: "client_error", statusCode: 0 });
    expect(failureDisposition(classified).propagate).toBe(true);
  });

  test("categorizeStatus overrides the neutral mapping and gets the provider id", () => {
    // The concrete case this port exists for: a gateway that answers 403 for
    // moderation-flagged INPUT. Neutral says "credential", which opens the
    // circuit immediately and degrades a healthy shared endpoint for everyone.
    const seen: Array<[number, string]> = [];
    const classified = classify(new FakeTransportError("api", 403), {
      categorizeStatus: (statusCode, providerId) => {
        seen.push([statusCode, String(providerId)]);
        return statusCode === 403 ? "provider_bad_request" : null;
      },
    });
    expect(seen).toEqual([[403, "openrouter"]]);
    expect(classified).toMatchObject({ category: "provider_bad_request" });
    expect(failureDisposition(classified).breaker).toBe("none");
  });

  test("categorizeStatus returning null falls back to the neutral mapping", () => {
    const classified = classify(new FakeTransportError("api", 401), {
      categorizeStatus: () => null,
    });
    expect(classified).toMatchObject({ category: "credential" });
  });

  test("categorizeStatus is not consulted for kinds that carry their own category", () => {
    // Only `api` is status-driven. A transport that already decided "this was a
    // rate limit" must not have that overturned by a status heuristic.
    let called = false;
    const classified = classify(new FakeTransportError("rate_limit", 403), {
      categorizeStatus: () => {
        called = true;
        return "credential";
      },
    });
    expect(called).toBe(false);
    expect(classified).toMatchObject({ category: "rate_limit" });
  });

  test("the target rides through unchanged", () => {
    expect(classify(new FakeTransportError("network")).target).toBe(TARGET);
  });
});

describe("retryAfterMsFromHeaders", () => {
  test("delta-seconds from a Headers-like bag", () => {
    expect(retryAfterMsFromHeaders(new Headers({ "retry-after": "5" }))).toBe(5_000);
  });

  test("delta-seconds from a Map (any object with .get)", () => {
    // The `get` duck-type covers Headers and Map alike without naming either
    // global, so a runtime shipping neither still resolves.
    expect(retryAfterMsFromHeaders(new Map([["retry-after", "2"]]))).toBe(2_000);
  });

  test("delta-seconds from a plain object, either spelling", () => {
    expect(retryAfterMsFromHeaders({ "retry-after": "3" })).toBe(3_000);
    expect(retryAfterMsFromHeaders({ "Retry-After": "3" })).toBe(3_000);
  });

  test("a numeric value in a plain object is accepted", () => {
    expect(retryAfterMsFromHeaders({ "retry-after": 7 })).toBe(7_000);
  });

  test("fractional seconds round to the nearest millisecond", () => {
    expect(retryAfterMsFromHeaders({ "retry-after": "1.5" })).toBe(1_500);
    expect(retryAfterMsFromHeaders({ "retry-after": "0.0004" })).toBe(0);
  });

  test("an HTTP-date is measured against the injected clock", () => {
    const now = Date.parse("2026-01-01T00:00:00Z");
    expect(
      retryAfterMsFromHeaders(
        { "retry-after": "Thu, 01 Jan 2026 00:00:30 GMT" },
        () => now,
      ),
    ).toBe(30_000);
  });

  test("an HTTP-date already in the past clamps to zero, never negative", () => {
    const now = Date.parse("2026-01-01T00:01:00Z");
    expect(
      retryAfterMsFromHeaders(
        { "retry-after": "Thu, 01 Jan 2026 00:00:00 GMT" },
        () => now,
      ),
    ).toBe(0);
  });

  test("absent, empty, and unparseable values are null", () => {
    expect(retryAfterMsFromHeaders(undefined)).toBeNull();
    expect(retryAfterMsFromHeaders(null)).toBeNull();
    expect(retryAfterMsFromHeaders("retry-after: 5")).toBeNull();
    expect(retryAfterMsFromHeaders({})).toBeNull();
    expect(retryAfterMsFromHeaders({ "retry-after": "" })).toBeNull();
    expect(retryAfterMsFromHeaders({ "retry-after": "soon" })).toBeNull();
    expect(retryAfterMsFromHeaders(new Headers())).toBeNull();
  });

  test("a negative delta is rejected rather than read as a date", () => {
    // A negative delta is malformed, and the date branch would not reliably
    // reject a bare "-5" either — so reject it explicitly.
    expect(retryAfterMsFromHeaders({ "retry-after": "-5" })).toBeNull();
  });

  test("a non-finite numeric value is rejected", () => {
    expect(retryAfterMsFromHeaders({ "retry-after": "1e400" })).toBeNull();
    expect(retryAfterMsFromHeaders({ "retry-after": Number.NaN })).toBeNull();
  });

  test("a value that overflows to Infinity once scaled to ms is rejected", () => {
    // 1e308 is finite, so the finite check alone lets it through — and then
    // `* 1000` overflows. A non-finite delay is the one value that makes a
    // timer fire IMMEDIATELY rather than never, so handing this back would
    // poison any caller that sleeps on it.
    expect(retryAfterMsFromHeaders({ "retry-after": "1e308" })).toBeNull();
  });

  test("a numeric value is read from a Map as well as a plain object", () => {
    // The `.get` duck-type and the plain-object branch must agree; accepting a
    // number from one and dropping it from the other silently loses the hint
    // depending on which container the SDK happened to use.
    expect(retryAfterMsFromHeaders(new Map([["retry-after", 5]]))).toBe(5_000);
    expect(retryAfterMsFromHeaders({ "retry-after": 5 })).toBe(5_000);
  });

  test("a throwing header getter degrades to null instead of escaping", () => {
    // This runs inside a host's `catch` while classifying a failure. A throw
    // here would replace the real provider error with this one and lose the
    // classification entirely.
    const hostile = {
      get() {
        throw new Error("boom");
      },
    };
    expect(retryAfterMsFromHeaders(hostile)).toBeNull();
  });
});

describe("classifyAttemptError abort recognition", () => {
  test("the default recognizes an AbortSignal-shaped rejection", () => {
    const aborted = new Error("The operation was aborted");
    aborted.name = "AbortError";
    expect(classify(aborted).kind).toBe("aborted");
  });

  test("an SDK abort class that does not set `name` needs the isAbort port", () => {
    // The concrete footgun: `openai`'s APIUserAbortError extends APIError and
    // never assigns `name`, so `error.name` is the inherited "Error". Without
    // the port a deliberate cancellation is attributed as a fault.
    class SdkAbortError extends Error {}
    const sdkAbort = new SdkAbortError("Request was aborted.");
    expect(sdkAbort.name).toBe("Error");

    expect(classify(sdkAbort).kind).toBe("http");
    expect(
      classify(sdkAbort, {
        isAbort: (e) => e instanceof SdkAbortError || isAbortByName(e),
      }).kind,
    ).toBe("aborted");
  });

  test("a widened isAbort still recognizes the default shape", () => {
    class SdkAbortError extends Error {}
    const aborted = new Error("cancelled");
    aborted.name = "AbortError";
    expect(
      classify(aborted, { isAbort: (e) => e instanceof SdkAbortError || isAbortByName(e) })
        .kind,
    ).toBe("aborted");
  });
});

describe("classifyAttemptError host-port failure modes", () => {
  // `AttemptClassification` is a public contract third parties implement, so
  // these are reachable in a way they are not through Monad's own binding.
  test("a throwing asTransportFailure propagates rather than being swallowed", () => {
    expect(() =>
      classifyAttemptError(new Error("upstream"), TARGET, {
        asTransportFailure: () => {
          throw new Error("port bug");
        },
      }),
    ).toThrow(/port bug/);
  });

  test("a throwing categorizeStatus propagates rather than being swallowed", () => {
    expect(() =>
      classifyAttemptError(new FakeTransportError("api", 403), TARGET, {
        asTransportFailure: (e) =>
          e instanceof FakeTransportError
            ? { kind: e.failureKind, statusCode: e.statusCode, retryAfterMs: null }
            : null,
        categorizeStatus: () => {
          throw new Error("port bug");
        },
      }),
    ).toThrow(/port bug/);
  });

  test("an unrecognized failure kind throws rather than routing on a guess", () => {
    // Unreachable in TypeScript; reachable at runtime from a JS host or a
    // version skew. Throwing is right — a kind the disposition matrix has no
    // arm for has no safe default, and guessing could open a breaker.
    expect(() =>
      classifyAttemptError(
        new FakeTransportError("bogus" as TransportFailureKind),
        TARGET,
        classification(),
      ),
    ).toThrow();
  });
});
