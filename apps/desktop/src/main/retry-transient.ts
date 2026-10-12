/**
 * Run `attempt` up to `attempts` times, retrying only failures `transient`
 * accepts and waiting `delaysMs[n]` before retry n + 1. A failure that is not
 * transient, or the last one, is thrown as it is.
 *
 * Safe only for an attempt whose repeat cannot do harm: the caller decides
 * that, not this function.
 */
export async function retryTransient<Result>(
  attempt: () => Promise<Result>,
  policy: {
    attempts: number;
    delaysMs: readonly number[];
    transient: (error: unknown) => boolean;
    wait?: (ms: number) => Promise<void>;
  },
): Promise<Result> {
  const wait = policy.wait ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
  for (let tried = 1; ; tried += 1) {
    try {
      return await attempt();
    } catch (error) {
      if (tried >= policy.attempts || !policy.transient(error)) throw error;
      await wait(policy.delaysMs[tried - 1] ?? policy.delaysMs.at(-1) ?? 0);
    }
  }
}
