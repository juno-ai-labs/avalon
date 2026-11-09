import { describe, expect, it } from "vitest";
import {
  categorizeHttpStatus,
  failureDisposition,
  isRetriableAttemptError,
  propagateOnly,
  type HttpFailureCategory,
  type InferenceAttemptError,
} from "../errors";
import { httpError, makeCandidate, target } from "./fixtures";

const CANDIDATE = makeCandidate("openrouter", "openai/some-model");
const CURSOR = {
  structuredOutputAttempt: 0,
  stageIndex: 0,
  candidateIndex: 0,
  endpointAttempt: 0,
};

function err(kind: "aborted" | "network"): InferenceAttemptError {
  return { kind, target: target(CANDIDATE, CURSOR), cause: new Error(kind) };
}

function defect(
  which: "empty_completion" | "truncated_tool_call",
): InferenceAttemptError {
  return {
    kind: "completion_defect",
    defect: which,
    target: target(CANDIDATE, CURSOR),
    cause: new Error(which),
  };
}

describe("failureDisposition", () => {
  it("propagates caller aborts immediately with no breaker mutation", () => {
    expect(failureDisposition(err("aborted"))).toEqual({
      sameEndpointRetry: false,
      nextProvider: false,
      fallbackModel: false,
      breaker: "none",
      propagate: true,
    });
  });

  it("gives completion defects the same-endpoint budget then full traversal", () => {
    for (const which of ["empty_completion", "truncated_tool_call"] as const) {
      expect(failureDisposition(defect(which))).toEqual({
        sameEndpointRetry: true,
        nextProvider: true,
        fallbackModel: true,
        breaker: "record_failure",
        propagate: false,
      });
    }
  });

  it("treats network and retriable http failures as provider-fallbackable", () => {
    const categories: readonly HttpFailureCategory[] = [
      "timeout",
      "rate_limit",
      "server_error",
    ];
    for (const category of categories) {
      const disposition = failureDisposition(
        httpError(CANDIDATE, CURSOR, 500, category),
      );
      expect(disposition.nextProvider).toBe(true);
      expect(disposition.fallbackModel).toBe(true);
      expect(disposition.breaker).toBe("record_failure");
      expect(disposition.propagate).toBe(false);
    }
    expect(failureDisposition(err("network")).nextProvider).toBe(true);
  });

  it("request-shaped 400s traverse but never count against endpoint health", () => {
    // A malformed/moderation-flagged REQUEST says nothing about the
    // endpoint. Counting it would let one caller's bad prompts open a
    // shared circuit for everyone (security review P1).
    const disposition = failureDisposition(
      httpError(CANDIDATE, CURSOR, 400, "provider_bad_request"),
    );
    expect(disposition.nextProvider).toBe(true);
    expect(disposition.fallbackModel).toBe(true);
    expect(disposition.breaker).toBe("none");
    expect(disposition.propagate).toBe(false);
  });

  it("matrix invariant: every non-propagating disposition traverses fully", () => {
    // The executor's !nextProvider / !fallbackModel branches are anticipatory
    // (unreachable under this matrix); this pins the invariant that keeps
    // them dead so a future disposition changing it is a conscious choice.
    const kinds: readonly HttpFailureCategory[] = [
      "timeout", "rate_limit", "server_error", "provider_bad_request",
      "credential", "credits",
    ];
    for (const category of kinds) {
      const d = failureDisposition(httpError(CANDIDATE, CURSOR, 400, category));
      if (!d.propagate) {
        expect(d.nextProvider).toBe(true);
        expect(d.fallbackModel).toBe(true);
      }
    }
  });

  it("opens the circuit immediately for credential/credit failures but still traverses", () => {
    for (const category of ["credential", "credits"] as const) {
      const disposition = failureDisposition(
        httpError(CANDIDATE, CURSOR, 401, category),
      );
      expect(disposition.breaker).toBe("open_immediately");
      expect(disposition.nextProvider).toBe(true);
    }
  });

  it("propagates other 4xx as caller errors", () => {
    const disposition = failureDisposition(
      httpError(CANDIDATE, CURSOR, 404, "client_error"),
    );
    expect(disposition).toEqual({
      sameEndpointRetry: false,
      nextProvider: false,
      fallbackModel: false,
      breaker: "none",
      propagate: true,
    });
  });
});

describe("categorizeHttpStatus", () => {
  it("maps statuses to the PRD categories", () => {
    expect(categorizeHttpStatus(408)).toBe("timeout");
    expect(categorizeHttpStatus(429)).toBe("rate_limit");
    expect(categorizeHttpStatus(500)).toBe("server_error");
    expect(categorizeHttpStatus(503)).toBe("server_error");
    expect(categorizeHttpStatus(401)).toBe("credential");
    expect(categorizeHttpStatus(403)).toBe("credential");
    expect(categorizeHttpStatus(402)).toBe("credits");
    expect(categorizeHttpStatus(400)).toBe("provider_bad_request");
    expect(categorizeHttpStatus(404)).toBe("client_error");
    expect(categorizeHttpStatus(422)).toBe("client_error");
  });
});

describe("isRetriableAttemptError", () => {
  it("marks retriable transport failures and defects, not aborts/client errors", () => {
    expect(isRetriableAttemptError(err("network"))).toBe(true);
    expect(isRetriableAttemptError(defect("empty_completion"))).toBe(true);
    expect(isRetriableAttemptError(err("aborted"))).toBe(false);
    expect(
      isRetriableAttemptError(httpError(CANDIDATE, CURSOR, 404, "client_error")),
    ).toBe(false);
  });

  it("diverges from traversal eligibility on 400/credential/credit failures", () => {
    // These traverse to the next provider (failureDisposition) but a fresh
    // attempt later cannot fix them — they are not caller-retriable, so a
    // retriable primary error must win over them in final-error preference.
    for (const [status, category] of [
      [400, "provider_bad_request"],
      [401, "credential"],
      [402, "credits"],
    ] as const) {
      const error = httpError(CANDIDATE, CURSOR, status, category);
      expect(failureDisposition(error).nextProvider).toBe(true);
      expect(isRetriableAttemptError(error)).toBe(false);
    }
  });
});

describe("propagateOnly", () => {
  // The clamp for an attempt that already put bytes on the wire. Tested here
  // rather than only through the executor because the executor only ever
  // routes ONE of the three breaker effects through it, so two thirds of this
  // function is unreachable from that suite.
  const clamp = (error: InferenceAttemptError) =>
    propagateOnly(failureDisposition(error));

  it("withholds every form of traversal", () => {
    expect(clamp(defect("truncated_tool_call"))).toEqual({
      sameEndpointRetry: false,
      nextProvider: false,
      fallbackModel: false,
      breaker: "record_failure",
      propagate: true,
    });
  });

  it("preserves a request-shaped failure's breaker exemption", () => {
    // The invariant this suite already pins for the unclamped path: a 400 is
    // the CALLER's fault, so it must never count against endpoint health, or
    // one user's malformed prompt degrades a shared endpoint for everyone.
    // A clamp that flattened `breaker` to a constant would silently re-open
    // that hole for any 400 arriving after the first token.
    expect(clamp(httpError(CANDIDATE, CURSOR, 400, "provider_bad_request")).breaker).toBe(
      "none",
    );
  });

  it("preserves an immediate-open breaker effect", () => {
    // A revoked or exhausted credential must still trip the circuit fast, even
    // when it dies late in the stream — downgrading it to a counted failure
    // keeps a dead key in rotation.
    for (const category of ["credential", "credits"] as const) {
      const status = category === "credential" ? 401 : 402;
      expect(clamp(httpError(CANDIDATE, CURSOR, status, category)).breaker).toBe(
        "open_immediately",
      );
    }
  });

  it("returns an already-propagating disposition unchanged, and is idempotent", () => {
    const aborted = failureDisposition({
      kind: "aborted",
      target: target(CANDIDATE, CURSOR),
      cause: new Error("cancelled"),
    });
    expect(propagateOnly(aborted)).toBe(aborted);
    const once = clamp(defect("empty_completion"));
    expect(propagateOnly(once)).toEqual(once);
  });
});
