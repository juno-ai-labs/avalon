import type OpenAI from "openai";

/**
 * Turn vocabulary — the shared language between the turn kernel
 * (`@juno-ai/bind/loop`), LLM transports, and hosts.
 *
 * The declared wire format is the OpenAI chat-completions message shape,
 * consumed as **types only** (`openai` is a peer used purely for its type
 * declarations here; no runtime import). Hosts on other client stacks (e.g.
 * the Vercel AI SDK) adapt at the turn-function boundary.
 *
 * The tool/plugin vocabulary is a separate contract and lives in `plugins/`,
 * not here: this module is about what a turn *is* on the wire, while that one
 * is about what a host can register and how the harness discloses it.
 */

export type TranscriptMessage = OpenAI.ChatCompletionMessageParam;
export type AssistantTurnMessage = OpenAI.ChatCompletionMessage;
export type WireToolDefinition = OpenAI.ChatCompletionTool;
export type WireToolCall = OpenAI.ChatCompletionMessageToolCall;

/**
 * Per-turn latency/throughput measurements. Field shapes deliberately match
 * the metrics the StirrupJS benchmark harness reports (`speedStats`), so
 * numbers are directly comparable with published benchmark methodology:
 * time-to-first-token, generation wall time, and output tokens/second —
 * plus the model-time vs tool-time split that per-task wall-clock hides.
 */
export interface TurnTimings {
  /** ms from request start to the first streamed token, if streaming. */
  readonly ttftMs: number | null;
  /** ms from request start to the completed response. */
  readonly generationMs: number;
}

export interface TurnUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Provider-reported cached input tokens, when available. */
  readonly cachedInputTokens: number | null;
  /** Billing-basis cost in USD cents, when the transport can report it. */
  readonly costCents: number | null;
}

/** One model completion's message + usage + timings. */
export interface ModelTurnResult {
  readonly message: AssistantTurnMessage;
  readonly usage: TurnUsage;
  readonly timings: TurnTimings;
}

/**
 * The turn function — the seam between the loop and any LLM client. The
 * kernel never imports an LLM client; it calls this. Implementations own
 * retries, provider routing, and streaming internally and return one
 * completed assistant turn.
 */
export type TurnFn = (
  messages: readonly TranscriptMessage[],
  tools: readonly WireToolDefinition[] | undefined,
  signal: AbortSignal | undefined,
) => Promise<ModelTurnResult>;

/**
 * Why a run stopped — the single vocabulary a host reports an outcome in,
 * instead of re-deriving it from a handful of loop-state flags.
 *
 * `runToolLoop` returns five of the six directly:
 *
 *  - `done` — the model produced a turn with no tool calls (and no
 *    `onTurnWouldEnd` nudge pushed it forward).
 *  - `waiting_for_reply` — a tool asked a human a question and the run is
 *    blocked until someone answers. **Nothing happens until they do.**
 *  - `resuming_later` — a tool scheduled its own resume (a sleep, a timer).
 *    The run paused on purpose and will come back by itself.
 *  - `iteration_limit` — `maxIterations` was exhausted with the model still
 *    calling tools. The run did not finish; it was cut off.
 *  - `aborted` — the batch `signal` fired, or `shouldStop` asked to stop.
 *
 * The two pause reasons are split rather than one `suspended` because they are
 * the outcomes whose consequences differ most: one needs a person to act, the
 * other needs no one to do anything. Collapsed into a single value, a host
 * that wanted to tell them apart had to go back and read `state.suspended` —
 * which is the loop-state-flag reconstruction this type exists to replace.
 *
 * `deadline` is the one the loop does not return, and deliberately so: the
 * wall-clock budget is a **throw-based** port (`throwIfTimedOut`), so an
 * expired budget leaves the loop as a `RunTimeoutError` rather than a value.
 * A host maps its catch block onto this vocabulary — `classifyRunFailure`
 * from `@juno-ai/bind/run` recognises the same condition as `"timed_out"`.
 * Returning `aborted` for an expired deadline would be worse than not
 * returning it at all: the loop genuinely cannot distinguish a deadline signal
 * from a cancellation signal once both are combined into one `AbortSignal`.
 */
export type StopReason =
  | "done"
  | "waiting_for_reply"
  | "resuming_later"
  | "iteration_limit"
  | "deadline"
  | "aborted";

/**
 * Cumulative run accounting: model-time and tool-time reported separately —
 * task wall-clock conflates provider inference speed with tool execution,
 * and consumers comparing models need the model's contribution isolated.
 */
export interface RunStats {
  /**
   * Agent turns — one per model completion the loop iterated on. Auxiliary
   * model calls (a compaction pass) contribute their tokens, cost and model
   * time but NOT a turn, so this stays comparable with the loop's iteration
   * budget. See {@link accumulateAuxiliarySpend}.
   */
  readonly turns: number;
  /**
   * Tool calls that were actually **dispatched**. A call the batch refused at
   * claim time (an aborted `signal`) never ran, so it is not counted here even
   * though the model requested it — the gap between this and the requested
   * count is exactly the work an abort prevented.
   */
  readonly toolCalls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /**
   * Provider-reported cached input tokens, summed across turns. Zero is
   * indistinguishable from "the transport could not report it" — a turn whose
   * `cachedInputTokens` is `null` contributes nothing rather than poisoning the
   * total, so read this as a floor.
   */
  readonly cachedInputTokens: number;
  readonly costCents: number;
  /** Sum of model `generationMs` across turns. */
  readonly modelTimeMs: number;
  /** Sum of tool execution durations across dispatched calls. */
  readonly toolTimeMs: number;
  /** Output tokens per second of model time, null before any output. */
  readonly outputTokensPerSecond: number | null;
  /** Per-tool total execution ms, keyed by tool name. */
  readonly toolTimeBreakdownMs: Readonly<Record<string, number>>;
}

export function emptyRunStats(): RunStats {
  return {
    turns: 0,
    toolCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    costCents: 0,
    modelTimeMs: 0,
    toolTimeMs: 0,
    outputTokensPerSecond: null,
    toolTimeBreakdownMs: {},
  };
}

/** Fold one completed model turn into cumulative run stats. */
export function accumulateTurn(stats: RunStats, turn: ModelTurnResult): RunStats {
  const outputTokens = stats.outputTokens + turn.usage.outputTokens;
  const modelTimeMs = stats.modelTimeMs + turn.timings.generationMs;
  return {
    ...stats,
    turns: stats.turns + 1,
    inputTokens: stats.inputTokens + turn.usage.inputTokens,
    outputTokens,
    cachedInputTokens:
      stats.cachedInputTokens + (turn.usage.cachedInputTokens ?? 0),
    costCents: stats.costCents + (turn.usage.costCents ?? 0),
    modelTimeMs,
    outputTokensPerSecond:
      modelTimeMs > 0 ? (outputTokens / modelTimeMs) * 1000 : null,
  };
}

/**
 * Model spend that is not an agent turn — today, a compaction pass.
 *
 * Split out rather than folded through {@link accumulateTurn} because the two
 * numbers answer different questions. A compaction is a real model call that
 * costs real money and real latency, so its tokens, cost and time belong in the
 * run's totals; it is *not* an iteration the agent spent making progress, so
 * counting it in `turns` would make `stats.turns` incomparable with the loop's
 * `maxIterations` and quietly overstate how much thinking the agent did.
 */
export interface AuxiliarySpend {
  readonly inputTokens: number;
  readonly outputTokens: number;
  /**
   * Required, unlike the two below, because a caller that cannot price a call
   * still knows it cost *something* and should pass `0` deliberately rather
   * than omit it. Time and cache figures are genuinely unknowable to some
   * callers, so they are optional and contribute nothing when absent.
   */
  readonly costCents: number;
  /** Wall time of the auxiliary model call, if measured. */
  readonly modelTimeMs?: number;
  readonly cachedInputTokens?: number | null;
}

/** Fold auxiliary model spend into a run's totals without counting a turn. */
export function accumulateAuxiliarySpend(
  stats: RunStats,
  spend: AuxiliarySpend,
): RunStats {
  const outputTokens = stats.outputTokens + spend.outputTokens;
  const modelTimeMs = stats.modelTimeMs + (spend.modelTimeMs ?? 0);
  return {
    ...stats,
    inputTokens: stats.inputTokens + spend.inputTokens,
    outputTokens,
    cachedInputTokens:
      stats.cachedInputTokens + (spend.cachedInputTokens ?? 0),
    costCents: stats.costCents + spend.costCents,
    modelTimeMs,
    // Recomputed, not carried: the added output tokens and model time both move
    // the rate, and leaving the old value would report a throughput that
    // matches neither the turns nor the totals now stored beside it.
    outputTokensPerSecond:
      modelTimeMs > 0 ? (outputTokens / modelTimeMs) * 1000 : null,
  };
}

/**
 * Read a tool's accumulated time without going through `Object.prototype`.
 *
 * A bare `breakdown[name] ?? 0` reads inherited properties, so a tool legally
 * named `constructor` or `toString` returns a *function*, and `fn + duration`
 * silently produces a string — a corrupted `toolTimeBreakdownMs` entry that
 * typechecks as `number`. Tool names come from the model, so this is reachable
 * on any run. Same guard the plugin registry already applies to alias lookups.
 */
function ownDuration(
  breakdown: Readonly<Record<string, number>>,
  toolName: string,
): number {
  return Object.hasOwn(breakdown, toolName) ? breakdown[toolName]! : 0;
}

/** Fold one dispatched tool call's duration into cumulative run stats. */
export function accumulateToolCall(
  stats: RunStats,
  toolName: string,
  durationMs: number,
): RunStats {
  return {
    ...stats,
    toolCalls: stats.toolCalls + 1,
    toolTimeMs: stats.toolTimeMs + durationMs,
    toolTimeBreakdownMs: {
      ...stats.toolTimeBreakdownMs,
      [toolName]: ownDuration(stats.toolTimeBreakdownMs, toolName) + durationMs,
    },
  };
}

/**
 * Fold a completed run's totals into another run's — the roll-up for a chain
 * that spawned child runs (`@juno-ai/bind/run`).
 *
 * Two things follow from summing across runs rather than within one, and both
 * are correct rather than artifacts:
 *
 *  - **`modelTimeMs` can exceed the chain's wall-clock**, because children that
 *    ran concurrently each contribute their own. That is precisely why model
 *    time and wall-clock are separate numbers; a chain's *cost* is the sum, its
 *    *latency* is not.
 *  - **`outputTokensPerSecond` is recomputed from the merged totals**, not
 *    averaged from the parts. An average of two rates weights a 10-token run
 *    the same as a 10,000-token one and reports a throughput neither run
 *    achieved.
 *
 * The fold is associative and order-independent, so a chain reduces cleanly in
 * whatever order its children finish:
 *
 * ```ts
 * const chainTotals = childStats.reduce(accumulateRun, parentStats);
 * ```
 */
export function accumulateRun(stats: RunStats, run: RunStats): RunStats {
  const outputTokens = stats.outputTokens + run.outputTokens;
  const modelTimeMs = stats.modelTimeMs + run.modelTimeMs;
  const toolTimeBreakdownMs: Record<string, number> = {
    ...stats.toolTimeBreakdownMs,
  };
  for (const [toolName, durationMs] of Object.entries(run.toolTimeBreakdownMs)) {
    // Own-property read, for the same reason as `accumulateToolCall`.
    toolTimeBreakdownMs[toolName] =
      ownDuration(toolTimeBreakdownMs, toolName) + durationMs;
  }
  return {
    turns: stats.turns + run.turns,
    toolCalls: stats.toolCalls + run.toolCalls,
    inputTokens: stats.inputTokens + run.inputTokens,
    outputTokens,
    cachedInputTokens: stats.cachedInputTokens + run.cachedInputTokens,
    costCents: stats.costCents + run.costCents,
    modelTimeMs,
    toolTimeMs: stats.toolTimeMs + run.toolTimeMs,
    outputTokensPerSecond:
      modelTimeMs > 0 ? (outputTokens / modelTimeMs) * 1000 : null,
    toolTimeBreakdownMs,
  };
}
