/**
 * Whether a failed activation already recorded its subordinate execution receipt.
 *
 * A caller that undoes its own preparation after a failed activation — the
 * digest scheduler releasing an occurrence's claim and work stream — has to
 * distinguish refusal before the durable receipt from any later failure. Once
 * the receipt exists, a retry replays the same activation and must not replace
 * the work stream or mint a second logical loop.
 *
 * The marker lives outside either service because tests replace those modules
 * independently. A registered symbol survives that boundary without colliding
 * with ordinary error fields.
 */
const LOOP_ACTIVATION_RECORDED = Symbol.for("rally.loopActivationRecorded");

export function markLoopActivationRecorded<T extends Error>(error: T): T {
  return Object.assign(error, { [LOOP_ACTIVATION_RECORDED]: true });
}

/** Unmarked errors occurred before the durable execution receipt committed. */
export function loopActivationWasRecorded(error: unknown): boolean {
  return typeof error === "object" && error !== null
    && (error as Record<symbol, unknown>)[LOOP_ACTIVATION_RECORDED] === true;
}
