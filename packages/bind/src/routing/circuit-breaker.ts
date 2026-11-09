import type { ProviderId } from "./canonical-model";
import type { CredentialSource } from "./plan";

/**
 * Circuit-breaker state is keyed by (provider, invocation model, credential
 * source) — LLM Provider Routing PRD §7.2. State is process-local in v1;
 * deterministic routing and provider telemetry make replica differences
 * observable.
 */
export interface BreakerKey {
  readonly providerId: ProviderId;
  readonly invocationModel: string;
  readonly credentialSource: CredentialSource;
  /**
   * Optional non-secret credential identity (e.g. an opaque per-tenant tag)
   * that further scopes the endpoint state. Without it, one tenant's revoked
   * BYOK key would open the circuit for every tenant whose calls share
   * `credentialSource: "tenant"` on this process. Never put key material here
   * — the value lands in breaker state keys.
   */
  readonly credentialScope?: string | undefined;
}

export interface CircuitBreakerOptions {
  /** Consecutive fallbackable failures before the circuit opens. Default 3. */
  readonly failureThreshold?: number;
  /** Default cooldown once open, in ms. Default 60_000. */
  readonly cooldownMs?: number;
  /** Upper bound on any cooldown, including Retry-After extensions. Default 60_000. */
  readonly maxCooldownMs?: number;
  /** Injectable clock for tests. Defaults to Date.now. */
  readonly now?: () => number;
}

export type EndpointAdmission =
  | Readonly<{ admitted: true; halfOpenProbe: boolean }>
  | Readonly<{ admitted: false; retryAtMs: number }>;

export interface RecordFailureOptions {
  /**
   * Open immediately regardless of the consecutive count — used for
   * credential/credit failures, which repeated requests cannot repair.
   */
  readonly openImmediately?: boolean;
  /** Bounded Retry-After hint; extends the cooldown up to `maxCooldownMs`. */
  readonly retryAfterMs?: number | null;
}

interface EndpointState {
  consecutiveFailures: number;
  /** Epoch ms until which the circuit is open; 0 when closed. */
  openUntilMs: number;
  /** True while a half-open probe is in flight. */
  probeInFlight: boolean;
}

export interface RouteCircuitBreaker {
  /**
   * Ask to attempt an endpoint. Closed circuits admit; open circuits refuse
   * until cooldown elapses; after cooldown exactly one caller is admitted as
   * a half-open probe while others keep being refused until the probe
   * resolves via `recordSuccess`/`recordFailure`.
   */
  admit(key: BreakerKey): EndpointAdmission;
  recordSuccess(key: BreakerKey): void;
  recordFailure(key: BreakerKey, options?: RecordFailureOptions): void;
  /**
   * Resolve a half-open probe that ended without a success or a
   * breaker-recordable failure (an abort, a propagated client error). The
   * probe slot is freed and the cooldown re-armed, so the next admit after
   * cooldown runs a fresh probe instead of refusing forever. No-op when no
   * probe is in flight.
   */
  releaseProbe(key: BreakerKey): void;
}

function keyString(key: BreakerKey): string {
  return `${key.providerId} ${key.invocationModel} ${key.credentialSource} ${key.credentialScope ?? ""}`;
}

export function createCircuitBreaker(
  options: CircuitBreakerOptions = {},
): RouteCircuitBreaker {
  const failureThreshold = options.failureThreshold ?? 3;
  const cooldownMs = options.cooldownMs ?? 60_000;
  const maxCooldownMs = options.maxCooldownMs ?? 60_000;
  const now = options.now ?? (() => Date.now());
  const states = new Map<string, EndpointState>();

  function stateFor(key: BreakerKey): EndpointState {
    const k = keyString(key);
    const existing = states.get(k);
    if (existing !== undefined) return existing;
    const created: EndpointState = {
      consecutiveFailures: 0,
      openUntilMs: 0,
      probeInFlight: false,
    };
    states.set(k, created);
    return created;
  }

  function open(state: EndpointState, retryAfterMs: number | null | undefined): void {
    const extension = Math.max(cooldownMs, retryAfterMs ?? 0);
    state.openUntilMs = now() + Math.min(extension, maxCooldownMs);
    state.probeInFlight = false;
  }

  return {
    admit(key) {
      // No stored state = healthy endpoint. Don't allocate on the happy
      // path: keys include an unbounded per-tenant scope, and inserting on
      // every admit would grow the map monotonically for the process
      // lifetime (three reviewers independently flagged the leak).
      const existing = states.get(keyString(key));
      if (existing === undefined) return { admitted: true, halfOpenProbe: false };
      const state = existing;
      if (state.openUntilMs === 0) return { admitted: true, halfOpenProbe: false };
      const at = now();
      if (at < state.openUntilMs) return { admitted: false, retryAtMs: state.openUntilMs };
      // Probe in flight past cooldown: the stored deadline is already in the
      // past, so report "try again now-ish" rather than a stale timestamp.
      if (state.probeInFlight) {
        return { admitted: false, retryAtMs: Math.max(state.openUntilMs, at) };
      }
      state.probeInFlight = true;
      return { admitted: true, halfOpenProbe: true };
    },
    recordSuccess(key) {
      // A clean endpoint needs no state — drop the entry so the map only
      // ever holds currently-failing/cooling endpoints.
      states.delete(keyString(key));
    },
    recordFailure(key, failureOptions = {}) {
      const state = stateFor(key);
      state.consecutiveFailures += 1;
      const shouldOpen =
        failureOptions.openImmediately === true ||
        state.consecutiveFailures >= failureThreshold ||
        // A failed half-open probe reopens regardless of the counter.
        state.probeInFlight;
      if (shouldOpen) open(state, failureOptions.retryAfterMs);
    },
    releaseProbe(key) {
      const state = stateFor(key);
      if (!state.probeInFlight) return;
      // Re-arm the cooldown rather than closing: the probe told us nothing,
      // and immediately admitting another caller would thrash the endpoint.
      open(state, null);
    },
  };
}
