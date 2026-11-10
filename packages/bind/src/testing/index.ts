/**
 * `@juno-ai/bind/testing` — fixtures for testing an agent against the harness
 * without a provider, a network, or a credential.
 *
 * The loop's hardest behaviour to get right is also the hardest to test: what
 * happens across several turns, with several tools, when one of them fails or
 * the run is cut short. Reaching that state normally means mocking a streaming
 * chat-completions client, which is a lot of scaffolding to write before the
 * first assertion — so most consumers write it once, badly, and then only test
 * the happy path.
 *
 * These are the fixtures this package's own cross-module suites use, published
 * so a consumer does not rewrite them. They are ordinary values with no magic:
 * a scripted model is a queue of prepared turns, and a harness is a
 * {@link ToolLoopParams} you can override any field of.
 *
 * ```ts
 * import { loopHarness, toolCall, toolCallTurn, finalAnswer } from "@juno-ai/bind/testing";
 * import { runToolLoop } from "@juno-ai/bind/loop";
 *
 * const h = loopHarness([
 *   toolCallTurn([toolCall("search", { q: "bind" })]),
 *   finalAnswer("Found it."),
 * ]);
 * const { stopReason, stats } = await runToolLoop(h.params);
 * expect(stopReason).toBe("done");
 * expect(h.ran).toEqual(["search"]);
 * ```
 *
 * This module ships in the published package rather than living beside the
 * tests, so it is held to the same portability fences as `src/`: no Node
 * builtins, no `process`, no framework, peer dependencies only.
 */
import type OpenAI from "openai";
import type {
  ToolCallOutcome,
  ToolLoopParams,
  ToolLoopState,
} from "../loop/tool-loop";
import type { TurnStreamEvent, TurnStreamSink } from "../completion/text-stream";
import { toolResultMessage } from "../plugins/tool-message";

/**
 * A sink that records what it was handed. `retractable` is the whole decision
 * the text stream turns on, so it is the one required argument.
 */
export function recordingSink(
  retractable: boolean,
): TurnStreamSink & { readonly events: TurnStreamEvent[] } {
  const events: TurnStreamEvent[] = [];
  return {
    retractable,
    events,
    emit(event) {
      events.push(event);
    },
  };
}

export function freshState(
  overrides: Partial<ToolLoopState> = {},
): ToolLoopState {
  return {
    messages: [
      { role: "system", content: "sys" },
      { role: "user", content: "do the thing" },
    ],
    inputTokens: 0,
    outputTokens: 0,
    costCents: 0,
    lastPromptTokens: 0,
    lastOutputTokens: 0,
    hasFreshTokenCount: false,
    toolCalls: 0,
    ...overrides,
  };
}

/** An assistant message, with tool calls when given names. */
export function assistant(
  content: string | null,
  toolCalls?: ReadonlyArray<{ id: string; name: string; args?: string }>,
): OpenAI.ChatCompletionMessage {
  return {
    role: "assistant",
    content,
    refusal: null,
    ...(toolCalls === undefined
      ? {}
      : {
          tool_calls: toolCalls.map((tc) => ({
            id: tc.id,
            type: "function" as const,
            function: { name: tc.name, arguments: tc.args ?? "{}" },
          })),
        }),
  };
}

/**
 * A successful tool result, encoded exactly as production encodes one.
 *
 * Routed through `toolResultMessage` rather than a bare `JSON.stringify` so a
 * fixture-built transcript has the same shape a real run produces. A fixture
 * that invents its own envelope reintroduces the "two formats in one
 * transcript" problem that encoder exists to remove, and any test asserting on
 * transcript shape would be pinning something production never emits.
 * (`tool-message` is type-only internally, so this pulls no zod into
 * `@juno-ai/bind/testing`.)
 */
export function toolOutcome(id: string, data: unknown = { ok: true }): ToolCallOutcome {
  return { toolMessage: toolResultMessage(id, { success: true, data }) };
}

/** One tool call in a scripted turn. */
export interface ScriptedToolCall {
  /** Defaults to the tool name — unique across the whole script, see
   *  {@link scriptedModel}, which rejects a duplicate rather than letting it
   *  produce a baffling transcript failure ten frames deep in the loop. */
  readonly id: string;
  readonly name: string;
  readonly args: string;
}

/**
 * Declare one tool call. `args` is serialized for you; pass a string to
 * script malformed JSON on purpose (which is a case worth testing — models
 * emit it).
 */
export function toolCall(
  name: string,
  args: unknown = {},
  id: string = name,
): ScriptedToolCall {
  return {
    id,
    name,
    args: typeof args === "string" ? args : JSON.stringify(args),
  };
}

/** Per-turn accounting overrides. Defaults are small non-zero numbers so a
 *  test asserting "usage was recorded" cannot pass on an all-zero fixture. */
export interface TurnCost {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly costCents?: number;
  /**
   * Provider-reported cached input tokens. Omit it to script a transport that
   * cannot report one — the run's total then skips this turn rather than
   * counting a zero, which is the distinction `RunStats.cachedInputTokens`
   * turns on. Pass `null` for the same effect explicitly.
   */
  readonly cachedInputTokens?: number | null;
}

/** One scripted model turn: the message to return, plus its usage. */
export interface ModelResponse extends TurnCost {
  readonly message: OpenAI.ChatCompletionMessage;
}

/** A turn where the model asks for tools, optionally alongside some text. */
export function toolCallTurn(
  calls: readonly ScriptedToolCall[],
  opts: TurnCost & { readonly content?: string } = {},
): ModelResponse {
  return { ...opts, message: assistant(opts.content ?? null, calls) };
}

/**
 * A turn with text and no tool calls — which is how the loop *ends*. A script
 * that omits it runs to `maxIterations` (or exhausts the queue), so this is
 * the difference between testing `stopReason: "done"` and testing
 * `"iteration_limit"`.
 */
export function finalAnswer(content: string, opts: TurnCost = {}): ModelResponse {
  return { ...opts, message: assistant(content) };
}

/**
 * Turn a script into a `callModel` implementation.
 *
 * Exhausting the queue throws rather than looping forever or returning an
 * empty turn: a script that ran out is a test that did not describe what it
 * meant to, and the loop's own `maxIterations` cutoff would otherwise absorb
 * the mistake and report a plausible-looking `iteration_limit`.
 */
export function scriptedModel(
  turns: readonly ModelResponse[],
): NonNullable<ToolLoopParams["callModel"]> {
  const seenIds = new Set<string>();
  for (const turn of turns) {
    for (const tc of turn.message.tool_calls ?? []) {
      if (seenIds.has(tc.id)) {
        throw new Error(
          `scriptedModel: duplicate tool-call id ${JSON.stringify(tc.id)}. ` +
            `Ids must be unique across the whole script — pass an explicit id ` +
            `to toolCall() when the same tool is called more than once.`,
        );
      }
      seenIds.add(tc.id);
    }
  }

  const queue = [...turns];
  return async () => {
    const next = queue.shift();
    if (next === undefined) {
      throw new Error(
        `scriptedModel: the script has ${turns.length} turn(s) and was already ` +
          `exhausted on call ${turns.length + 1}. Add a turn, or end the script ` +
          `with finalAnswer() so the loop stops.`,
      );
    }
    return {
      message: next.message,
      inputTokens: next.inputTokens ?? 10,
      outputTokens: next.outputTokens ?? 5,
      costCents: next.costCents ?? 1,
      // Present-only: an absent key and an explicit `null` both mean "not
      // reported", and the loop treats them identically.
      ...(next.cachedInputTokens === undefined
        ? {}
        : { cachedInputTokens: next.cachedInputTokens }),
    };
  };
}

export interface LoopHarness {
  params: ToolLoopParams;
  state: ToolLoopState;
  /** Ids the loop dispatched, in order. Recorded for you even if you override
   *  `runToolCall`. */
  ran: string[];
  /** Ids whose tool actually reached its side effect. The default
   *  `runToolCall` records one here on completion, so `ran` and `sideEffects`
   *  match until an override makes them diverge — a tool that throws, hangs
   *  past a deadline, or is torn down mid-flight. That divergence is the
   *  question every cancellation test is really asking. */
  sideEffects: string[];
}

/**
 * A loop wired to a scripted model queue. `runToolCall` records dispatch and
 * completion separately, so a test can tell "the loop asked for this call" from
 * "this call's side effect happened" — the distinction every deadline and
 * cancellation question turns on.
 *
 * Everything is overridable: pass `{ runToolCall }` to make a tool fail,
 * `{ signal }` to abort mid-batch, `{ now }` to make timings deterministic.
 */
export function loopHarness(
  responses: readonly ModelResponse[],
  overrides: Partial<ToolLoopParams> = {},
): LoopHarness {
  const state = overrides.state ?? freshState();
  const ran: string[] = [];
  const sideEffects: string[] = [];

  const runTool =
    overrides.runToolCall ??
    (async (tc) => {
      sideEffects.push(tc.id);
      return toolOutcome(tc.id);
    });

  const params: ToolLoopParams = {
    state,
    maxIterations: 10,
    callModel: scriptedModel(responses),
    buildTools: () => [],
    ...overrides,
    // Wrapped AFTER the spread, so `ran` is recorded even when a caller
    // overrides `runToolCall` — which is the documented way to reach the
    // interesting states. Recording dispatch is the whole reason this harness
    // exists, and making it the override's job to remember meant the first
    // test to forget silently lost the distinction it was written to check.
    runToolCall: async (tc) => {
      ran.push(tc.id);
      return await runTool(tc);
    },
  };

  return { params, state, ran, sideEffects };
}

/**
 * A clock that advances a fixed amount on every read. Makes the model-time and
 * tool-time figures in `ToolLoopResult.stats` exactly predictable, which
 * `Date.now` cannot be.
 */
export function steppingClock(stepMs = 1, startMs = 0): () => number {
  let current = startMs;
  return () => {
    const value = current;
    current += stepMs;
    return value;
  };
}

/**
 * Resolve after `ms` of real time. Kept tiny so suites stay fast.
 *
 * Deliberately not cancellable — it is for driving the loop's own micro-timers
 * inside a test, not for long-lived waiting. Reach for your own scheduler if
 * you need a wait that outlives the run, so a torn-down run cannot leave a
 * timer resolving into nothing.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
