/**
 * Streaming-completion idle watchdog.
 *
 * A chat-completions SDK's `timeout` bounds *establishing* the request and (for
 * a non-streaming call) the whole response — but once a stream has started
 * yielding, nothing bounds the gap between chunks. A provider that opens the
 * stream and then stalls leaves the consumer's `for await` awaiting the next
 * chunk forever, holding its worker slot until some outer deadline fires, or
 * never. Downstream that is the agent that says "thinking…" and never answers.
 *
 * The budget is split into three because the phases of a streaming completion
 * have very different normal latencies, and one number cannot serve all of them:
 *
 * - **Time to first token** — from opening the stream to the first *answer*
 *   token. Generous: a high-reasoning model can legitimately think for a while
 *   before emitting anything, and even once reasoning deltas are flowing it can
 *   sit silent for seconds between finishing its reasoning and emitting the
 *   first content/tool token. This budget therefore covers the reasoning phase
 *   AND the reasoning→answer gap — {@link ChunkOutput} `"reasoning"` does NOT
 *   switch to the tight budget. Arming the tight budget on a reasoning token is
 *   a real observed failure: the normal reasoning→content pause of a frontier
 *   reasoning model routinely approaches several seconds and tripped
 *   "no chunk mid-stream" on healthy turns.
 * - **Inter-chunk** — the gap between chunks once the model's ANSWER output
 *   (content / tool-call arguments / refusal) is flowing. Tight: answer chunks
 *   normally arrive sub-second, so a multi-second silence mid-answer is already
 *   abnormal, and a shorter budget recovers a mid-stream stall far sooner.
 * - **Overall cap** — an absolute wall-clock ceiling, armed at construction and
 *   never re-armed. Defense in depth, not a duplicate of the two idle budgets:
 *   the idle watchdog only bounds the *gap* between chunks, so a provider that
 *   drip-feeds a chunk just under the idle budget forever (a reasoning delta a
 *   minute, never reaching an answer) never trips it. The proper bound on total
 *   work is the caller's own deadline signal, but not every caller has one, so
 *   this guarantees a single call cannot hold a slot indefinitely regardless.
 *
 *   It is armed by the constructor rather than by {@link StreamWatchdog.open}
 *   because it is the guarantee of last resort: a host that forgets `open()`
 *   gets a watchdog that silently never fires, with no type error and no test
 *   failure, and the symptom appears only under a stalling provider. Counting
 *   the connection handshake against a ceiling this generous costs nothing;
 *   leaving the ceiling to an imperative call the host may skip costs a worker
 *   slot. The two *idle* budgets genuinely must wait for `open()` — arming them
 *   earlier would charge connection time to the first-token budget.
 *
 * The watchdog owns timers and abort signals and nothing else: it does not read
 * the stream, does not know the wire format, and does not phrase the error. It
 * reports a structured {@link StreamStall} and the host words it — the same
 * split the routing modules use, since a stall message is usually product copy.
 */

/**
 * What a streamed chunk carried, from the watchdog's point of view. The
 * distinction that matters is `"reasoning"` vs `"answer"`: only answer output
 * arms the tight inter-chunk budget. A chunk carrying both is `"answer"`.
 * A role/metadata-only opening chunk is `"none"` — the model has not produced a
 * token yet, so it must not shorten the budget either.
 */
export type ChunkOutput = "none" | "reasoning" | "answer";

/** Why the watchdog tore the stream down. */
export type StreamStall =
  /** The absolute wall-clock ceiling elapsed before the stream finished. */
  | Readonly<{ kind: "overall_cap"; limitMs: number }>
  /**
   * No answer token within the generous budget. `sawReasoning` distinguishes
   * "the provider never said anything" from "it streamed reasoning and never
   * reached an answer" — different upstream faults with the same budget.
   */
  | Readonly<{ kind: "time_to_first_token"; limitMs: number; sawReasoning: boolean }>
  /** Answer output was flowing and then stopped mid-stream. */
  | Readonly<{ kind: "inter_chunk"; limitMs: number }>;

export interface StreamWatchdogOptions {
  /** Generous first-answer-token budget. Default {@link DEFAULT_TIME_TO_FIRST_TOKEN_MS}. */
  readonly timeToFirstTokenMs?: number;
  /** Tight budget between chunks once answer output flows. Default {@link DEFAULT_INTER_CHUNK_MS}. */
  readonly interChunkMs?: number;
  /**
   * Absolute ceiling on the whole call, measured from **watchdog
   * construction** — not from {@link StreamWatchdog.open}, which only arms the
   * idle budgets. Size it to include whatever the host does between
   * constructing the watchdog and opening the stream (connecting, sending the
   * request, waiting on response headers), since all of that is inside the
   * budget. Default {@link DEFAULT_MAX_CALL_DURATION_MS}.
   */
  readonly maxCallDurationMs?: number;
  /**
   * The caller's own abort signal (a run deadline, a cancellation). Composed
   * into {@link StreamWatchdog.signal}, and — critically — consulted by
   * {@link StreamWatchdog.stall}: when the caller aborted, the teardown is the
   * caller's, not a stall, and must not be reclassified as a retriable
   * upstream fault.
   */
  readonly external?: AbortSignal | null;
  /**
   * Timer port, defaulting to the ambient globals. Inject a controllable clock
   * to test budget behaviour exactly, rather than sleeping a real interval and
   * hoping the machine keeps up — a watchdog test asserting "nothing fired yet"
   * against a real timer is a flake waiting for a loaded CI box.
   *
   * The handle is opaque (`unknown`) so a fake can hand back whatever it likes;
   * only {@link StreamTimers.clear} ever consumes it.
   */
  readonly timers?: StreamTimers;
}

/** The subset of the timer API the watchdog needs. */
export interface StreamTimers {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface StreamWatchdog {
  /** Hand this to the transport as the request's abort signal. */
  readonly signal: AbortSignal;
  /**
   * The stream is open: arm the time-to-first-token budget. Call immediately
   * after the transport returns the stream — arming before that would count
   * connection time against the first-token budget. The absolute cap is already
   * running (see {@link createStreamWatchdog}); this only starts the idle
   * budgets. Idempotent, and a no-op after {@link dispose}.
   */
  open(): void;
  /**
   * A chunk arrived: re-arm for the gap to the *next* one. Call for every
   * chunk, including metadata-only ones — a chunk that carried nothing still
   * proves the stream is alive.
   */
  observedChunk(output: ChunkOutput): void;
  /**
   * Why the stream was torn down, or `null` if this watchdog did not do it.
   * Returns `null` whenever the caller's own signal aborted, even if a budget
   * also elapsed: a cancelled call is cancelled, not stalled.
   *
   * Call from the `catch` that saw the abort, before {@link dispose}.
   */
  stall(): StreamStall | null;
  /**
   * Clear the timers, forget any budget that elapsed, and settle the composite
   * signal. Idempotent; call from a `finally` on every path.
   *
   * Settling matters as much as clearing: the composite holds a listener on a
   * possibly long-lived caller signal, and one per call across a run's many
   * calls is a leak.
   *
   * Forgetting matters because a timer can fire in the moment between the last
   * chunk and the stream ending — the abort loses the race, the read completes
   * normally, and nothing was torn down. If that stale flag survived, a *later*
   * failure on the same call (a defect found while assembling the message, a
   * billing read) would reach {@link stall} and be reported as an upstream
   * stall it had nothing to do with. Call `stall()` before `dispose()`, which
   * is the documented order and the only order in which a real stall is
   * observable anyway.
   */
  dispose(): void;
}

export const DEFAULT_TIME_TO_FIRST_TOKEN_MS = 120_000;
export const DEFAULT_INTER_CHUNK_MS = 5_000;
export const DEFAULT_MAX_CALL_DURATION_MS = 600_000;

/**
 * The largest delay `setTimeout` can represent. Above this the delay overflows
 * its 32-bit signed field and the timer fires almost immediately instead.
 */
const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * A budget must be a delay `setTimeout` can actually honour.
 *
 * This is checked at construction, and it fails closed in the direction that
 * actually bites. Every value rejected here would otherwise make the watchdog
 * fire on the next tick and tear down every *healthy* stream, surfacing as a
 * total inference outage that looks like a provider incident:
 *
 * - `NaN` / `Infinity`: `setTimeout` coerces a non-finite delay to 1ms rather
 *   than ignoring it, so a bad budget does not disable the watchdog — it makes
 *   it instantaneous.
 * - Zero or negative: fires on the next tick by definition.
 * - Above {@link MAX_TIMEOUT_MS}: overflows the 32-bit delay and, per spec,
 *   clamps to 1ms. This is the trap that reads as reasonable — `maxCallDuration`
 *   of 30 days is a plausible config value and the units are milliseconds, so
 *   it is one `* 1000` away from a healthy-looking number that disables the
 *   backstop entirely.
 *
 * Refusing the value at construction turns a silent outage into a stack trace
 * at the call site that supplied it.
 */
function requirePositiveMs(value: number, field: string): number {
  if (!Number.isFinite(value) || value <= 0 || value > MAX_TIMEOUT_MS) {
    throw new RangeError(
      `StreamWatchdog ${field} must be a positive number of ms no greater than ${MAX_TIMEOUT_MS}, got ${String(value)}`,
    );
  }
  return value;
}

/**
 * Call `unref()` on a timer when the runtime exposes it (Node/Bun) so a
 * forgotten `dispose()` cannot hold the event loop open; a no-op under a DOM
 * `number` timer or an injected fake. Feature-detected rather than `as`-cast to
 * keep type safety.
 *
 * Duplicated from `../run/harness` deliberately: importing across module
 * folders would make `@juno-ai/bind/completion` drag in the run mechanics for
 * five lines, and a consumer that wants only the watchdog should get only the
 * watchdog.
 */
function unrefTimer(timer: unknown): void {
  if (
    typeof timer === "object" &&
    timer !== null &&
    "unref" in timer &&
    typeof timer.unref === "function"
  ) {
    timer.unref();
  }
}

const AMBIENT_TIMERS: StreamTimers = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

export function createStreamWatchdog(
  options: StreamWatchdogOptions = {},
): StreamWatchdog {
  const timeToFirstTokenMs = requirePositiveMs(
    options.timeToFirstTokenMs ?? DEFAULT_TIME_TO_FIRST_TOKEN_MS,
    "timeToFirstTokenMs",
  );
  const interChunkMs = requirePositiveMs(
    options.interChunkMs ?? DEFAULT_INTER_CHUNK_MS,
    "interChunkMs",
  );
  const maxCallDurationMs = requirePositiveMs(
    options.maxCallDurationMs ?? DEFAULT_MAX_CALL_DURATION_MS,
    "maxCallDurationMs",
  );
  const external = options.external ?? null;
  const timers = options.timers ?? AMBIENT_TIMERS;

  // Two controllers rather than one, so `stall()` can name which bound tripped
  // without the caller having to correlate timers.
  const idleController = new AbortController();
  const overallController = new AbortController();
  let idleFired = false;
  let overallFired = false;
  let disposed = false;

  // True once any chunk carried model output; only phrases the diagnostic.
  let sawOutput = false;
  // True once ANSWER output flowed. Only this arms the tight budget.
  let sawAnswerOutput = false;

  let idleTimer: unknown = null;
  let overallTimer: unknown = null;

  function armIdle(ms: number): void {
    if (idleTimer !== null) timers.clear(idleTimer);
    idleTimer = timers.set(() => {
      idleFired = true;
      idleController.abort();
    }, ms);
    unrefTimer(idleTimer);
  }

  function clearTimers(): void {
    if (idleTimer !== null) {
      timers.clear(idleTimer);
      idleTimer = null;
    }
    if (overallTimer !== null) {
      timers.clear(overallTimer);
      overallTimer = null;
    }
  }

  const signal = AbortSignal.any(
    external
      ? [external, idleController.signal, overallController.signal]
      : [idleController.signal, overallController.signal],
  );

  // Armed here, not in `open()`, so the ceiling holds even for a host that
  // never calls `open()`. See the module header.
  overallTimer = timers.set(() => {
    overallFired = true;
    overallController.abort();
  }, maxCallDurationMs);
  unrefTimer(overallTimer);

  return {
    signal,
    open() {
      if (disposed) return;
      armIdle(timeToFirstTokenMs);
    },
    observedChunk(output) {
      if (disposed) return;
      if (output !== "none") sawOutput = true;
      if (output === "answer") sawAnswerOutput = true;
      armIdle(sawAnswerOutput ? interChunkMs : timeToFirstTokenMs);
    },
    stall() {
      // A caller abort wins over every budget: the stream may well have been
      // idle when cancellation landed, but reporting that as an upstream stall
      // would make a deliberate cancellation look retriable.
      if (external?.aborted) return null;
      // Checked before the idle budget because the cap is the stronger claim:
      // when both elapsed, the call ran past its absolute ceiling, and the
      // trailing idle gap is a symptom of that rather than a separate fault.
      if (overallFired) {
        return { kind: "overall_cap", limitMs: maxCallDurationMs };
      }
      if (idleFired) {
        if (sawAnswerOutput) return { kind: "inter_chunk", limitMs: interChunkMs };
        return {
          kind: "time_to_first_token",
          limitMs: timeToFirstTokenMs,
          sawReasoning: sawOutput,
        };
      }
      return null;
    },
    dispose() {
      disposed = true;
      clearTimers();
      // Drop any budget that elapsed. A timer that fired in the moment before
      // the stream ended lost the race — it tore nothing down — and leaving the
      // flag set would let it be blamed for a later, unrelated failure on the
      // same call. See the `dispose` doc comment.
      idleFired = false;
      overallFired = false;
      // Abort the idle controller (not the overall one) purely to settle the
      // composite so it releases its listener on `external`.
      idleController.abort();
    },
  };
}
