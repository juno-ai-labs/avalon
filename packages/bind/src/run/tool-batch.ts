import type OpenAI from "openai";

// Per-tool concurrency ceiling inside a single LLM tool-call batch. A model
// response can request many calls to the same tool; running them all at once
// would hammer whatever it talks to (a search backend, a database, a
// third-party API). Calls to *different* tools still fan out fully — the cap
// is applied per tool name, not globally.
const PER_TOOL_POOL_SIZE = 5;

/**
 * The name a batch pools on. `function` and `custom` tool calls both carry a
 * name, on different fields; anything the wire union grows later falls back to
 * its type, which pools all such calls together rather than guessing.
 */
function poolKey(call: OpenAI.ChatCompletionMessageToolCall): string {
  switch (call.type) {
    case "function":
      return call.function.name;
    case "custom":
      return `__custom__:${call.custom.name}`;
    default: {
      // Not `never`: this union is a third party's, and a new member must not
      // become a type error in a consumer that never sees one.
      const unknownCall: { type?: string } = call;
      return `__${unknownCall.type ?? "unknown"}__`;
    }
  }
}

/**
 * Run a batch of tool calls concurrently with per-tool-name pooling. Calls
 * to different tools fan out fully; calls to the *same* tool are capped at
 * `PER_TOOL_POOL_SIZE` so a batch of many calls to one downstream service does
 * not overwhelm it. Results are
 * returned in the same order as `calls`, each as a `PromiseSettledResult`
 * so the caller can synthesize error tool messages for any rejections
 * (every `tool_call_id` in the assistant message still needs a response).
 *
 * Generic over the per-call outcome: the pooling and ordering policy is
 * harness-owned, while the shape a host derives from a completed call (which
 * plugin activated, whether the run should compact, a suspend directive, …)
 * stays with the host.
 *
 * **`signal` bounds the batch, and bounding it is the point.** A batch of many
 * calls to one tool runs five at a time, so the rest sit queued — and without a
 * signal the pool claims every one of them however long ago the run's deadline
 * fired or the user pressed stop. Each queued call is a side effect nobody
 * wants any more: a write, an email, a third-party POST. Once the signal
 * aborts, workers stop claiming new work.
 *
 * Calls that never ran still come back — as `rejected` with an
 * {@link AbortedToolCallError} — because every `tool_call_id` in the assistant
 * message needs a response either way, and a caller that received a shorter
 * array than it passed would silently mispair the rest. A call already in
 * flight is left alone: this cannot reach inside a host's tool, and cancelling
 * one mid-write is the host's problem to solve with the same signal.
 */
/**
 * The message a refused call carries into the transcript, and therefore **into
 * the model's next turn**. Shared by both refusal sites — the pool and the
 * loop's serial phase — because to the only reader they are the same fact, and
 * two literals for one fact drift.
 *
 * Three things it deliberately does *not* do. It does not name the batch, the
 * worker, or the claim: those are this module's internals, the model cannot act
 * on them, and they appear nowhere else in its context. It does not interpolate
 * the call id, which the `tool` message's own `tool_call_id` already carries —
 * restating it spends the sentence's most-attended position on something the
 * reader has. And it does not lead with the cause: the actionable fact is that
 * *nothing happened*, and a model skimming a batch of results reads the first
 * clause.
 */
export const ABORTED_TOOL_CALL_MESSAGE =
  "This call was never started, so nothing happened and nothing changed. " +
  "The run is ending — do not retry it and do not report it as a failure.";

/**
 * A call the batch refused because it was aborted before any worker claimed it.
 *
 * Carries the id as a **field** rather than in the message, so a host's
 * rejection observer and operator log can filter on it (`CLAUDE.md`: identifying
 * context is a field, not string interpolation).
 */
export class AbortedToolCallError extends Error {
  override readonly name = "AbortedToolCallError";
  constructor(readonly toolCallId: string) {
    super(ABORTED_TOOL_CALL_MESSAGE);
  }
}

export interface ToolBatchOptions {
  /**
   * Stop claiming queued calls once this aborts. Combine a run deadline with a
   * cancellation signal (`AbortSignal.any`) before passing it — the pool does
   * not care which one fired, only that no further work should start.
   */
  readonly signal?: AbortSignal | undefined;
}

export async function runToolCallsPooledByTool<TOutcome>(
  calls: OpenAI.ChatCompletionMessageToolCall[],
  run: (tc: OpenAI.ChatCompletionMessageToolCall) => Promise<TOutcome>,
  options: ToolBatchOptions = {},
): Promise<PromiseSettledResult<TOutcome>[]> {
  if (calls.length === 0) return [];
  const signal = options.signal;
  const results: PromiseSettledResult<TOutcome>[] = new Array(calls.length);

  const groups = new Map<string, number[]>();
  for (let i = 0; i < calls.length; i++) {
    const tc = calls[i]!;
    // Pool key is the tool name, wherever the wire union puts it — `custom`
    // tool calls carry theirs on a different field, and pooling every one of
    // them together would serialize unrelated tools behind each other. A future
    // variant with no name at all falls back to its type; the `__` fencing
    // keeps either synthetic key from colliding with a real tool name.
    const key = poolKey(tc);
    let arr = groups.get(key);
    if (!arr) {
      arr = [];
      groups.set(key, arr);
    }
    arr.push(i);
  }

  await Promise.all(
    Array.from(groups.values()).map(async (indices) => {
      // `cursor++` in single-threaded JS is atomic between awaits — no lock
      // needed. Workers race for the next index; when cursor exceeds the
      // group size the worker returns.
      let cursor = 0;
      const workerCount = Math.min(PER_TOOL_POOL_SIZE, indices.length);
      await Promise.all(
        Array.from({ length: workerCount }, async () => {
          while (true) {
            const pos = cursor++;
            if (pos >= indices.length) return;
            // Each group contains in-bounds indexes from the original batch.
            const callIdx = indices[pos]!;
            // Checked at claim time rather than before the loop: a batch that
            // was fine when it started can be aborted while its first workers
            // are in flight, and that is the ordinary case — the deadline fires
            // or the user hits stop DURING the batch, not before it.
            if (signal?.aborted === true) {
              results[callIdx] = {
                status: "rejected",
                reason: new AbortedToolCallError(calls[callIdx]!.id),
              };
              continue;
            }
            try {
              const value = await run(calls[callIdx]!);
              results[callIdx] = { status: "fulfilled", value };
            } catch (reason) {
              results[callIdx] = { status: "rejected", reason };
            }
          }
        }),
      );
    }),
  );

  return results;
}
