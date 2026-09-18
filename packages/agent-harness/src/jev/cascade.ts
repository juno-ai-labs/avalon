/** Which stage of a cascade produced the answer a caller is holding. */
export type ConfidenceCascadeStage = "primary" | "fallback" | "floor";

export interface ConfidenceCascadeResult<Answer> {
  answer: Answer;
  stage: ConfidenceCascadeStage;
}

export interface ConfidenceCascade<Answer> {
  /** The fast, cheap stage. Its own deadline belongs to it, not to this. */
  primary: () => Promise<Answer>;
  /**
   * Whether the primary's answer is good enough to return.
   *
   * A predicate rather than a number because the comparison itself is the part
   * that drifts: `docs/jev-best-practices.md` asks for threshold equality
   * semantics to be explicit and tested, and one predicate, written once beside
   * its threshold constant, is what makes that possible.
   */
  accept: (answer: Answer) => boolean;
  /**
   * The second stage, if this decision has one. Omitted, a low-confidence or
   * failed primary falls straight to the floor.
   */
  fallback?: {
    run: (signal: AbortSignal) => Promise<Answer>;
    /** The fallback's own deadline, so a stalled connection cannot make the floor unreachable. */
    timeoutMs: number;
  } | undefined;
  /**
   * The terminal local answer, computed without a provider.
   *
   * Every cascade needs one. Remote availability must not decide a question the
   * product has to answer anyway, and a floor is what keeps a two-provider
   * outage from becoming a user-visible failure.
   */
  floor: () => Answer;
  /** Caller cancellation, which ends the cascade rather than advancing it. */
  signal?: AbortSignal | undefined;
}

/**
 * Run one decision through primary, fallback and floor.
 *
 * The rule that makes this worth extracting is the one that is easy to get
 * wrong in a copy: **a cancelled caller is not a failed provider.** A caller
 * aborting must propagate, because continuing would spend a second provider
 * call on work nobody is waiting for; every other primary failure, including
 * this cascade's own deadline, advances to the next stage. Failure and
 * insufficient confidence are the same transition here, and are kept distinct
 * only in the diagnostics each stage emits.
 */
export async function runConfidenceCascade<Answer>(
  cascade: ConfidenceCascade<Answer>,
): Promise<ConfidenceCascadeResult<Answer>> {
  let primary: Answer | null = null;
  try {
    primary = await cascade.primary();
  } catch (error) {
    if (cascade.signal?.aborted) throw error;
  }
  if (primary !== null && cascade.accept(primary)) return { answer: primary, stage: "primary" };

  const fallback = cascade.fallback;
  if (!fallback) return { answer: cascade.floor(), stage: "floor" };

  const deadline = new AbortController();
  const timer = setTimeout(() => {
    deadline.abort(new DOMException("cascade fallback timed out", "TimeoutError"));
  }, fallback.timeoutMs);
  const signal = cascade.signal
    ? AbortSignal.any([cascade.signal, deadline.signal])
    : deadline.signal;
  try {
    return { answer: await fallback.run(signal), stage: "fallback" };
  } catch (error) {
    if (cascade.signal?.aborted) throw error;
    return { answer: cascade.floor(), stage: "floor" };
  } finally {
    clearTimeout(timer);
  }
}
