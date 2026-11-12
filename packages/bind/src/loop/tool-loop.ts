import type OpenAI from "openai";
import { assertCheckpointTranscript, positionForStop, UnsettledLoopBoundaryError, type LoopControl } from "./boundary";
import {
  runToolCallsPooledByTool,
  AbortedToolCallError,
} from "../run/tool-batch";
import {
  accumulateAuxiliarySpend,
  accumulateToolCall,
  accumulateTurn,
  emptyRunStats,
  type RunStats,
  type StopReason,
} from "../contracts/turn";
import { toolResultMessage } from "../plugins/tool-message";
// Imported from the module, not the `tools` barrel: this subpath's runtime
// graph is deliberately free of `zod`, which the barrel's siblings pull in.
import { stripControlChars } from "../tools/control-chars";
import { renderInterruptMessage } from "@rally/prompts/bind/interrupt";

/**
 * The agent iteration engine: call the model, run the tools it asked for,
 * repeat until it stops asking. Everything that *happens* as a result — status
 * updates, heartbeats, activity rows, persistence, cancellation — is injected,
 * so the loop itself does no I/O and holds no host vocabulary.
 *
 * Three ports are worth understanding before wiring this up, because each
 * replaced something the loop previously hardcoded:
 *
 *  - **`runsSerially`** decides which calls in a batch must run one at a time,
 *    ahead of the rest. Not a performance knob: a call that changes what tools
 *    exist has to take effect before a later call in the same batch tries to
 *    use them.
 *  - **`isFatalToolError`** decides which thrown errors abort the run instead
 *    of becoming a tool error the model can read. Cancellation and "we failed
 *    to record the result" belong here; a tool that simply failed does not.
 *  - **`onToolCallRejected`** observes the errors that were synthesized rather
 *    than thrown. Without it they are invisible — the model sees them, your
 *    logs do not.
 *
 * Turn accounting is the flat usage a host's `callModel` returns
 * (`ToolLoopTurn`), not the richer `ModelTurnResult` in
 * `@juno-ai/bind/contracts` with its timings. The loop bridges them: it
 * measures each `callModel` with an injectable `now` and folds the pair
 * through `accumulateTurn`, so `runToolLoop` returns a full `RunStats`
 * without a host changing the shape it already returns. `ttftMs` is the one
 * field that cannot cross — only the transport sees the first byte.
 */

/** One model completion's message + the provider usage the loop accounts for. */
export interface ToolLoopTurn {
  message: OpenAI.ChatCompletionMessage;
  inputTokens: number;
  outputTokens: number;
  costCents: number;
  /**
   * Provider-reported cached input tokens, when the transport can report them.
   * Optional — omit it (or pass `null`) and the run's `cachedInputTokens` total
   * simply does not count this turn, rather than counting it as a zero.
   */
  cachedInputTokens?: number | null;
  /**
   * Set `false` to keep this completion OUT of the transcript while still
   * accounting for what it cost. The turn happened — it is folded into
   * `stats` and `state` either way — but `state.messages` never grows an
   * assistant entry for it.
   *
   * The case it exists for is a **tolerated empty completion**: a provider
   * answered with no text and no tool calls, the host decided that is a
   * nothing rather than a failure, and the host had already reserved a
   * transcript slot for the message it never got. Appending the empty
   * assistant message would persist a turn saying nothing and re-send it on
   * every later call; dropping it leaves the transcript exactly as the model
   * found it, so the next turn is a clean retry of the same question.
   *
   * **Only a turn with no tool calls may be dropped.** Withholding a
   * tool-calling assistant message orphans every `tool` result the batch is
   * about to append, which is an invalid transcript the next model call
   * rejects. The loop refuses that rather than building it — it reports the
   * misuse through `onToolCallRejected` (one report per orphaned call, the
   * same channel a missing activation port uses) and keeps the message.
   *
   * Defaults to accepting: omit it, or pass `true`, and nothing changes.
   */
  acceptMessage?: boolean;
}

/**
 * Outcome of running one tool call inside an assistant `tool_calls` batch.
 *
 * Every optional field is a **control signal**: the loop branches on it. They
 * are not host payload passing through — `loadedPluginName` grows the active
 * set, `requestCompaction` triggers a compaction at the batch boundary, and
 * `suspend` ends the run. A host's own per-call data belongs inside
 * `toolMessage`, which the loop only appends.
 */
export type ToolCallOutcome = {
  toolMessage: OpenAI.ChatCompletionToolMessageParam;
  /**
   * A plugin this call activated; the loop adds it to the active set at once —
   * but ONLY from the serial phase. A call that reaches the concurrent phase
   * has already missed its window (a later call in the same batch could
   * already be running), so this field is ignored there rather than applied
   * late. Return it from a call your `runsSerially` selects, or it is dropped.
   */
  loadedPluginName?: string;
  /** An instruction module this call loaded, passed to `activateSkills`. Serial phase only, as above. */
  loadedSkillRef?: string;
  /** Plugins the loaded module needs, activated before it. Serial phase only, as above. */
  autoLoadedPlugins?: string[];
  /** Compact the transcript at this batch's boundary. */
  requestCompaction?: boolean;
  /**
   * End the run. `answer` records the open call and WITHHOLDS its tool message
   * — the result is a human's future answer, threaded back on resume — so at
   * most one may be open at a time; a second in the same batch is answered with
   * an error rather than left unpaired. `wake` keeps its tool message and
   * re-enters through a fresh prompt.
   */
  suspend?: {
    toolCallId: string;
    reason: string;
    resumeKind: "answer" | "wake";
    request?: unknown;
  };
};

/**
 * Result of compacting: the new transcript + the compaction call's own usage,
 * plus a deferred `persist` step. The loop applies accounting + swaps the
 * transcript BEFORE calling `persist`, so a persistence failure can't drop the
 * tokens the compaction LLM call already consumed.
 */
export interface CompactionApplied {
  messages: OpenAI.ChatCompletionMessageParam[];
  inputTokens: number;
  outputTokens: number;
  costCents: number;
  /** Provider-reported cached input tokens for the compaction call, if known. */
  cachedInputTokens?: number | null;
  /** Persist the compacted session + activity row. Runs after accounting. */
  persist: () => Promise<void>;
}

/**
 * Mutable accumulator threaded through the loop. The caller seeds it and reads
 * it back after; a shared object (rather than return values) lets the caller's
 * coalesced heartbeat read live token totals mid-loop. `messages` is mutated in
 * place (assistant + tool turns appended; replaced wholesale on compaction).
 */
export interface ToolLoopState {
  messages: OpenAI.ChatCompletionMessageParam[];
  inputTokens: number;
  outputTokens: number;
  costCents: number;
  /** Provider prompt/completion tokens from the most recent turn (0 right after a compaction). */
  lastPromptTokens: number;
  lastOutputTokens: number;
  /** True once any turn has produced a real provider count this run. */
  hasFreshTokenCount: boolean;
  /** Cumulative tool calls dispatched this run — the count only, never names or
   *  results. Feeds a live progress indicator via `onProgressUpdate`. */
  toolCalls: number;
  /** True when the loop ended because a tool suspended the run (asked a human a
   *  question, or scheduled its own resume). Distinguishes an intentional pause
   *  from an iteration-limit cutoff — without it a caller reports "couldn't
   *  finish" over a run that stopped exactly where it meant to. */
  endedTurnViaTool?: boolean | undefined;
  /** Set when a tool suspended the run awaiting an answer: the open tool-call is
   *  waiting on a human or an external system. The loop withholds that call's
   *  `tool` message — its result IS the future answer — and ends the run; a
   *  resume threads the answer back as the matching `role:"tool"` result. At
   *  most one may be open at a time; extras in the same batch are answered with
   *  a synthesized error so no second slot is left unpaired. */
  suspended?: {
    toolCallId: string;
    reason: string;
    // Always "answer": `state.suspended` is set ONLY in the answer branch (a
    // `wake` ends the run but keeps its tool message and records nothing here).
    resumeKind: "answer";
    request?: unknown;
  } | undefined;
}

export type RunStatus =
  | "thinking"
  | "thinking_with_tools"
  | "executing_tools";

/**
 * A tool asked the loop to activate a plugin or an instruction module, and the
 * port that would do it was not wired.
 *
 * Reported through `onToolCallRejected` rather than thrown: the call itself
 * succeeded and its tool message is already correct, so failing the run would
 * be worse than the missing activation. But it must not be silent — before
 * these ports were optional this was a compile error, and the runtime symptom
 * (an agent that keeps loading a plugin it never receives) points nowhere near
 * the cause.
 *
 * Match on `error.name === "MissingActivationPortError"` rather than
 * `instanceof` if you consume this package from a projected or re-bundled copy
 * — two copies of a class in one module graph make `instanceof` silently
 * false, and this package is Copybara-projected and republished.
 */
export class MissingActivationPortError extends Error {
  override readonly name = "MissingActivationPortError";
  constructor(readonly port: "activatePlugins" | "activateSkills") {
    super(
      `A tool outcome asked the loop to activate, but no \`${port}\` was supplied. ` +
        `Wire the port, or stop returning activation fields from \`runToolCall\`.`,
    );
  }
}

/**
 * A turn returned `acceptMessage: false` while also requesting tools.
 *
 * Reported through `onToolCallRejected` rather than thrown, and the discard is
 * refused rather than honoured: the tool calls are about to run, and a
 * transcript carrying their results without the assistant message that asked
 * for them is one the next provider call rejects outright. Keeping the message
 * costs an assistant entry the host did not want; dropping it costs the run.
 *
 * Match on `error.name === "DiscardedTurnWithToolCallsError"` rather than
 * `instanceof` — see {@link MissingActivationPortError} for why.
 */
export class DiscardedTurnWithToolCallsError extends Error {
  override readonly name = "DiscardedTurnWithToolCallsError";
  constructor(readonly toolCallCount: number) {
    super(
      `A turn asked the loop to drop its assistant message, but the message ` +
        `requests ${toolCallCount} tool call(s) whose results would be left ` +
        `unpaired. The message was kept. Only a tool-less turn may be dropped.`,
    );
  }
}

/**
 * A settled step delivered a message that cannot be appended yet: a call is
 * still awaiting its answer, and the provider rule is that nothing comes
 * between an assistant message and the `tool` results it is waiting on.
 *
 * Appending it anyway builds `assistant(tool_calls) → user → tool` the moment
 * the answer is threaded back on resume, which providers reject outright — so
 * the message is refused and reported (through `onToolCallRejected`, against
 * the open call) rather than silently corrupting the transcript. Deliver the
 * answering `tool` result first, in the same settlement, and everything after
 * it is accepted normally.
 *
 * Match on `error.name === "InputBlockedBySuspendError"` rather than
 * `instanceof` — see {@link MissingActivationPortError} for why.
 */
export class InputBlockedBySuspendError extends Error {
  override readonly name = "InputBlockedBySuspendError";
  constructor(
    readonly openToolCallId: string,
    readonly refusedRole: string,
  ) {
    super(
      `A settled step delivered a \`${refusedRole}\` message while tool call ` +
        `${openToolCallId} is still awaiting its answer. It was refused: the ` +
        `answer has to reach the transcript first, or the resumed run sends ` +
        `a \`tool\` result the message has already split from its call.`,
    );
  }
}

/**
 * The key a tool call is measured under in {@link RunStats.toolTimeBreakdownMs}.
 *
 * Mirrors the batch's pooling key rather than reading `tc.function.name`: the
 * wire union has a `custom` member with its name on a different field, and a
 * host may assemble a call with no `function` at all. Synthetic keys are
 * fenced with `__` so they cannot collide with a real tool called `custom`.
 */
function toolCallStatsKey(tc: OpenAI.ChatCompletionMessageToolCall): string {
  switch (tc.type) {
    case "function":
      return tc.function?.name ?? "__unnamed__";
    case "custom":
      return `__custom__:${tc.custom?.name ?? "unnamed"}`;
    default: {
      // Not `never`: this union is a third party's, and a member it grows
      // later must not become a type error in a consumer that never sees one.
      const unknownCall: { type?: string } = tc;
      return `__${unknownCall.type ?? "unknown"}__`;
    }
  }
}

/**
 * What a completed loop reports back.
 *
 * Returned rather than folded into `ToolLoopState` because these are the run's
 * *conclusion*, not its live progress: a caller reads `state` mid-run for a
 * heartbeat, and reads this once, after. Before it existed every host
 * re-derived the outcome from three flags and an iteration count, and each got
 * a slightly different answer.
 */
export interface ToolLoopResult {
  /**
   * Why the loop stopped. See {@link StopReason} — `deadline` arrives as a
   * thrown error rather than a value, and is never returned here.
   *
   * `aborted` means only "the batch signal was set, or `shouldStop` said so".
   * It does not say *which*, because a combined signal cannot. A host that
   * needs timeout-vs-cancellation reaches for its own `RunDeadline` (and
   * `classifyRunFailure`), not for this value.
   */
  readonly stopReason: StopReason;
  /**
   * Cumulative accounting for the run: turns, dispatched tool calls, tokens
   * (including provider-reported cached input), cost, and the model-time vs
   * tool-time split with a per-tool breakdown.
   *
   * **`stats` is this invocation's contribution alone**; `state` is whatever
   * the caller seeded plus that. They match only when the caller seeded zeros
   * — a host resuming a run seeds `state` from the stored totals, and then
   * `state.costCents` is the run's lifetime cost while `stats.costCents` is
   * this leg's. Bill from whichever you mean, and do not substitute one for
   * the other.
   *
   * They also differ on tool calls on purpose: `state.toolCalls` counts what
   * the model *requested* (it drives a live progress indicator, so it has to
   * rise the moment a batch is dispatched), while `stats.toolCalls` counts
   * what actually *ran*. An aborted batch is exactly the gap between them.
   *
   * Both are lost if the loop throws — a deadline, a cancellation, or a fatal
   * tool error leaves no return value, so `state` (which is mutated in place)
   * is the only accounting that survives those exits.
   */
  readonly stats: RunStats;
}

/**
 * What a host hands back from {@link ToolLoopParams.onStepSettled}: the
 * messages to append at this settled step, and whether the run should end
 * after appending them.
 */
export interface StepSettlement {
  /** Appended to the transcript in this order. Empty means "nothing queued". */
  messages: OpenAI.ChatCompletionMessageParam[];
  /** End the run as `aborted` once the messages above are appended. */
  stop: boolean;
}

export interface ToolLoopParams {
  state: ToolLoopState;
  /**
   * Active plugin set. The loop does not read it — `buildTools` and
   * `activatePlugins` are the host's own closures over it — so it is optional
   * and passing one is purely a convenience for a host that likes threading it
   * through explicitly.
   */
  activePlugins?: Set<string>;
  maxIterations: number;

  // --- required collaborators ---------------------------------------------
  /** Call the model with the current transcript + tool defs. `onOutputProgress`
   *  (optional) receives a running estimate of THIS call's output tokens as the
   *  stream flows (throttled ~1 Hz inside the model call); the loop adds the
   *  prior cumulative before forwarding to `onProgressUpdate`. */
  callModel: (
    messages: OpenAI.ChatCompletionMessageParam[],
    tools: OpenAI.ChatCompletionTool[] | undefined,
    onOutputProgress?: (estimatedOutputTokens: number) => void,
  ) => Promise<ToolLoopTurn>;
  /** Build the tool definitions for the current active-plugin set (+ MCP). */
  buildTools: () => OpenAI.ChatCompletionTool[];
  /** Execute one tool call → the `tool` message + control signals. */
  runToolCall: (
    toolCall: OpenAI.ChatCompletionMessageToolCall,
  ) => Promise<ToolCallOutcome>;
  /**
   * Record the exact `tool` message the loop is about to append, immediately
   * before it appends it. For a host that persists the transcript as it is
   * built, this is the only point where "what was accepted" and "what was
   * recorded" cannot drift: a batch's outcomes are produced concurrently and
   * an `answer`-suspend withholds one of them, so a host reconstructing the
   * accepted set afterwards has to re-derive a decision the loop already made.
   *
   * `resultOrdinal` counts **accepted results in this batch, densely from 0**
   * — not the call's index in `tool_calls`. A withheld suspend leaves no
   * ordinal behind, so the results that follow it close the gap, and the
   * answer that arrives later takes the ordinal it is accepted at rather than
   * the one its call was issued at. Ordering within the batch is otherwise
   * the model's original call order.
   *
   * **A throw aborts acceptance**: the message is not appended and the error
   * propagates out of `runToolLoop`, unconverted. That is deliberate — this
   * port exists for hosts that must record a result durably before the model
   * may see it, and a host that cannot record one must not be handed a
   * transcript claiming it did. Wire `isFatalToolError` the same way for the
   * dispatch half of that rule.
   *
   * **Scope: results this loop produced.** A `tool` message the host itself
   * returns from `onStepSettled` does not fire this port and takes no ordinal
   * — the host committed that message before handing it over, so reporting it
   * back would ask for a second record of the same thing. `resultOrdinal` is
   * therefore a position within the batch, and a host that journals both
   * sources keys them by where they came from rather than by one counter.
   */
  beforeToolMessageAccepted?: (
    message: OpenAI.ChatCompletionToolMessageParam,
    resultOrdinal: number,
  ) => Promise<void> | void;
  /**
   * Deliver host-committed messages at a **settled step** — a point where the
   * model turn and its whole tool batch are complete and the transcript is
   * coherent, so appending a `user` (or a withheld `tool`) message cannot
   * split an assistant message from the results it is waiting on.
   *
   * Called **at most once per iteration** — the two points below are the two
   * shapes an iteration can take, not two calls in one — and `wouldEnd` says
   * which one this is:
   *
   *  - **`wouldEnd: true`** — the model asked for no tools and the loop is
   *    about to finish. Returning messages CONTINUES the run with them
   *    appended, ahead of `onTurnWouldEnd` (a host that has real input queued
   *    delivers it rather than nudging a turn that was not actually stalled).
   *  - **`wouldEnd: false`** — the batch ran and its results are in the
   *    transcript. Returning messages appends them before the next model call.
   *
   * Return `stop: true` to end the run as `aborted`, with whatever messages
   * came back already appended. Returning `{ messages: [], stop: false }` —
   * or leaving the port unwired — changes nothing.
   *
   * **A delivered `tool` message answers an open suspend.** If the run is
   * waiting on an `answer`-suspend and a returned message carries that call's
   * `tool_call_id`, the loop clears the suspension and keeps going rather than
   * pausing for a reply it has just been handed. It still ends the run if some
   * *other* call in the same batch asked for a `wake`-suspend, which is a
   * separate request that a delivered answer says nothing about.
   *
   * **While a suspend is open, only `tool` messages are accepted.** Nothing
   * may come between an assistant message and the results it is waiting on, so
   * a `user` message delivered ahead of the answer is refused and reported as
   * an {@link InputBlockedBySuspendError} — appending it is how a resumed run
   * ends up sending `assistant(tool_calls) → user → tool`, which providers
   * reject. Return the answering result first and the rest is accepted after
   * it, in order.
   *
   * **A host that asked to stop still stops.** Delivered input says the turn
   * is not over; `shouldStop` says the run is, and the run wins — the messages
   * are kept and the loop ends as `aborted` rather than paying for another
   * model call.
   *
   * Messages are otherwise appended in the order returned, and the loop does
   * not validate them further: this is the host's transcript, committed on the
   * host's side, arriving at the one place the loop can take it.
   *
   * **A throw propagates out of `runToolLoop` unconverted**, like
   * `beforeToolMessageAccepted` and for the same reason: a host that cannot
   * say what it has committed cannot be told the run went on without it.
   */
  onStepSettled?: (step: {
    assistantMessage: OpenAI.ChatCompletionMessage;
    cumulativeToolCalls: number;
    wouldEnd: boolean;
  }) => StepSettlement | Promise<StepSettlement>;
  /**
   * Activate newly loaded plugins (mutate the catalog/active set). Optional:
   * a host with a fixed tool surface has nothing to activate, and requiring an
   * empty function from it bought nothing.
   */
  activatePlugins?: (pluginNames: string[]) => void;
  /**
   * Activate newly loaded skills: inject their bodies into the system prompt's
   * instructions section and refresh the catalog. Async because a host may
   * re-read the module body from storage. Expected to no-op for a ref the agent
   * cannot access — the loop does not pre-validate them. Optional, as above.
   */
  activateSkills?: (skillRefs: string[]) => Promise<void> | void;
  /**
   * Clock for the model-time and tool-time measurements in
   * {@link ToolLoopResult.stats}. Defaults to `Date.now`, the package's one
   * sanctioned ambient-clock exception; inject a fake to make timing
   * assertions deterministic.
   *
   * **Must be a real monotonic clock when tools can run concurrently.** Each
   * call records `now()` at dispatch and again when it settles, so a shared
   * counter that only advances when some *other* call asks it to will charge
   * one tool for another's time. A cooperatively-advanced fake is fine for a
   * serial batch (`runsSerially`), and fine for the model-time figures always.
   *
   * Measured *around* `callModel`, so the number includes whatever that
   * function does internally — a defect retry, a fallback provider, a routing
   * hop. That is the honest figure for cost-and-latency accounting: it is what
   * the turn actually took. A host that wants the successful attempt's
   * generation time alone already has it, inside its own transport.
   */
  now?: () => number;

  // --- batch policy -------------------------------------------------------
  /**
   * Must this call run on its own, before the rest of its batch?
   *
   * True for any call that changes what the later calls can do — activating a
   * plugin, loading an instruction module. The loop runs those one at a time
   * and applies each outcome immediately, so a dependent call in the SAME batch
   * sees the effect. Everything else fans out concurrently, pooled per tool
   * name.
   *
   * Unwired, nothing is serial: every call runs in the concurrent phase, which
   * is correct for a host whose tools do not reshape the tool surface.
   */
  runsSerially?: (toolCall: OpenAI.ChatCompletionMessageToolCall) => boolean;
  /**
   * Should this thrown error abort the run rather than become a tool error the
   * model reads?
   *
   * Two things belong here: **cancellation**, which must propagate even when no
   * `ensureNotCancelled` observer is wired, and a failure to *record* an
   * outcome — synthesizing "the tool failed" over a persistence failure tells
   * the model a lie about work that may well have happened.
   *
   * Unwired, nothing is fatal: every failure is synthesized into a tool error
   * and the run continues. That is the safe default for an isolated tool, and
   * the wrong one as soon as your tools write anything.
   */
  isFatalToolError?: (error: unknown) => boolean;

  // --- optional lifecycle observers (no-op defaults) ----------------------
  /**
   * A tool call failed and was answered with a synthesized error instead of
   * throwing. The model sees it either way; without this observer nothing else
   * does.
   */
  onToolCallRejected?: (toolCallId: string, error: unknown) => void;
  /** Throw to abort (run cancelled). Checked at the top of each iteration and after each batch. */
  ensureNotCancelled?: () => Promise<void> | void;
  /** Throw a timeout error if the wall-clock budget is exhausted (checked first each iteration). */
  throwIfTimedOut?: () => void;
  /** Phase status for rich client feedback. */
  onStatus?: (status: RunStatus) => void;
  /** Intermediate assistant text emitted alongside tool calls. NOTE: when
   *  `onAssistantMessage` is also wired, a text-with-tools message fires to BOTH
   *  observers (they have different contracts — see below). Wire only one per
   *  output surface so the same text isn't delivered twice. */
  onThinking?: (content: string) => void;
  /**
   * Every assistant message that carries non-empty text content, fired the
   * moment it's produced — whether or not it also requested tools, and including
   * the final tool-less reply. Unlike `onThinking` (text-with-tools only), this
   * sees ALL of a turn's assistant text, so a caller can stream each message to
   * the client as it lands rather than batching them at turn end. Receives the
   * already-trimmed content.
   */
  onAssistantMessage?: (content: string) => void;
  /** Flush accumulated progress (heartbeat). Called force-true after each turn. */
  flushProgress?: () => Promise<void> | void;
  /** Cumulative live progress: the running output-token count (updated
   *  mid-stream and after each model turn) and the number of tool calls made so
   *  far this run (the count only — never a name or a result). Called with the
   *  estimate during streaming and with real totals at each iteration boundary,
   *  and again right after a batch is dispatched so the count rises promptly. */
  onProgressUpdate?: (outputTokens: number, toolCalls: number) => void;
  /** Return true to stop the loop after the current turn (e.g. agent disabled mid-run). */
  shouldStop?: () => Promise<boolean> | boolean;
  /**
   * Called when the model produced a turn with NO tool calls — i.e. the loop is
   * about to stop. Return a non-empty string to inject it as a synthetic `user`
   * message and CONTINUE the loop instead of stopping; return null/empty to stop
   * as normal (the default behavior when unwired). Use it to push a stalled turn
   * forward — nudging an agent that ended a turn having made no progress at all.
   * Receives the cumulative tool-call count so the hook can detect exactly that.
   * MUST be self-bounding (eventually return null); `maxIterations` bounds it
   * regardless, and the injected `user` message is model-only — a caller that
   * persists a transcript should ignore `user` turns it didn't originate.
   *
   * `cumulativeToolCalls` is the running total across ALL iterations of this run
   * (not just the current one), so a hook can detect "made zero tool calls the
   * whole run" — a tool call in any earlier iteration makes it non-zero.
   */
  onTurnWouldEnd?: (
    assistantMessage: OpenAI.ChatCompletionMessage,
    cumulativeToolCalls: number,
  ) => string | null | Promise<string | null>;
  /** Drain queued human interrupts for this run. */
  drainInterrupts?: () => Array<{ userId: string; content: string }>;
  /** Report that an interrupt was received (activity row). */
  onInterruptReceived?: (interrupt: {
    userId: string;
    content: string;
  }) => Promise<void> | void;
  /**
   * Bounds the tool batch. Combine the run's deadline with any cancellation
   * signal (`deadline.withExternal(cancelSignal)`) and pass the result.
   *
   * Without it, `throwIfTimedOut` and `ensureNotCancelled` are only consulted
   * between iterations, so a deadline that fires while the model is being
   * called still lets the whole batch execute its side effects, and a hung tool
   * holds the run open for as long as it runs. Those are throw-based ports and
   * cannot express "stop claiming new work" to a pool already in flight — only
   * a signal can.
   *
   * Optional so an existing host is unchanged until it opts in.
   */
  signal?: AbortSignal | undefined;
  /** Decide whether the live context (token count) needs auto-compaction. */
  needsCompaction?: (currentTokens: number) => boolean;
  /**
   * Perform + persist a compaction and return the new transcript + usage. The
   * loop owns swapping `state.messages` and resetting the live counts; this
   * callback owns the LLM passes and persistence (session + activity row).
   */
  applyCompaction?: (
    trigger: "manual" | "auto",
    messages: OpenAI.ChatCompletionMessageParam[],
  ) => Promise<CompactionApplied>;
}

/**
 * Repeatedly call the model and execute the tools it requests, until it stops
 * requesting them, a caller stops the loop, a tool suspends the run, or
 * `maxIterations` is reached.
 *
 * Intrinsic: plugin/module activation, two-phase tool batching, compaction
 * (manual + auto), interrupt draining, and the suspend protocol. Injected:
 * every side effect — status, heartbeat, activity, persistence, cancellation.
 *
 * Mutates `state` (messages + token accumulators) in place. That is deliberate
 * rather than a return value: a caller's heartbeat reads live totals off it
 * mid-loop, which a returned result could not provide until the run ended.
 * The {@link ToolLoopResult} it *returns* is the complementary half — the
 * run's conclusion, which only exists once the loop is over.
 */
export function runToolLoop(params: ToolLoopParams): Promise<ToolLoopResult>;
export function runToolLoop(
  params: ToolLoopParams,
  control: LoopControl,
): Promise<ToolLoopResult | { stopReason: "checkpointed"; stats: RunStats }>;
export async function runToolLoop(
  params: ToolLoopParams,
  control?: LoopControl,
): Promise<ToolLoopResult | { stopReason: "checkpointed"; stats: RunStats }> {
  const {
    state,
    maxIterations,
    callModel,
    buildTools,
    runToolCall,
    activatePlugins,
    activateSkills,
    now = Date.now,
    ensureNotCancelled,
    throwIfTimedOut,
    onStatus,
    signal,
    onThinking,
    onAssistantMessage,
    flushProgress,
    onProgressUpdate,
    shouldStop,
    onTurnWouldEnd,
    drainInterrupts,
    onInterruptReceived,
    needsCompaction,
    applyCompaction,
    runsSerially,
    isFatalToolError,
    onToolCallRejected,
    beforeToolMessageAccepted,
    onStepSettled,
  } = params;

  let stats = emptyRunStats();
  // The default is the outcome of falling out of the `for` — every other exit
  // assigns before it breaks. Seeding it here rather than at each `break` means
  // a future exit path that forgets to set one reports "we ran out of
  // iterations", which is the conservative lie: it says the run did NOT finish.
  let stopReason: StopReason = "iteration_limit";

  /**
   * Run one tool call, recording its duration against its tool name.
   *
   * Wrapped rather than measured at the two call sites because the serial and
   * pooled phases both dispatch, and a call that *throws* still consumed the
   * time — a `finally` is the only way to catch both halves of that in one
   * place. Refused calls never reach here (the pool rejects them at claim
   * time), which is exactly why `stats.toolCalls` counts dispatches.
   */
  const dispatchToolCall = async (
    tc: OpenAI.ChatCompletionMessageToolCall,
  ): Promise<ToolCallOutcome> => {
    const startedAt = now();
    try {
      return await runToolCall(tc);
    } finally {
      // A throw in a `finally` REPLACES the value the `try` produced, so
      // measuring a call must never be able to fail. It once could: reading
      // `tc.function.name` unguarded turned a tool that ran — side effect and
      // all — into a synthesized "it failed" the model then acted on. The
      // wire type says `function` is always there; this repo knows better
      // (`completion/tool-calls.ts` types it optional, and the host's own
      // dispatcher reads it with an `in` check for exactly this reason).
      try {
        stats = accumulateToolCall(stats, toolCallStatsKey(tc), now() - startedAt);
      } catch {
        // Accounting is observability. Losing a measurement is survivable;
        // losing the call's outcome is not.
      }
    }
  };

  // An observer must not be able to change control flow: a host logger that
  // throws while reporting a tool failure would otherwise turn a *reported*
  // failure into a fatal one, which is the opposite of what the report is for.
  const reportRejection = (toolCallId: string, error: unknown): void => {
    try {
      onToolCallRejected?.(toolCallId, error);
    } catch {
      // Nothing useful to do — the reporting channel is the thing that broke.
    }
  };

  // Ask the host what it has committed for this settled step. Unwired, the
  // answer is "nothing, keep going" — the one shape every call site below
  // reads, so neither of them branches on whether the port exists.
  const settleStep = async (
    assistantMessage: OpenAI.ChatCompletionMessage,
    wouldEnd: boolean,
  ): Promise<StepSettlement> => {
    const settlement = await onStepSettled?.({
      assistantMessage,
      cumulativeToolCalls: state.toolCalls,
      wouldEnd,
    });
    // Read field by field rather than trusting the object whole: the types say
    // both are present, and a JavaScript host (this package is published, and
    // was reimplemented once already as a patch) that returns `{ stop: true }`
    // would otherwise crash the run inside the loop rather than stop it.
    return {
      messages: settlement?.messages ?? [],
      stop: settlement?.stop === true,
    };
  };

  // Append a settlement's messages, honouring the one ordering rule an open
  // `answer`-suspend imposes: until that call has its result, nothing else may
  // come between it and the assistant message that asked for it. A delivered
  // result for the open call clears the pause (the answer arrived in the same
  // breath as the question); anything that is not a `tool` message is refused
  // while the pause is open, because appending it is how a resumed run ends up
  // sending `assistant(tool_calls) → user → tool`.
  //
  // Shared by both settle sites rather than living in the batch arm alone: a
  // caller may seed `state.suspended` when it resumes a run, and the rule is
  // about the transcript, not about which branch produced it.
  const applySettledMessages = (
    messages: OpenAI.ChatCompletionMessageParam[],
  ): { appended: number; answeredSuspend: boolean } => {
    let appended = 0;
    let answeredSuspend = false;
    for (const message of messages) {
      const openSuspension = state.suspended;
      if (openSuspension) {
        if (message.role !== "tool") {
          reportRejection(
            openSuspension.toolCallId,
            new InputBlockedBySuspendError(openSuspension.toolCallId, message.role),
          );
          continue;
        }
        if (message.tool_call_id === openSuspension.toolCallId) {
          state.suspended = undefined;
          answeredSuspend = true;
        }
      }
      state.messages.push(message);
      appended += 1;
    }
    return { appended, answeredSuspend };
  };

  // Swap in a freshly-compacted transcript and reset the live counts. The
  // provider count no longer reflects the compacted array, so drop it — the
  // auto-compaction check skips while it's 0 (preventing an immediate
  // re-trigger), and the next turn records a fresh real count.
  const applyCompactionResult = (
    result: CompactionApplied,
    modelTimeMs: number,
  ): void => {
    state.inputTokens += result.inputTokens;
    state.outputTokens += result.outputTokens;
    state.costCents += result.costCents;
    // Real spend, but not an agent turn — a compaction is the harness talking
    // to itself. Counting it in `stats.turns` would make that number
    // incomparable with `maxIterations`.
    stats = accumulateAuxiliarySpend(stats, {
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      costCents: result.costCents,
      cachedInputTokens: result.cachedInputTokens ?? null,
      modelTimeMs,
    });
    state.messages.length = 0;
    state.messages.push(...result.messages);
    state.lastPromptTokens = 0;
    state.lastOutputTokens = 0;
  };

  // Compact, account, then persist — in that order, and timing only the model
  // pass. `persist` is host I/O; folding it into `modelTimeMs` would inflate
  // the one number that exists to isolate the provider's contribution.
  // `compact` is passed in rather than read from the closure so each call site
  // narrows the optional itself and no non-null assertion is needed.
  const compactNow = async (
    compact: NonNullable<ToolLoopParams["applyCompaction"]>,
    trigger: "manual" | "auto",
  ): Promise<void> => {
    const startedAt = now();
    const compacted = await compact(trigger, state.messages);
    applyCompactionResult(compacted, now() - startedAt);
    await compacted.persist();
  };

  let iterationsUsed = control?.iterationsUsed ?? 0;
  let unsettledAbort = false;
  if (!Number.isSafeInteger(iterationsUsed) || iterationsUsed < 0) {
    throw new Error("Invalid resumed iteration count");
  }
  for (let iteration = iterationsUsed; iteration < maxIterations; iteration++) {
    // The previous iteration has processed suspension, compaction, interrupts,
    // and nudges before reaching this point. Never checkpoint inside a batch.
    if (control) {
      if (state.suspended) throw new UnsettledLoopBoundaryError();
      assertCheckpointTranscript(state.messages, null);
    }
    if (control && await control.onBoundary({
      position: { kind: "ready" }, iterationsUsed, state, stats,
    }) === "checkpoint") return { stopReason: "checkpointed", stats };
    throwIfTimedOut?.();
    await ensureNotCancelled?.();

    const tools = buildTools();
    onStatus?.(iteration === 0 ? "thinking" : "thinking_with_tools");

    // Stream live token progress: the per-call estimate is added to the
    // cumulative from prior iterations so a caller's counter rises across a
    // multi-iteration run. The real cumulative is published right after the
    // call returns (below), reconciling any estimate drift.
    //
    // Clamped to a per-call high-water mark because `callModel` may internally
    // retry — a defect retry, another provider, the fallback model — and each
    // attempt restarts its own estimate at zero. Unclamped, a caller's counter
    // visibly runs backwards mid-turn ("1.2k tokens" → blank → "120 tokens"),
    // which reads as lost work at exactly the moment the system is recovering
    // from a fault. The mark is per-call, so the post-call reconciliation to
    // the real total below is free to correct downward.
    const baseOutputTokens = state.outputTokens;
    let progressHighWater = baseOutputTokens;
    const turnStartedAt = now();
    const result = await callModel(
      state.messages,
      tools.length > 0 ? tools : undefined,
      // Carry the cumulative tool count alongside the streamed token estimate so
      // the pill shows both; no tools run *during* a model call, so the count is
      // whatever has accumulated from prior iterations.
      onProgressUpdate
        ? (estCallTokens) => {
            progressHighWater = Math.max(
              progressHighWater,
              baseOutputTokens + estCallTokens,
            );
            onProgressUpdate(progressHighWater, state.toolCalls);
          }
        : undefined,
    );

    iterationsUsed = iteration + 1;
    // Folded through the shared `accumulateTurn` rather than incremented
    // field-by-field, so `stats` and every other producer of `RunStats` (child
    // runs, a host's own transport) agree on what a turn contributes — notably
    // the derived `outputTokensPerSecond`, which is recomputed from totals
    // rather than averaged.
    stats = accumulateTurn(stats, {
      message: result.message,
      usage: {
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        // `null` when the transport did not report one — `accumulateTurn`
        // then contributes nothing for this turn rather than counting a zero,
        // which is why the total reads as a floor.
        cachedInputTokens: result.cachedInputTokens ?? null,
        costCents: result.costCents,
      },
      timings: {
        // Only the transport sees the first byte. The loop sees the call.
        ttftMs: null,
        generationMs: now() - turnStartedAt,
      },
    });

    state.inputTokens += result.inputTokens;
    state.outputTokens += result.outputTokens;
    state.costCents += result.costCents;
    state.lastPromptTokens = result.inputTokens;
    state.lastOutputTokens = result.outputTokens;
    state.hasFreshTokenCount = true;

    const assistantMessage = result.message;
    // `acceptMessage: false` keeps a tolerated empty completion out of the
    // transcript — the turn is still accounted for above. Refused for a
    // tool-calling turn: the batch below appends results, and results whose
    // request is missing are a transcript the next provider call rejects.
    const requestedToolCalls = assistantMessage.tool_calls ?? [];
    if (result.acceptMessage === false && requestedToolCalls.length > 0) {
      const misuse = new DiscardedTurnWithToolCallsError(requestedToolCalls.length);
      for (const tc of requestedToolCalls) {
        reportRejection(tc.id, misuse);
      }
    }
    if (result.acceptMessage !== false || requestedToolCalls.length > 0) {
      state.messages.push(assistantMessage);
    }

    if (assistantMessage.content && assistantMessage.tool_calls?.length) {
      onThinking?.(assistantMessage.content);
    }
    // Stream every assistant text message (with or without tool calls, including
    // the final tool-less reply) so a caller can surface it the moment it lands.
    if (typeof assistantMessage.content === "string") {
      const trimmed = assistantMessage.content.trim();
      if (trimmed) onAssistantMessage?.(trimmed);
    }

    // Force-flush progress so each iteration bumps the heartbeat at least once.
    await flushProgress?.();

    // Mid-run stop (e.g. the agent was disabled while running). Asked once and
    // held, because *whether* to stop and *what to call it* are answered at two
    // different points below, and asking a host predicate twice could get two
    // answers.
    const stopRequested = (await shouldStop?.()) ?? false;
    if (stopRequested && assistantMessage.tool_calls?.length) {
      // Still mid-task, and the batch has not run. Emit the iteration's final
      // progress (the real cumulative token total) before bailing.
      onProgressUpdate?.(state.outputTokens, state.toolCalls);
      stopReason = "aborted";
      unsettledAbort = true;
      break;
    }

    // Count this iteration's tool batch (a single iteration can request several
    // tools at once) BEFORE the single progress emit, so the new tool count rides
    // the SAME frame as the iteration's real token total. A separate
    // post-increment emit would be coalesced by a throttled transport and lag
    // the count behind the tokens it belongs with.
    const toolCalls = assistantMessage.tool_calls;
    if (toolCalls && toolCalls.length > 0) state.toolCalls += toolCalls.length;
    onProgressUpdate?.(state.outputTokens, state.toolCalls);

    if (!toolCalls || toolCalls.length === 0) {
      // The step is settled: no batch to run, so the transcript is coherent
      // right here. Ask the host for anything it has committed since the turn
      // began — real input outranks a nudge, so this runs BEFORE
      // `onTurnWouldEnd`. A host that delivers a message is saying the turn is
      // not over, so the loop continues with it appended rather than asking
      // whether a turn that has more to answer looked stalled.
      const settlement = await settleStep(assistantMessage, true);
      const settledInput = applySettledMessages(settlement.messages);
      if (settlement.stop) {
        stopReason = "aborted";
        break;
      }
      if (settledInput.appended > 0) {
        // Delivered input says the turn is not over; a host that asked to stop
        // says the RUN is. The stop wins, exactly as it does over a nudge
        // below — otherwise `shouldStop` ("stop after the current turn") pays
        // for another model call and answers after it was cancelled. The
        // messages stay: the host committed them, and dropping them here would
        // leave its ledger and this transcript disagreeing.
        if (stopRequested) {
          onProgressUpdate?.(state.outputTokens, state.toolCalls);
          stopReason = "aborted";
          break;
        }
        continue;
      }
      // The model stopped calling tools — normally the turn is done. Give a
      // caller a chance to push it forward instead: if `onTurnWouldEnd` returns
      // text, inject it as a synthetic user message and keep looping. The hook
      // is self-bounding and `maxIterations` is the hard ceiling, so this cannot
      // spin forever.
      const nudge = await onTurnWouldEnd?.(assistantMessage, state.toolCalls);
      if (nudge && nudge.trim()) {
        // The host's own hook says this turn was NOT a finished answer — it
        // was a stall worth pushing past. If the host also asked to stop, that
        // wins, but the outcome is an abort: calling it `done` would report a
        // run the host itself judged unfinished as a successful answer.
        if (stopRequested) {
          onProgressUpdate?.(state.outputTokens, state.toolCalls);
          stopReason = "aborted";
          break;
        }
        state.messages.push({ role: "user", content: nudge });
        continue;
      }
      // A tool-less turn no hook wanted to push past is a finished answer: it
      // is already in `state.messages` and has already gone out through
      // `onAssistantMessage`. `done` even when the host asked to stop in the
      // same breath — reporting `aborted` would have a host badge a delivered
      // answer as cancelled, or suppress it.
      if (stopRequested) onProgressUpdate?.(state.outputTokens, state.toolCalls);
      stopReason = "done";
      break;
    }

    onStatus?.("executing_tools");

    // Two-phase batch: run activation calls (`tool-discovery__load_plugin` and
    // `skills__load_skill`) SERIALLY and activate each immediately (so a
    // dependent tool from the same batch sees the plugin active / the skill's
    // owner plugin loaded), then run the rest concurrently, pooled per tool
    // name. Outcomes are collected by original index and applied in emission
    // order.
    const outcomes: ToolCallOutcome[] = new Array(toolCalls.length);
    const deferredIndices: number[] = [];
    const deferredCalls: OpenAI.ChatCompletionMessageToolCall[] = [];

    for (let i = 0; i < toolCalls.length; i++) {
      const tc = toolCalls[i]!;
      if (runsSerially?.(tc)) {
        // The serial phase runs before the pool and is a loop of its own, so it
        // needs the same claim-time check — otherwise an aborted batch still
        // executes every activation call ahead of the pool that refuses to.
        if (signal?.aborted === true) {
          const aborted = new AbortedToolCallError(tc.id);
          // Routed through the same three seams as a pooled refusal — fatal
          // classification, the rejection observer, and the synthesized answer.
          // The serial phase used to do none of them, so one condition produced
          // two behaviours depending on which half of the batch a call landed in.
          if (isFatalToolError?.(aborted)) throw aborted;
          reportRejection(tc.id, aborted);
          outcomes[i] = {
            toolMessage: toolResultMessage(tc.id, {
              success: false,
              kind: "not_run",
              error: aborted.message,
            }),
          };
          continue;
        }
        // Mirror the concurrent batch's graceful error synthesis so a failing
        // activation call (transient network/DB/timeout) doesn't crash the
        // run — but let a fatal error propagate for an immediate abort.
        try {
          const outcome = await dispatchToolCall(tc);
          outcomes[i] = outcome;
          if (outcome.loadedPluginName) {
            if (activatePlugins) {
              activatePlugins([outcome.loadedPluginName]);
            } else {
              // The port is optional, but silence here is not. An outcome
              // carrying `loadedPluginName` is proof this host's tools DO
              // reshape the tool surface, so the port's absence is a wiring
              // bug, not a host that doesn't need it. Dropped quietly, the
              // model gets a success for `load_plugin`, never sees the tools,
              // and re-calls it every iteration until the budget is gone.
              reportRejection(tc.id, new MissingActivationPortError("activatePlugins"));
            }
          }
          if (outcome.loadedSkillRef) {
            // Auto-load the module's owner plugin first so its tools are active
            // by the time the agent follows the freshly-injected instructions.
            if (outcome.autoLoadedPlugins?.length) {
              if (activatePlugins) {
                activatePlugins(outcome.autoLoadedPlugins);
              } else {
                reportRejection(tc.id, new MissingActivationPortError("activatePlugins"));
              }
            }
            if (activateSkills) {
              await activateSkills([outcome.loadedSkillRef]);
            } else {
              reportRejection(tc.id, new MissingActivationPortError("activateSkills"));
            }
          }
        } catch (err) {
          if (isFatalToolError?.(err)) throw err;
          reportRejection(tc.id, err);
          outcomes[i] = {
            toolMessage: toolResultMessage(tc.id, {
              success: false,
              error: err instanceof Error ? err.message : String(err),
            }),
          };
        }
        continue;
      }
      deferredIndices.push(i);
      deferredCalls.push(tc);
    }

    const settled = await runToolCallsPooledByTool(
      deferredCalls,
      dispatchToolCall,
      { signal },
    );
    // The pool returns one ordered settlement per call. Each deferred call
    // also has an index recorded by the same loop that queued it.
    for (let j = 0; j < deferredCalls.length; j++) {
      const origIndex = deferredIndices[j]!;
      const call = deferredCalls[j]!;
      const settledResult = settled[j]!;
      if (settledResult.status === "fulfilled") {
        outcomes[origIndex] = settledResult.value;
      } else {
        // Let a fatal error abort the run immediately rather than be
        // synthesized into a tool error — symmetric with the serial path, and
        // so cancellation propagates even if no `ensureNotCancelled` boundary
        // observer is wired.
        if (isFatalToolError?.(settledResult.reason)) throw settledResult.reason;
        reportRejection(call.id, settledResult.reason);
        outcomes[origIndex] = {
          toolMessage: toolResultMessage(call.id, {
            success: false,
            // A refused call is not a failed one, and the envelope alone
            // cannot say so — `success: false` plus a sentence is exactly what
            // a tool that ran and failed produces. The discriminant is what
            // lets a model (or a host) tell them apart without matching on
            // prose. See `ToolFailureKind`.
            ...(settledResult.reason instanceof AbortedToolCallError
              ? { kind: "not_run" as const }
              : {}),
            error:
              settledResult.reason instanceof Error
                ? settledResult.reason.message
                : String(settledResult.reason),
          }),
        };
      }
    }

    let compactionRequested = false;
    let suspendRequested = false;
    // Dense over ACCEPTED results, so a withheld suspend leaves no gap — see
    // `beforeToolMessageAccepted`. Reset per batch: it is a position within
    // this step, not a running total.
    let acceptedResultOrdinal = 0;
    const acceptToolMessage = async (
      message: OpenAI.ChatCompletionToolMessageParam,
    ): Promise<void> => {
      // A throw propagates: a host that could not record the result must not
      // be handed a transcript that says the model already saw it.
      await beforeToolMessageAccepted?.(message, acceptedResultOrdinal);
      state.messages.push(message);
      acceptedResultOrdinal += 1;
    };
    for (const outcome of outcomes) {
      // An `answer`-suspend WITHHOLDS its tool message — the result is the
      // future answer, threaded back on resume. At most one may be open: the
      // first becomes `state.suspended`; any additional suspend in the same
      // batch is answered with a synthesized error so no second slot is left
      // unpaired. A `wake`-suspend keeps its tool message (it re-enters through
      // a fresh prompt, not a threaded answer).
      if (outcome.suspend) {
        suspendRequested = true;
        if (outcome.suspend.resumeKind === "answer") {
          if (!state.suspended) {
            // Rebuild with the literal "answer" kind so the assignment matches
            // `ToolLoopState.suspended` (always answer — see its type).
            state.suspended = { ...outcome.suspend, resumeKind: "answer" };
            // The message is withheld; the call's OTHER signals are not. A
            // compaction asked for by the same outcome is skipped while the
            // pause is open (the arm below checks `state.suspended`) and runs
            // if a same-step answer clears it — whereas dropping the flag here
            // loses it for good, which is only invisible while an answered
            // suspend could not continue the run.
            if (outcome.requestCompaction) compactionRequested = true;
            continue; // withhold this call's tool message
          }
          // Through the shared encoder, and carrying a `kind`, like every
          // other synthesized failure. It was the last hand-rolled envelope in
          // this file, which meant the harness itself emitted two error shapes
          // in one transcript — the exact thing `toolResultMessage` exists to
          // prevent. `conflict` because it is a concurrency loss: the call was
          // refused only because another question is already open.
          await acceptToolMessage(
            toolResultMessage(outcome.suspend.toolCallId, {
              success: false,
              kind: "conflict",
              error:
                "This question was not asked — you already have one waiting " +
                "for an answer, and only one can be open at a time. When that " +
                "answer arrives, ask this one then, or finish the turn with " +
                "what you have.",
            }),
          );
          continue;
        }
        // `wake` (e.g. sleep_until): fall through and push the tool message, then
        // end the run — it re-enters via a prompt, not a threaded answer.
      }
      await acceptToolMessage(outcome.toolMessage);
      if (outcome.requestCompaction) compactionRequested = true;
    }

    // An aborted batch ends the run HERE — after every refused call has been
    // answered in the transcript (so nothing dangles), and before the suspend,
    // compaction and persist arms below. Two reasons, and the second is the sharp one:
    //
    //  - The transcript now contains a synthesized result for every refused
    //    call. Reaching `saveSession` durably records "these tools failed" for
    //    work that was never dispatched, and a resumed run reads that as fact —
    //    the same lie `isFatalToolError` already refuses to tell for a write it
    //    could not record. The suspend arm `break`s BEFORE the cancellation
    //    boundary below, so without this check that path persists it.
    //  - A host whose `signal` is not also reflected by `throwIfTimedOut` /
    //    `ensureNotCancelled` would otherwise refuse the batch, loop, and pay
    //    for another model call — every iteration to `maxIterations`.
    //
    // Delegating to the throw ports rather than throwing directly keeps the
    // terminal error the host's to name (a timeout and a cancellation are
    // different outcomes, and only the host knows which fired).
    if (signal?.aborted === true) {
      throwIfTimedOut?.();
      await ensureNotCancelled?.();
      // Neither port is required, and a host that wired only `signal` would
      // otherwise refuse every batch and pay for a fresh model call each
      // iteration until `maxIterations`. Break so the abort ends the run on its
      // own, rather than only when some other port happens to agree.
      //
      // `aborted`, not `deadline`, even when the signal IS a deadline: by the
      // time a wall-clock budget and a cancellation are combined into one
      // `AbortSignal` the loop cannot tell them apart, and `throwIfTimedOut`
      // above has already had its chance to name a timeout by throwing.
      stopReason = "aborted";
      unsettledAbort = true;
      break;
    }

    // The step is settled: every result the batch produced is in the
    // transcript and nothing is half-applied, so this is where host-committed
    // input can join without splitting a call from its result.
    const settlement = await settleStep(assistantMessage, false);
    const settledInput = applySettledMessages(settlement.messages);
    // The answer arrived in the same breath as the question, so the run is no
    // longer waiting on a person. A `wake`-suspend from another call in the
    // same batch is a separate request the answer says nothing about, so it
    // still ends the run — recomputed from the outcomes rather than left set,
    // because `suspendRequested` is true for the answered call too.
    if (settledInput.answeredSuspend) {
      suspendRequested = outcomes.some(
        (outcome) => outcome.suspend?.resumeKind === "wake",
      );
    }
    if (settlement.stop) {
      stopReason = "aborted";
      break;
    }

    // A tool asked to end the run (it scheduled its own resume, or recorded an
    // open call awaiting an answer). The tool results are already in
    // state.messages above; stop now so the run doesn't keep going. Mark it as
    // an intentional pause so a caller doesn't read the trailing tool-calling
    // turn as an iteration-limit cutoff. Honor an explicit
    // compaction requested in the same batch so the saved transcript is
    // compacted — UNLESS a suspend is pending: compacting would rewrite the open
    // suspended call, and that pair must survive verbatim to be resumable.
    if (suspendRequested) {
      if (compactionRequested && applyCompaction && !state.suspended) {
        await compactNow(applyCompaction, "manual");
      }
      state.endedTurnViaTool = true;
      // `state.suspended` is set only by the `answer` branch, so its presence
      // IS the discriminant between "a person has to reply" and "this comes
      // back on its own". Reading it here, once, is what saves every host
      // from reading it themselves.
      stopReason = state.suspended ? "waiting_for_reply" : "resuming_later";
      break;
    }

    await ensureNotCancelled?.();

    // Explicit (tool-requested) compaction, flushed at the batch boundary so
    // the summary sees the full batch of tool responses. Account for the
    // compaction usage BEFORE persisting so a persist failure can't drop the
    // tokens it already consumed.
    if (compactionRequested && applyCompaction) {
      await compactNow(applyCompaction, "manual");
    }

    // Drain human interrupts queued while the agent was working.
    for (const interrupt of drainInterrupts?.() ?? []) {
      // Strip control chars/newlines from the id so it can't break out of the
      // `[Interrupt from user …]` header line and inject transcript structure.
      // (Internal-only sources today, but a future external caller could surface
      // user-supplied ids.)
      const safeUserId = stripControlChars(interrupt.userId);
      state.messages.push({
        role: "user",
        content: renderInterruptMessage(safeUserId, interrupt.content),
      });
      await onInterruptReceived?.(interrupt);
    }

    // Auto-compaction using the provider's real token count. Skip when there's
    // no fresh count (before the first call, or right after a compaction reset
    // it to 0) so we don't immediately re-trigger.
    const currentTokens = state.lastPromptTokens + state.lastOutputTokens;
    if (
      state.lastPromptTokens > 0 &&
      needsCompaction?.(currentTokens) &&
      applyCompaction
    ) {
      await compactNow(applyCompaction, "auto");
    }
  }

  if (control && (unsettledAbort || (stopReason !== "waiting_for_reply" && state.suspended))) {
    throw new UnsettledLoopBoundaryError();
  }
  if (control) assertCheckpointTranscript(state.messages, stopReason === "waiting_for_reply" ? state.suspended?.toolCallId ?? null : null);
  if (control) await control.onBoundary({
    position: positionForStop(stopReason), iterationsUsed, state, stats,
  });
  return { stopReason, stats };
}
