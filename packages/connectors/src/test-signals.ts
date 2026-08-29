/**
 * Abort signals for connector tests.
 *
 * Handing a real `AbortSignal.timeout(...)` into an adapter makes the test race
 * the process: connector code branches on `signal.aborted` — the hydration
 * swallow in `index.ts` and the pre-refresh `throwIfAborted()` in
 * `provider-utils.ts` both do — so a stall longer than the timeout turns an
 * expected degradation or credential refresh into a rethrown abort. A test that
 * is not about cancellation takes `neverAborts()`; one that is takes
 * `alreadyAborted()`, which reaches that branch on purpose rather than by
 * accident of scheduling.
 */

/** A signal that never fires, for any call that is not asserting cancellation. */
export function neverAborts(): AbortSignal {
  return new AbortController().signal;
}

/** A signal that is already aborted, for the branches that must observe one. */
export function alreadyAborted(): AbortSignal {
  return AbortSignal.abort();
}
