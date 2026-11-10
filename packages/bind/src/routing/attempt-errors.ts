/**
 * Classification: a thrown transport error → the {@link InferenceAttemptError}
 * taxonomy the executor routes on.
 *
 * `errors.ts` owns what the router *does* with a classified failure
 * (`failureDisposition`) and `executor.ts` applies it. This module is the step
 * before both — the one every host was writing itself. The PRD's split is
 * "transports classify facts; the executor decides," and shipping only the
 * decider left each consumer to hand-roll the classifier, where the mistakes
 * are not obvious: misfile a moderation refusal as a credential failure and the
 * circuit breaker opens the endpoint for everyone sharing that breaker key —
 * which, for a host that does not set `credentialScope`, is every tenant on the
 * process.
 *
 * The host keeps the two things that are genuinely its own — recognizing its
 * error class ({@link AttemptClassification.asTransportFailure}) and any
 * provider-specific status reading ({@link AttemptClassification.categorizeStatus}).
 * Neither can live here: the first is a class this package must not import, and
 * the second is provider-registry knowledge.
 */

import { categorizeHttpStatus } from "./errors";
import type {
  AttemptTarget,
  HttpFailureCategory,
  InferenceAttemptError,
} from "./errors";
import type { ProviderId } from "./canonical-model";
import type { CompletionDefectKind } from "../completion/defects";

/**
 * What a transport observed, in the vocabulary the taxonomy needs. A host maps
 * its own error class onto this once.
 *
 * `"api"` is the catch-all for a response the provider rejected with a status
 * the transport did not interpret further; it is the only kind whose routing
 * behavior depends on {@link TransportFailure.statusCode}.
 */
export type TransportFailureKind =
  | CompletionDefectKind
  | "server_error"
  | "rate_limit"
  | "no_credits"
  | "api"
  | "network";

export interface TransportFailure {
  readonly kind: TransportFailureKind;
  /** HTTP status when the failure carried one; null for transport-level faults. */
  readonly statusCode: number | null;
  /** Parsed `Retry-After`, which bounds-extends the breaker cooldown. */
  readonly retryAfterMs: number | null;
}

export interface AttemptClassification {
  /**
   * Recognize the host's own transport-error class and describe it. Return
   * `null` for anything that is not one — those propagate as a client error
   * rather than burning the plan (see {@link classifyAttemptError}).
   */
  readonly asTransportFailure: (error: unknown) => TransportFailure | null;
  /**
   * Provider-specific status → category, consulted before the neutral
   * {@link categorizeHttpStatus}. Return `null` to fall through to it.
   *
   * This exists because status codes are not portable across providers: one
   * gateway answers 403 for moderation-flagged *input* (request-shaped — a
   * different provider may accept it, and the endpoint is healthy), where the
   * neutral mapping reads 403 as a credential failure and opens the circuit
   * immediately.
   */
  readonly categorizeStatus?: (
    statusCode: number,
    providerId: ProviderId,
  ) => HttpFailureCategory | null;
  /**
   * Recognize a caller-cancellation. Defaults to {@link isAbortByName} —
   * `error.name === "AbortError"`, which is what `AbortSignal` and `fetch`
   * produce.
   *
   * **Override this if your SDK wraps aborts in its own class.** The one that
   * bites: `openai`'s `APIUserAbortError` extends its `APIError` and never sets
   * `name`, so `error.name` is the inherited `"Error"` — it matches neither the
   * default nor an `instanceof` check you didn't write. Left unrecognized, a
   * deliberate cancellation classifies as a propagating `client_error`: it
   * still stops the plan, but it is attributed as a fault rather than a
   * cancellation, which pollutes failure telemetry and any breaker or retry
   * accounting keyed off it.
   *
   * ```ts
   * isAbort: (e) => e instanceof OpenAI.APIUserAbortError || isAbortByName(e),
   * ```
   */
  readonly isAbort?: (error: unknown) => boolean;
}

/**
 * The default abort test: the `name` an `AbortSignal`-driven `fetch` rejection
 * carries. Exported so a host overriding {@link AttemptClassification.isAbort}
 * can widen it rather than replace it.
 */
export function isAbortByName(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/**
 * Map a thrown error onto the attempt-error taxonomy. The original error rides
 * in `cause` and is re-thrown verbatim if the plan exhausts, so a host's error
 * classes and messages survive routing untouched.
 *
 * Order is deliberate. An abort is checked first: a cancelled call must never
 * be reclassified as a provider fault, whatever else is true of it. Anything
 * the host does not recognize as a transport failure is classified
 * `client_error` — which propagates rather than traverses — because an error
 * that escaped the transport without becoming one of its own is a programming
 * defect (a `TypeError`, a validation throw), and burning every provider and
 * the fallback model retrying a bug wastes a whole plan to arrive at the same
 * exception.
 */
export function classifyAttemptError(
  error: unknown,
  target: AttemptTarget,
  classification: AttemptClassification,
): InferenceAttemptError {
  const cause = error instanceof Error ? error : new Error(String(error));
  const isAbort = classification.isAbort ?? isAbortByName;
  if (isAbort(error)) {
    return { kind: "aborted", target, cause };
  }

  const failure = classification.asTransportFailure(error);
  if (failure === null) {
    return {
      kind: "http",
      category: "client_error",
      statusCode: 0,
      retryAfterMs: null,
      target,
      cause,
    };
  }

  switch (failure.kind) {
    case "empty_completion":
    case "truncated_tool_call":
      return { kind: "completion_defect", defect: failure.kind, target, cause };
    case "network":
      return { kind: "network", target, cause };
    case "rate_limit":
      return httpError("rate_limit", failure.statusCode ?? 429, failure, target, cause);
    case "no_credits":
      return httpError("credits", failure.statusCode ?? 402, failure, target, cause);
    case "server_error":
      return httpError("server_error", failure.statusCode ?? 500, failure, target, cause);
    case "api": {
      const statusCode = failure.statusCode;
      // No status at all means the transport could not attribute the rejection
      // to the endpoint; propagate rather than traverse.
      const category: HttpFailureCategory =
        statusCode === null
          ? "client_error"
          : (classification.categorizeStatus?.(statusCode, target.providerId) ??
            categorizeHttpStatus(statusCode));
      return httpError(category, statusCode ?? 0, failure, target, cause);
    }
    default: {
      const _exhaustive: never = failure.kind;
      throw new Error(`unknown transport failure kind: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

function httpError(
  category: HttpFailureCategory,
  statusCode: number,
  failure: TransportFailure,
  target: AttemptTarget,
  cause: Error,
): InferenceAttemptError {
  return {
    kind: "http",
    category,
    statusCode,
    retryAfterMs: failure.retryAfterMs,
    target,
    cause,
  };
}

/**
 * Parse a `Retry-After` response header into milliseconds, per RFC 9110: either
 * delta-seconds or an HTTP-date. Returns `null` when absent or unparseable —
 * the breaker then falls back to its own cooldown, so a header this cannot read
 * degrades to the default rather than to no cooldown at all.
 *
 * **This value is attacker-influenceable and is not bounded here.** It comes
 * from whatever answered the request — the provider, a gateway, a proxy — and
 * RFC 9110 puts no ceiling on it, so a hostile or malfunctioning upstream can
 * ask for a delay of years. Clamp before using it as a delay:
 * {@link createCircuitBreaker} already does (`maxCooldownMs`), but a host that
 * sleeps on this directly must impose its own bound, or one bad response header
 * parks an endpoint indefinitely.
 *
 * `headers` is deliberately `unknown`: SDKs hand back a `Headers`, a plain
 * object, or a `Map` depending on version and runtime. Anything with a `get`
 * method is asked for the header (covering `Headers` and `Map` without naming
 * either global, which keeps this portable to runtimes that ship neither);
 * a plain object is read case-insensitively for the two spellings that occur
 * in practice.
 *
 * @param now Injectable clock for the HTTP-date branch; defaults to `Date.now`.
 */
export function retryAfterMsFromHeaders(
  headers: unknown,
  now: () => number = Date.now,
): number | null {
  const raw = rawRetryAfter(headers);
  if (raw === null || raw === "") return null;

  const seconds = Number(raw);
  if (Number.isFinite(seconds)) {
    // A negative delta is malformed, and the date branch below would not
    // reliably reject a bare "-5" either. Reject here instead.
    if (seconds < 0) return null;
    // `1e308` is finite but overflows to Infinity once scaled to ms, and a
    // non-finite delay is the one value that makes a timer fire immediately
    // rather than never — the same trap `requirePositiveMs` guards in the
    // watchdog. Refuse it rather than hand a caller a poisoned number.
    const ms = Math.round(seconds * 1000);
    return Number.isFinite(ms) ? ms : null;
  }

  const dateMs = Date.parse(raw);
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - now());
  return null;
}

function rawRetryAfter(headers: unknown): string | null {
  if (typeof headers !== "object" || headers === null) return null;

  const getter = (headers as { get?: unknown }).get;
  if (typeof getter === "function") {
    // The getter belongs to the caller's object, so it is arbitrary code. This
    // runs inside a host's `catch` while classifying a failure; letting a throw
    // escape would replace the real provider error with this one and lose the
    // classification entirely.
    let value: unknown;
    try {
      value = (getter as (name: string) => unknown).call(headers, "retry-after");
    } catch {
      return null;
    }
    if (typeof value === "string") return value;
    // A `Map<string, number>` is as plausible as a `Map<string, string>`; the
    // plain-object branch below accepts a number, so this one must too or the
    // same header is read from one container and dropped from the other.
    if (typeof value === "number") return String(value);
    return null;
  }

  const record = headers as Record<string, unknown>;
  const value = record["retry-after"] ?? record["Retry-After"];
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return null;
}
