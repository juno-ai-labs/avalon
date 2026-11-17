/**
 * The delay before a Queue message's next delivery: 5 s doubling per attempt,
 * capped at 300 s. `attempts` is the platform's `message.attempts` for the
 * delivery that failed (1 on the first).
 */
export function queueRetryDelaySeconds(attempts: number): number {
  return Math.min(300, 5 * 2 ** Math.min(Math.max(1, attempts) - 1, 6));
}
