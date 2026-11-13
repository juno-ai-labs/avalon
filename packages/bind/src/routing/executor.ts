import type { RouteCandidate, RoutePlan } from "./plan";
import {
  attemptDisposition,
  isRetriableAttemptError,
  type InferenceAttemptError,
  type RouteAttemptCursor,
} from "./errors";
import type { RouteCircuitBreaker } from "./circuit-breaker";

export type AttemptOutcome<T> =
  | Readonly<{ kind: "success"; value: T }>
  | Readonly<{
      kind: "failure";
      error: InferenceAttemptError;
      /**
       * This attempt already put output somewhere the caller cannot take it
       * back — tokens forwarded to a live view, or a provider-side effect a
       * replay would repeat. The executor then **withholds all traversal** and
       * propagates, because retrying re-renders a turn the user has partly seen.
       *
       * Omitted means replayable, which is right for a transport that buffers
       * the whole completion before returning — it has shown nobody anything
       * yet. Set it from the transport, at the point the first byte leaves:
       * a boolean the transport flips when it forwards its first delta.
       */
      producedOutput?: boolean;
    }>;

/**
 * One provider request. The host's transport adapter performs the network
 * call, measures duration, and classifies any failure into
 * `InferenceAttemptError` (transports classify facts; the executor owns
 * route order — PRD §7.1).
 */
export type AttemptFn<T> = (
  candidate: RouteCandidate,
  cursor: RouteAttemptCursor,
) => Promise<AttemptOutcome<T>>;

export type FallbackKind = "none" | "provider" | "model" | "provider_and_model";

export interface ExecutePlanOptions<T> {
  readonly plan: RoutePlan;
  readonly attempt: AttemptFn<T>;
  /** Stamped into cursors; the caller owns structured-output retry loops. */
  readonly structuredOutputAttempt?: number;
  /** Same-endpoint retry budget for completion defects. Default 2 (PRD §5.2). */
  readonly completionDefectRetries?: number;
  /** Optional per-endpoint circuit breaker (PRD §7.2). */
  readonly breaker?: RouteCircuitBreaker | null;
}

export type RouteExecutionResult<T> =
  | Readonly<{
      ok: true;
      value: T;
      served: RouteCandidate;
      cursor: RouteAttemptCursor;
      fallbackKind: FallbackKind;
      attemptCount: number;
      failures: readonly InferenceAttemptError[];
    }>
  | Readonly<{
      ok: false;
      reason: "no_viable_endpoints";
      attemptCount: 0;
      failures: readonly [];
    }>
  | Readonly<{
      ok: false;
      reason: "attempts_exhausted";
      error: InferenceAttemptError;
      attemptCount: number;
      failures: readonly InferenceAttemptError[];
    }>;

/**
 * Drive one structured-output attempt over a frozen route plan with the
 * normative loop nesting (PRD §5.2): model stage → provider candidate →
 * same-endpoint retry. Pure with respect to I/O — every request goes through
 * `attempt`, every clock read through the injected breaker.
 */
export async function executeRoutePlan<T>(
  options: ExecutePlanOptions<T>,
): Promise<RouteExecutionResult<T>> {
  const structuredOutputAttempt = options.structuredOutputAttempt ?? 0;
  const defectRetries = options.completionDefectRetries ?? 2;
  const breaker = options.breaker ?? null;

  const failures: InferenceAttemptError[] = [];
  let attemptCount = 0;
  let anyCandidateSeen = false;

  for (let stageIndex = 0; stageIndex < options.plan.stages.length; stageIndex++) {
    const stage = options.plan.stages[stageIndex];
    if (stage === undefined) continue;

    for (
      let candidateIndex = 0;
      candidateIndex < stage.candidates.length;
      candidateIndex++
    ) {
      const candidate = stage.candidates[candidateIndex];
      if (candidate === undefined) continue;
      anyCandidateSeen = true;

      const breakerKey = {
        providerId: candidate.providerId,
        invocationModel: candidate.providerInvocationModel,
        credentialSource: candidate.credentialSource,
        credentialScope: candidate.breakerScope,
      };
      let halfOpenProbe = false;
      if (breaker !== null) {
        const admission = breaker.admit(breakerKey);
        if (!admission.admitted) continue;
        halfOpenProbe = admission.halfOpenProbe;
      }

      for (let endpointAttempt = 0; endpointAttempt <= defectRetries; endpointAttempt++) {
        const cursor: RouteAttemptCursor = Object.freeze({
          structuredOutputAttempt,
          stageIndex,
          candidateIndex,
          endpointAttempt,
        });

        attemptCount += 1;
        // `attempt` is host code and is expected to resolve to an outcome, not
        // throw — but if it does throw (a bug in its own classification, a
        // host-supplied port raising), the throw must not carry a half-open
        // probe out of the loop with it. The probe slot would stay occupied for
        // the process's lifetime and every later call for this endpoint would
        // be refused admission, silently, with no failure recorded to ever
        // reopen it.
        let outcome: AttemptOutcome<T>;
        try {
          outcome = await options.attempt(candidate, cursor);
        } catch (error) {
          if (halfOpenProbe) breaker?.releaseProbe(breakerKey);
          throw error;
        }

        if (outcome.kind === "success") {
          breaker?.recordSuccess(breakerKey);
          return {
            ok: true,
            value: outcome.value,
            served: candidate,
            cursor,
            fallbackKind: fallbackKindFor(stage.kind, candidateIndex),
            attemptCount,
            failures,
          };
        }

        failures.push(outcome.error);
        // The clamp is applied to the taxonomy's answer rather than folded into
        // it, so `failureDisposition` stays total over the error kinds and this
        // stays one testable step. See `propagateOnly`.
        const disposition = attemptDisposition(outcome.error, outcome.producedOutput === true);

        switch (disposition.breaker) {
          case "none":
            // A breaker-invisible failure (abort, propagated client error)
            // must still resolve a half-open probe, or the probe slot stays
            // occupied forever and the endpoint is refused until restart.
            if (halfOpenProbe) breaker?.releaseProbe(breakerKey);
            break;
          case "record_failure":
            breaker?.recordFailure(breakerKey, {
              retryAfterMs: retryAfterOf(outcome.error),
            });
            break;
          case "open_immediately":
            breaker?.recordFailure(breakerKey, {
              openImmediately: true,
              retryAfterMs: retryAfterOf(outcome.error),
            });
            break;
          default: {
            const _exhaustive: never = disposition.breaker;
            throw new Error(`unknown breaker effect: ${JSON.stringify(_exhaustive)}`);
          }
        }

        if (disposition.propagate) {
          return {
            ok: false,
            reason: "attempts_exhausted",
            error: outcome.error,
            attemptCount,
            failures,
          };
        }

        if (disposition.sameEndpointRetry && endpointAttempt < defectRetries) {
          continue; // consume the same-endpoint defect budget
        }
        // ANTICIPATORY: unreachable under the current disposition matrix
        // (every non-propagating disposition traverses fully — pinned by the
        // matrix-invariant test in errors.test.ts). Kept so a future
        // asymmetric disposition is honored without an executor change.
        if (!disposition.nextProvider) {
          // The disposition matrix forbids trying another provider for this
          // model; move (at most) into the fallback-model stage.
          if (!disposition.fallbackModel) {
            const error = preferredFinalError(failures, options.plan.stages.length);
            if (error !== null) {
              return { ok: false, reason: "attempts_exhausted", error, attemptCount, failures };
            }
          }
          candidateIndex = stage.candidates.length; // exit the candidate loop
        }
        if (!disposition.fallbackModel) {
          stageIndex = options.plan.stages.length; // no fallback-model traversal
        }
        break; // leave the same-endpoint retry loop
      }
    }
  }

  if (!anyCandidateSeen && failures.length === 0) {
    return { ok: false, reason: "no_viable_endpoints", attemptCount: 0, failures: [] };
  }

  const error = preferredFinalError(failures, options.plan.stages.length);
  if (error === null) {
    // Candidates existed but every one was skipped by the breaker.
    return { ok: false, reason: "no_viable_endpoints", attemptCount: 0, failures: [] };
  }
  return { ok: false, reason: "attempts_exhausted", error, attemptCount, failures };
}

/**
 * Derive the fallback classification from an attempt cursor — the single
 * shared derivation for hosts that attribute per-attempt (e.g. inference
 * logging inside a transport adapter) before the executor returns.
 */
export function fallbackKindOfCursor(cursor: {
  readonly stageIndex: number;
  readonly candidateIndex: number;
}): FallbackKind {
  if (cursor.stageIndex > 0) {
    return cursor.candidateIndex > 0 ? "provider_and_model" : "model";
  }
  return cursor.candidateIndex > 0 ? "provider" : "none";
}

function fallbackKindFor(
  stageKind: "primary" | "fallback_model",
  candidateIndex: number,
): FallbackKind {
  const providerFallback = candidateIndex > 0;
  switch (stageKind) {
    case "primary":
      return providerFallback ? "provider" : "none";
    case "fallback_model":
      return providerFallback ? "provider_and_model" : "model";
    default: {
      const _exhaustive: never = stageKind;
      throw new Error(`unknown stage kind: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

function retryAfterOf(error: InferenceAttemptError): number | null {
  return error.kind === "http" ? error.retryAfterMs : null;
}

/**
 * PRD §5.2 step 6: when everything failed, prefer a retriable primary-stage
 * error over a non-retriable error from the fallback stage (a stale fallback
 * binding must not mask the actionable primary failure); otherwise report the
 * final classified failure.
 */
function preferredFinalError(
  failures: readonly InferenceAttemptError[],
  stageCount: number,
): InferenceAttemptError | null {
  const last = failures.at(-1);
  if (last === undefined) return null;
  if (stageCount < 2) return last;
  if (isRetriableAttemptError(last)) return last;
  if (last.target.cursor.stageIndex === 0) return last;
  const primaryRetriable = failures.find(
    (failure) =>
      failure.target.cursor.stageIndex === 0 && isRetriableAttemptError(failure),
  );
  return primaryRetriable ?? last;
}
