/**
 * Assembling streamed tool calls out of the deltas a provider sends.
 *
 * `detectCompletionDefect` and `parseToolCallArguments` both consume a
 * *finished* tool call, which quietly assumes something turned chunks into one.
 * That something is this module. Until now every host wrote it, and the loop
 * looks trivial enough that it usually gets written from memory — which is the
 * problem, because four of its details are wrong in the obvious version and all
 * four fail silently:
 *
 *  1. **Key by `index`, not by arrival order.** Deltas for index 1 can arrive
 *     before index 0. Pushing onto an array in arrival order transposes the
 *     calls, and both still parse, so nothing errors — the model just gets the
 *     wrong tool's arguments.
 *  2. **`id` can arrive in any chunk**, not necessarily the first for its
 *     index. Reading it only when the slot is created leaves the call with an
 *     empty id, and the `tool` message that answers it then pairs with nothing.
 *  3. **`name` is concatenated, not assigned.** Providers split it across
 *     chunks. Assigning keeps only the last fragment (`_file` from
 *     `read_file`), which surfaces as an unknown-tool error naming a tool the
 *     model never asked for.
 *  4. **Order the result by index at the end.** `Map` iterates in insertion
 *     order, which is arrival order, which is (1) again at the finish line.
 *
 * A fifth is this module's own to avoid: **a missing `index` is not a malformed
 * one.** A provider that omits the field is describing a single call; one that
 * sends `-1` or `"0"` is unintelligible. Dropping both loses a call the model
 * asked for, and loses it silently, because the batch still comes back
 * non-empty and defect detection sees nothing wrong.
 *
 * **The accumulator is unbounded by design and the host must bound the stream.**
 * There is no cap on distinct indices or on accumulated argument bytes — a
 * provider streaming either without limit will grow this `Map` until the
 * process dies. That is the host's to prevent, with an inter-chunk watchdog
 * (`createStreamWatchdog`), a completion-token cap, or a byte budget; a
 * primitive that guessed a limit would break a legitimate large batch.
 *
 * Everything here is pure and structural. The host owns the transport — SSE
 * framing, byte decoding, `[DONE]` — and passes the per-chunk delta arrays in.
 */

/**
 * One provider's tool-call delta. Structural rather than tied to an SDK: the
 * fields are those the OpenAI streaming protocol defines, and every field but
 * `index` is optional because a chunk may carry any subset of them.
 */
export interface ToolCallDelta {
  /**
   * The call's position in the batch. Optional because a provider describing a
   * single call may omit it — those fold into one slot rather than being
   * dropped. A *present* but non-integer or negative value is malformed and is
   * counted in {@link ToolCallAccumulator.droppedDeltas}.
   */
  readonly index?: number | undefined;
  readonly id?: string | undefined;
  /**
   * Carried for structural compatibility and deliberately **not** read:
   * `assembled()` always emits `"function"`. Every streamed tool call in the
   * OpenAI protocol is a function call, and a non-function type
   * (`type: "custom"`) does not arrive as a delta stream — `defects.ts` and
   * `parseToolCallArguments` handle that shape on the assembled message. If a
   * provider ever streams one, this is the line to revisit.
   */
  readonly type?: string | undefined;
  readonly function?:
    | {
        readonly name?: string | undefined;
        readonly arguments?: string | undefined;
      }
    | undefined;
}

/** A tool call assembled from its deltas, ready to dispatch or inspect. */
export interface AssembledToolCall {
  readonly id: string;
  readonly type: "function";
  readonly function: { readonly name: string; readonly arguments: string };
}

/**
 * Accumulates tool-call deltas across the chunks of one completion.
 *
 * Stateful because a stream is: the host calls {@link observe} per chunk and
 * {@link assembled} once at the end. One accumulator per completion — reusing
 * one across two calls merges them.
 */
export interface ToolCallAccumulator {
  /** Fold one chunk's deltas in. Safe to call with an empty array. */
  observe(deltas: readonly ToolCallDelta[] | undefined): void;
  /** Whether any delta has been seen — cheaper than assembling to find out. */
  readonly isEmpty: boolean;
  /**
   * Deltas discarded because their `index` was present but unusable — not an
   * integer, or negative. Non-zero means the model asked for a call that is
   * **not** in {@link assembled}, and nothing downstream can tell: the batch
   * comes back non-empty, so defect detection sees no defect and no retry
   * fires. Log it at minimum; a host that would rather fail the turn than
   * answer a partial batch has to decide that here.
   *
   * A delta with **no** `index` is not counted — that is a provider describing
   * a single call, and it is assembled rather than dropped.
   */
  readonly droppedDeltas: number;
  /**
   * The calls so far, ordered by the provider's `index`. Returns a fresh array
   * each call and does not end accumulation, so it is safe to inspect mid-stream.
   */
  assembled(): AssembledToolCall[];
}

interface MutableCall {
  id: string;
  name: string;
  args: string;
}

export function createToolCallAccumulator(): ToolCallAccumulator {
  const byIndex = new Map<number, MutableCall>();

  // Deltas carrying no `index` at all fold together here, in their OWN
  // variable rather than a reserved key in `byIndex`. A sentinel index would
  // share a keyspace with real ones — `Number.MAX_SAFE_INTEGER` is a legal
  // index — and an explicit delta at that index would merge with the implicit
  // call, concatenating two tools' names into one. That is footgun 3 of this
  // module's own header, re-created by the fix for footgun 5.
  //
  // A missing index is distinct from a MALFORMED one and they must not be
  // treated alike: a provider that omits the field is describing a single call
  // and is intelligible, while one that sends `-1` or `"0"` is not.
  let implicit: MutableCall | null = null;
  let dropped = 0;

  const upsert = (existing: MutableCall | null | undefined): MutableCall =>
    existing ?? { id: "", name: "", args: "" };

  const fold = (call: MutableCall, delta: ToolCallDelta): void => {
    // Read `id` on EVERY delta, not just the first: providers are free to send
    // it late, and a call assembled without one cannot be answered.
    if (typeof delta.id === "string" && delta.id !== "") call.id = delta.id;
    // Both are concatenated. `arguments` is obviously chunked; `name` is less
    // obviously so, and assigning it keeps only the final fragment.
    if (delta.function?.name) call.name += delta.function.name;
    if (delta.function?.arguments) call.args += delta.function.arguments;
  };

  return {
    observe(deltas) {
      // `== null` rather than `=== undefined`: a transport that sets the field
      // to `null` would otherwise reach `for...of` and throw.
      if (deltas == null) return;
      for (const delta of deltas) {
        const index = delta.index;
        if (index === undefined || index === null) {
          implicit = upsert(implicit);
          fold(implicit, delta);
          continue;
        }
        // A malformed index cannot be placed. Dropping loses that call;
        // guessing a slot corrupts a different one, which is worse — a lost
        // call reads as missing, a misfiled one reads as valid. The drop is
        // counted rather than silent, because the host is the only layer that
        // can decide whether a lost call is worth failing the turn over.
        if (!Number.isInteger(index) || index < 0) {
          dropped += 1;
          continue;
        }
        const call = upsert(byIndex.get(index));
        byIndex.set(index, call);
        fold(call, delta);
      }
    },

    get isEmpty() {
      return byIndex.size === 0 && implicit === null;
    },

    get droppedDeltas() {
      return dropped;
    },

    assembled() {
      const ordered = [...byIndex.entries()]
        .sort(([left], [right]) => left - right)
        .map(([, call]) => call);
      // The implicit call sorts last: it has no index to place it by, and a
      // provider that mixes indexed and index-less deltas has told us nothing
      // about where it belongs.
      if (implicit !== null) ordered.push(implicit);
      return ordered.map((call) => ({
        id: call.id,
        type: "function" as const,
        function: { name: call.name, arguments: call.args },
      }));
    },
  };
}
