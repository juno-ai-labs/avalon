/**
 * The delay before a Queue message's next delivery: 5 s doubling per attempt,
 * capped at 300 s. `attempts` is the platform's `message.attempts` for the
 * delivery that failed (1 on the first).
 *
 * One schedule for every lane whose failure is transient by nature — a source
 * still changing under the job, an object mid-upgrade, a provider briefly
 * unavailable. A retry with no delay is redelivered within seconds, so a
 * message whose cause takes longer than that to clear spends every retry the
 * consumer configures and lands in the dead-letter queue having waited for
 * nothing. A caller with a provider's own Retry-After takes the larger of the
 * two itself.
 */
export function queueRetryDelaySeconds(attempts: number): number {
  return Math.min(300, 5 * 2 ** Math.min(Math.max(1, attempts) - 1, 6));
}
