import type { CanonicalModelId, ProviderId } from "./canonical-model";

/**
 * The normative attempt-order cursor (LLM Provider Routing PRD §5.2):
 * structured-output attempt → model stage → provider candidate → same-endpoint
 * retry. No other ordering input exists.
 */
export interface RouteAttemptCursor {
  /** 0 for the first result; 1..3 for structured-output parse retries. */
  readonly structuredOutputAttempt: number;
  /** Primary stage first, then the optional fallback-model stage. */
  readonly stageIndex: number;
  /** Provider order inside `RouteStage.candidates`. */
  readonly candidateIndex: number;
  /** 0 for the first request; 1..N for same-endpoint completion-defect retries. */
  readonly endpointAttempt: number;
}

export interface AttemptTarget {
  readonly cursor: RouteAttemptCursor;
  readonly providerId: ProviderId;
  readonly canonicalModelId: CanonicalModelId;
  readonly providerInvocationModel: string;
  readonly durationMs: number;
}

export type HttpFailureCategory =
  | "timeout"
  | "rate_limit"
  | "server_error"
  | "credential"
  | "credits"
  | "provider_bad_request"
  | "client_error";

/**
 * Classified attempt failures (PRD §7.1). Transports classify facts; they do
 * not decide route order — `failureDisposition` is the single ordering
 * authority. `cause` stays in memory for logging/chaining and is never
 * serialized into persistence.
 */
export type InferenceAttemptError =
  | Readonly<{ kind: "aborted"; target: AttemptTarget; cause: Error }>
  | Readonly<{
      kind: "completion_defect";
      defect: "empty_completion" | "truncated_tool_call";
      target: AttemptTarget;
      cause: Error;
    }>
  | Readonly<{ kind: "network"; target: AttemptTarget; cause: Error }>
  | Readonly<{
      kind: "http";
      category: HttpFailureCategory;
      statusCode: number;
      retryAfterMs: number | null;
      target: AttemptTarget;
      cause: Error;
    }>;

export type BreakerEffect = "none" | "record_failure" | "open_immediately";

/**
 * What the executor may do after a classified failure. All fields are
 * required — this is a flags record, not an options bag — so the disposition
 * matrix in the PRD (§7.1) is total and testable.
 */
export interface FailureDisposition {
  /** Eligible for the same-endpoint completion-defect retry budget. */
  readonly sameEndpointRetry: boolean;
  /** May traverse to the next provider candidate for the same model. */
  readonly nextProvider: boolean;
  /** May traverse into the fallback-model stage. */
  readonly fallbackModel: boolean;
  readonly breaker: BreakerEffect;
  /** Return to the caller immediately; no further traversal. */
  readonly propagate: boolean;
}

const PROPAGATE: FailureDisposition = Object.freeze({
  sameEndpointRetry: false,
  nextProvider: false,
  fallbackModel: false,
  breaker: "none",
  propagate: true,
});

const DEFECT: FailureDisposition = Object.freeze({
  sameEndpointRetry: true,
  nextProvider: true,
  fallbackModel: true,
  breaker: "record_failure",
  propagate: false,
});

const RETRIABLE_TRANSPORT: FailureDisposition = Object.freeze({
  sameEndpointRetry: false,
  nextProvider: true,
  fallbackModel: true,
  breaker: "record_failure",
  propagate: false,
});

/**
 * Request-shaped rejections (a 400, a moderation refusal): another provider
 * may accept the request, so traverse — but the ENDPOINT is healthy, so the
 * breaker must not count it. Otherwise one tenant's malformed/flagged prompt
 * degrades the shared endpoint for everyone (see PRD §7.2).
 */
const REQUEST_SHAPED: FailureDisposition = Object.freeze({
  sameEndpointRetry: false,
  nextProvider: true,
  fallbackModel: true,
  breaker: "none",
  propagate: false,
});

const CREDENTIAL_FAILURE: FailureDisposition = Object.freeze({
  sameEndpointRetry: false,
  nextProvider: true,
  fallbackModel: true,
  breaker: "open_immediately",
  propagate: false,
});

/**
 * The disposition for a failure whose attempt **already produced output the
 * caller cannot take back** — tokens streamed to a UI, or a provider-side
 * effect a replay would repeat.
 *
 * Every other input to `failureDisposition` is a property of the *error*. This
 * one is a property of the *attempt*, and only the host knows it: a transport
 * that buffers the whole completion before returning can always replay, and one
 * that forwards deltas to a live view cannot. So it arrives as a fact on the
 * failure outcome rather than as another arm of the taxonomy.
 *
 * Traversal is withheld entirely — not just the same-endpoint retry. Trying the
 * next provider re-renders the same turn, which is the same duplication with a
 * different label on it.
 *
 * The **breaker effect is preserved**: the endpoint really did fail, and that is
 * true regardless of how far the response got. Suppressing it here would hide a
 * dying endpoint from every later call precisely because it dies late.
 */
export function propagateOnly(
  disposition: FailureDisposition,
): FailureDisposition {
  if (disposition.propagate) return disposition;
  return Object.freeze({
    sameEndpointRetry: false,
    nextProvider: false,
    fallbackModel: false,
    breaker: disposition.breaker,
    propagate: true,
  });
}

/**
 * The exhaustive failure → routing-behavior matrix (PRD §7.1). Pure; the
 * executor applies it, the circuit breaker consumes its `breaker` effect.
 */
export function failureDisposition(error: InferenceAttemptError): FailureDisposition {
  switch (error.kind) {
    case "aborted":
      return PROPAGATE;
    case "completion_defect":
      return DEFECT;
    case "network":
      return RETRIABLE_TRANSPORT;
    case "http":
      switch (error.category) {
        case "timeout":
        case "rate_limit":
        case "server_error":
          return RETRIABLE_TRANSPORT;
        case "provider_bad_request":
          return REQUEST_SHAPED;
        case "credential":
        case "credits":
          return CREDENTIAL_FAILURE;
        case "client_error":
          return PROPAGATE;
        default: {
          const _exhaustive: never = error.category;
          throw new Error(`unknown http category: ${JSON.stringify(_exhaustive)}`);
        }
      }
    default: {
      const _exhaustive: never = error;
      throw new Error(`unknown attempt error: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

/**
 * Default HTTP status → category mapping. A transport may override per
 * provider (e.g. OpenRouter reports credit exhaustion as 402; another
 * provider may use 403 with a body marker) — this is only the neutral
 * baseline.
 */
export function categorizeHttpStatus(statusCode: number): HttpFailureCategory {
  if (statusCode === 408) return "timeout";
  if (statusCode === 429) return "rate_limit";
  if (statusCode >= 500) return "server_error";
  if (statusCode === 401 || statusCode === 403) return "credential";
  if (statusCode === 402) return "credits";
  if (statusCode === 400) return "provider_bad_request";
  return "client_error";
}

/**
 * Whether a FRESH ATTEMPT LATER could plausibly succeed — the caller-facing
 * "retriable" used to pick the most useful error when a whole plan fails
 * (PRD §5.2 step 6: prefer a retriable primary-path error over a
 * non-retriable stale fallback binding, so the host's queue-level retry
 * still fires).
 *
 * Deliberately NOT the same notion as route-traversal eligibility: a
 * provider-specific 400 traverses to the next provider (a different provider
 * may accept the request shape — `failureDisposition`), but retrying the
 * same exhausted plan later won't fix it, so it is not caller-retriable.
 * Credential/credit failures likewise traverse but need operator action, not
 * time.
 */
export function isRetriableAttemptError(error: InferenceAttemptError): boolean {
  switch (error.kind) {
    case "aborted":
      return false;
    case "completion_defect":
    case "network":
      return true;
    case "http":
      switch (error.category) {
        case "timeout":
        case "rate_limit":
        case "server_error":
          return true;
        case "provider_bad_request":
        case "credential":
        case "credits":
        case "client_error":
          return false;
        default: {
          const _exhaustive: never = error.category;
          throw new Error(`unknown http category: ${JSON.stringify(_exhaustive)}`);
        }
      }
    default: {
      const _exhaustive: never = error;
      throw new Error(`unknown attempt error: ${JSON.stringify(_exhaustive)}`);
    }
  }
}
