/**
 * Streaming a turn's assistant text to a live surface, safely across retries.
 *
 * Forwarding deltas is one line in a host's transport. What is not one line —
 * and what every host that streams has to get right independently — is what
 * happens when the attempt that produced those deltas *fails*. The routing
 * executor's answer to a failure is to try again: same endpoint, then the next
 * provider, then the fallback model. Each of those re-renders a turn the user is
 * already reading.
 *
 * Until now the package's only answer was to refuse: a transport that had
 * streamed set `producedOutput` on its failure outcome and the executor clamped
 * to propagate-only (`propagateOnly`). That trades a recoverable failure for a
 * visible one — a 500 on the first provider becomes an error the user sees,
 * purely because the first token had left.
 *
 * There is a better answer whenever the surface can be *retracted*: tell it to
 * discard what it has, then stream the retry cleanly. That is this module. It
 * turns `producedOutput` from "did we emit" into what its own contract already
 * said — **"did we emit somewhere the caller cannot take it back"** — and lets a
 * retractable surface keep the whole fallback chain.
 *
 * ## Lifetime: one stream per turn, and you must call `finish()`
 *
 * Construct it in the function that owns the turn — outside the executor and
 * outside any structured-output retry loop — and call {@link
 * TurnTextStream.finish} when the turn is over, whichever way it ended.
 *
 * Both halves are load-bearing and neither is enforceable from in here. A stream
 * built *inside* the `AttemptFn` never sees a second attempt, so it never resets
 * and `producedOutput` is never true; the single-attempt path — almost all
 * traffic — looks identical to a correct one, and the bug appears only under
 * fallback, as two partial answers glued together. Skipping `finish()` leaves an
 * armed reset undelivered whenever the attempt that *succeeds* emits no text,
 * which is the ordinary shape of a tool-calling turn (`content: null` plus
 * `tool_calls`): the discarded attempt's narration then stays on screen as if it
 * belonged to the turn that replaced it.
 *
 * ## What the host still owns
 *
 * The sink, and the judgement of what goes into it. In particular **reasoning
 * deltas are not decided here**: whether a model's thinking counts as output the
 * user has seen is a product call, and the host expresses it by choosing what it
 * passes to {@link TurnTextStream.observe}.
 *
 * **Tool-call deltas are deliberately not output.** It is tempting to latch on
 * the first byte of any kind, and a host streaming raw chunks may already do
 * that. But a tool call is not a side effect until it is *dispatched*, which
 * happens after the turn completes — so a turn that dies mid-stream having
 * emitted only tool-call bytes has changed nothing the user or a third party can
 * see, and refusing to retry it forfeits a fallback for free. A host with a
 * genuine mid-attempt effect of its own says so with
 * {@link TurnTextStream.markProducedOutput} rather than by widening what counts
 * as text.
 *
 * **`onAssistantMessage` on the turn kernel is a different surface.** It fires
 * once per completed assistant message; these events stream one attempt of one
 * message. Wiring both to the same UI element delivers the same text twice. The
 * division that works: deltas drive the live view, `onAssistantMessage` drives
 * the permanent record (the transcript row, the notification, the third-party
 * post). If they must share one element, treat the persisted message as
 * authoritative and let it supersede the streamed epochs for its `turnId`.
 *
 * ## The race this exists to make survivable
 *
 * On any real transport — a WebSocket through a Durable Object, an SSE relay, a
 * fan-out to several tabs — an in-flight delta from attempt 1 can be *delivered
 * after* attempt 2's reset. A client that renders every text event it receives
 * will then show the wiped attempt's tail glued onto the retry. Every event
 * therefore carries a `turnId`, an `epoch` (which attempt produced it) and a
 * `seq` (monotonic within the turn), and a correct client uses all three:
 *
 *  - scope everything to `turnId` — `epoch` and `seq` both restart each turn, so
 *    a client that carried "newest epoch" across turns drops every event after
 *    the first turn that retried, and a later turn's reset tells it to wipe an
 *    earlier, committed message;
 *  - **apply events in `seq` order**: drop anything at or below the last `seq`
 *    applied, and hold anything that arrives ahead of it until the gap fills;
 *  - then drop any event whose `epoch` is older than the newest seen, and clear
 *    what is rendered on a `reset`.
 *
 * The `seq` step is not optional decoration on the `epoch` step — it is what
 * makes the epoch step *sound*. Ordering by epoch alone loses a same-epoch
 * reorder: a retry's text arriving before its own reset is accepted and then
 * cleared by the reset that follows, leaving the surface blank. A transport that
 * already guarantees ordered exactly-once delivery collapses the `seq` step to a
 * no-op, but that is a property to assert deliberately rather than assume.
 *
 * ## Why the reset is lazy
 *
 * It fires on the retry's **first byte**, not when the previous attempt failed.
 * A retry that dies before producing anything — no viable endpoint, an immediate
 * 401 — would otherwise have wiped the screen to show nothing. Partial text plus
 * an error is strictly more useful to a reader than a blank space plus an error.
 * A turn where no attempt ever emits therefore emits no events at all.
 *
 * The one thing that must not be lazy is a reset still armed when the turn ends
 * — hence `finish()`, which flushes it. By then the text it retracts is known to
 * have come from an attempt that was thrown away.
 */

/** Why the surface is being told to discard what it has rendered. */
export type TurnResetReason =
  /** The previous attempt failed and routing moved on (retry, provider, model). */
  | "attempt_failed"
  /** The previous attempt succeeded but its output was rejected and re-asked. */
  | "structured_output_retry";

/**
 * One event bound for the user's surface.
 *
 * `turnId` is the host's identifier for the turn and scopes everything else:
 * `seq` is monotonic within it and never restarts, so it doubles as an ordering
 * and de-duplication key on a transport that can do neither, and `epoch`
 * identifies the attempt and only ever increases. Both restart on the next turn,
 * which is why the `turnId` is on the wire.
 */
export type TurnStreamEvent =
  | Readonly<{
      kind: "text";
      turnId: string;
      epoch: number;
      seq: number;
      text: string;
    }>
  | Readonly<{
      kind: "reset";
      turnId: string;
      epoch: number;
      seq: number;
      reason: TurnResetReason;
    }>;

/**
 * Where a turn's text goes.
 *
 * `retractable` is the whole decision. It is a property of the *surface*, not of
 * the transport that writes to it: a view that re-renders from the events it is
 * sent is retractable; a chat message already posted through a third-party API,
 * an email, a webhook delivery, and an append-only transcript row are not.
 *
 * **Wire only retractable surfaces here.** A host that must also deliver
 * somewhere permanent should do that from the *completed* turn rather than from
 * the deltas — that composes correctly, whereas declaring a permanent surface
 * retractable silently re-enables the duplication this module exists to prevent.
 * If one sink genuinely fans out to a mix, declare it `false`; the conservative
 * answer costs a fallback, the optimistic one costs the user's trust.
 *
 * **`retractable` is read once, when the stream is created**, and a `readonly`
 * field is no barrier to a getter. Re-reading it would make `producedOutput`
 * non-monotonic: a sink that flipped after the first byte could un-clamp routing
 * *after* the executor had already been told the turn was replayable, and the
 * permanent surface would then get the turn twice.
 *
 * A sink that **buffers** — coalescing deltas over a byte or time window before
 * releasing them — is free to drop a `reset` whose epoch never left that buffer,
 * along with the text it would have wiped. Nothing was rendered, so nothing
 * needs retracting, and the client is spared a no-op flicker. This module cannot
 * do that for the sink because only the sink knows what it has released.
 */
export interface TurnStreamSink {
  readonly retractable: boolean;
  /**
   * Deliver one event. May throw — a closed socket is ordinary, not
   * exceptional. See {@link TurnTextStream.sinkErrors} for what a throw means.
   */
  emit(event: TurnStreamEvent): void;
}

export interface TurnTextStreamOptions {
  readonly sink: TurnStreamSink;
  /**
   * Identifies the turn on the wire. Any value the client can compare for
   * equality and that is unique among the turns it may see concurrently — a
   * message id, a run id plus a turn ordinal. Required rather than defaulted
   * because a client cannot scope `epoch` and `seq` without it, and every
   * plausible default would be wrong for someone.
   *
   * **It is a correlation label, never an authorization boundary.** The client
   * rule says "scope everything to `turnId`", which is about *ordering*, not
   * about deciding whether an event is yours to render. The sink must already be
   * scoped to the intended recipient before anything is emitted — a client that
   * treats a matching `turnId` as evidence an event belongs to it will render
   * whatever arrives on a shared topic, including a `reset` that wipes a
   * committed message.
   */
  readonly turnId: string;
  /**
   * Cap on how many times the surface may be wiped in one turn. Reaching it
   * does not throw and does not stop emission: it makes
   * {@link TurnTextStream.producedOutput} true, so the *next* failure clamps
   * routing and the traversal stops. Emission continues so that an attempt
   * already in flight still reaches the user.
   *
   * There is **no default cap** — a plan with three stages, three candidates and
   * two defect retries can legally wipe the screen more than twenty times, and
   * that is worth bounding, but the tolerable number is a product judgement
   * about flicker that this module cannot make for a host. Guessing one would
   * break a host for whom a rare double-wipe is entirely fine.
   *
   * Because the value gates routing, it also shapes how many endpoints record a
   * failure against the circuit breaker for one user turn. That is a real
   * coupling between a UI judgement and shared telemetry; it is the price of
   * letting the UI decide.
   */
  readonly maxResets?: number | undefined;
}

export interface TurnTextStream {
  /**
   * Open a new attempt. Call this at the **top of every attempt**, including the
   * first — that is once per `AttemptFn` invocation, which covers same-endpoint
   * defect retries, provider traversal and model fallback in one place, plus
   * once per structured-output retry, which happens outside the executor and is
   * the caller's loop to instrument.
   *
   * On any attempt following one that produced text, this arms a reset; the
   * reset itself is emitted lazily, when that attempt first produces text (or by
   * {@link finish}, if it never does).
   *
   * An explicitly passed `reason` **sticks** until the reset is delivered, and a
   * later call that omits one will not overwrite it. Without that, the
   * structured-output arm of {@link TurnResetReason} would be unreachable in the
   * composition this module prescribes: the caller's retry loop opens the
   * attempt with a reason, then re-enters the executor, whose `AttemptFn` opens
   * the same pending reset again with the default.
   */
  beginAttempt(reason?: TurnResetReason): void;
  /**
   * Forward one content delta. `null`, `undefined` and `""` are no-ops and do
   * not count as output — a provider sending an empty content field has shown
   * the user nothing.
   */
  observe(text: string | null | undefined): void;
  /**
   * End the turn. **Call it however the turn ended**, including on the success
   * path and on a throw — and tell it which, because the two do opposite things
   * with a reset that is still armed.
   *
   * - `"succeeded"` **flushes** it. An attempt streamed text and failed, the
   *   retry succeeded with tool calls and no text at all, so nothing triggered
   *   the lazy reset. Without the flush the failed attempt's narration stays on
   *   the surface attributed to a turn that never said it, and vanishes only on
   *   reload. `content: null` plus `tool_calls` is the ordinary shape of an
   *   agent turn, so this is the common case rather than an edge.
   * - `"failed"` **drops** it. Every attempt failed, and the last one died
   *   before producing a byte. Flushing here would wipe the screen to show
   *   nothing — the reader would get a blank space plus an error where they
   *   could have had partial text plus an error, which is the same trade the
   *   lazy reset exists to make and must not be undone at the finish line.
   *
   * Idempotent. Afterwards every method is a no-op.
   */
  finish(outcome: "succeeded" | "failed"): void;
  /**
   * Latch {@link producedOutput} for a reason this module cannot see — a
   * provider-side effect, a write a replay would repeat, a second surface the
   * host wrote to itself. Irreversible, and a no-op after {@link finish}: the
   * flag exists for the executor to read on a failure outcome, and once the turn
   * is over there is no outcome left to clamp.
   *
   * It does **not** stop emission. If the attempt that reported the effect goes
   * on to succeed, its text is still the user's answer and must reach them; if
   * it fails, the clamp has already told the executor to stop, so there is no
   * later attempt to suppress.
   *
   * This is the seam for a host migrating off a hand-rolled "any byte arrived"
   * flag. Keep the flag for the effects it genuinely tracks and call this;
   * do not widen {@link observe}.
   */
  markProducedOutput(): void;
  /**
   * Whether output has reached a surface the caller **cannot take back**, which
   * is exactly the flag the routing executor clamps on. Put it straight onto the
   * failure outcome:
   *
   * ```ts
   * return { kind: "failure", error, producedOutput: stream.producedOutput };
   * ```
   *
   * For a retractable sink this stays `false` while a wipe is still available,
   * so routing keeps its whole fallback chain. It latches `true` when the reset
   * budget is spent, when a reset failed to reach the sink, or when the host
   * reports an out-of-band effect. Monotonic: never true then false.
   *
   * **It answers "may routing replay this turn", not "is the reader looking at
   * output".** The executor only reads it on a failure outcome, so the two
   * questions never diverge where it is consumed — but they do diverge off-label:
   * a turn that spent its flicker budget and then *succeeded* reads `true` even
   * though the text it emitted was retracted. Do not source a "did the user see
   * anything" metric from this.
   */
  readonly producedOutput: boolean;
  /** The current attempt's epoch. `-1` before the first {@link beginAttempt}. */
  readonly epoch: number;
  /**
   * Resets *handed to the sink* so far. A reset whose `emit` threw is counted —
   * it consumed the flicker budget, and whether the client saw it is exactly
   * what this module cannot know. See {@link sinkErrors}.
   */
  readonly resetCount: number;
  /**
   * Events whose `emit` threw. Emission continues after a throw rather than
   * tearing down — a momentarily closed socket should not end a model turn that
   * is otherwise fine.
   *
   * Two consequences. On a **non-retractable** surface a throw still counts as
   * output: the sink got far enough to fail, and whether the bytes left first is
   * not knowable from here, so the conservative reading is that they did. On a
   * **retractable** one a failed *text* event leaves the turn replayable, but a
   * failed *reset* does not — the wipe instruction is the one event whose loss
   * cannot be repaired by sending more, so it latches
   * {@link producedOutput} rather than letting a second epoch stack onto a
   * surface that never cleared the first.
   */
  readonly sinkErrors: number;
}

export function createTurnTextStream(
  options: TurnTextStreamOptions,
): TurnTextStream {
  const { sink, turnId } = options;
  const maxResets = options.maxResets;
  if (
    maxResets !== undefined &&
    (!Number.isInteger(maxResets) || maxResets < 0)
  ) {
    // `NaN` compares false against everything, so an unvalidated non-finite cap
    // reads as "unbounded" — the exact opposite of the safe failure, on the one
    // option whose whole purpose is to bound something.
    throw new TypeError(
      `createTurnTextStream: maxResets must be a non-negative integer, got ${String(maxResets)}`,
    );
  }
  if (typeof turnId !== "string" || turnId === "") {
    // Every plausible way to get here — `turnId: obj?.id ?? ""` — collapses
    // every turn of a run into one scope on the client, which is the bug the
    // field was added to prevent.
    throw new TypeError(
      `createTurnTextStream: turnId must be a non-empty string, got ${JSON.stringify(turnId)}`,
    );
  }
  // Snapshotted, never re-read — see `TurnStreamSink.retractable`.
  const retractable = sink.retractable;

  let epoch = -1;
  let seq = 0;
  let resetCount = 0;
  let sinkErrors = 0;
  let finished = false;
  // Text has reached the sink at least once this turn. Distinct from
  // `producedOutput`, which additionally asks whether it can be taken back.
  let emitted = false;
  // Held rather than sent immediately so an attempt that dies before producing
  // anything leaves the previous text on screen.
  let resetPending: TurnResetReason | null = null;
  // The surface is showing an epoch it will never be told to clear — either a
  // reset was refused, or the flicker budget ran out before one could be armed.
  // Both mean the same thing and must behave the same way: stop writing to it.
  // They did not, and the asymmetry spliced two answers together — the budget
  // path armed no reset and then happily appended the next attempt's text on top
  // of the abandoned one.
  let staleSurface = false;
  // Whether a reset was EVER lost. Separate from `staleSurface` because that one
  // clears when a later reset lands, and `producedOutput` must not un-latch.
  let everLostReset = false;
  let externalEffect = false;

  const budgetSpent = (): boolean =>
    maxResets !== undefined && resetCount >= maxResets;

  const deliver = (event: TurnStreamEvent): boolean => {
    try {
      // Frozen because the type says `Readonly` and a sink that fans out to two
      // consumers would otherwise let the first mutate what the second sees.
      sink.emit(Object.freeze(event));
      return true;
    } catch {
      sinkErrors += 1;
      return false;
    }
  };

  const flushReset = (): void => {
    const reason = resetPending;
    if (reason === null) return;
    resetPending = null;
    resetCount += 1;
    const stamp = epoch;
    if (deliver({ kind: "reset", turnId, epoch: stamp, seq: seq++, reason })) {
      // The wipe landed, so whatever was stranded on the surface is gone and it
      // is safe to write again.
      staleSurface = false;
    } else {
      staleSurface = true;
      everLostReset = true;
    }
  };

  return {
    beginAttempt(reason) {
      if (finished) return;
      // The epoch advances on every attempt, whether or not a reset is owed:
      // it identifies the attempt, and a host correlating logs on it should not
      // see it stall because an earlier attempt happened to stay silent.
      epoch += 1;
      // Nothing on screen yet, so nothing to retract.
      if (!emitted) return;
      // A permanent surface cannot honour a retraction, and telling it to is
      // worse than not: a defensive sink reads it as a protocol error and a
      // naive one may delete a message it already posted. Its `producedOutput`
      // latched on the first byte, so routing has already stopped.
      if (!retractable) return;
      // No wipe left, so this attempt's text would land on top of the last one
      // rather than replacing it. The executor has already been told to stop
      // (`producedOutput` is true), so anything still driving attempts is a
      // caller-owned loop — a structured-output retry — and appending its output
      // to an abandoned answer is the splice this module exists to prevent.
      if (budgetSpent()) {
        staleSurface = true;
        return;
      }
      // An explicit reason outranks a later default — see `beginAttempt`. Spelt
      // out rather than as a `??` chain: the chain reads as "reason wins" and
      // hides that the middle term is what preserves an EARLIER explicit reason
      // through a later defaulted call, which is the whole point.
      if (reason !== undefined) {
        resetPending = reason;
      } else {
        resetPending ??= "attempt_failed";
      }
    },

    observe(text) {
      if (finished) return;
      // Checked before the empty-text short-circuit: this guard catches a host
      // that never opened an attempt, and a host whose first chunk happens to be
      // empty must not ship green and then produce indistinguishable retries.
      if (epoch < 0) {
        throw new Error(
          "createTurnTextStream: observe() before beginAttempt() — every attempt must open one, or a retry cannot be told apart from the turn it replaces",
        );
      }
      if (text === null || text === undefined || text === "") return;
      // Checked BEFORE the flush, not after: once the surface is stranded,
      // sending it more — including another reset — only compounds the problem.
      // A reset delivered now would clear text the reader is relying on and then
      // be followed by nothing, leaving them with a blank message on a turn that
      // may well succeed. One coherent (if stale) answer beats both a spliced
      // one and an empty one; `sinkErrors` is the host's cue to force a resync.
      if (staleSurface) return;
      flushReset();
      // Re-checked: the flush above may have just failed, in which case the
      // surface still shows the epoch it was told to clear and this attempt's
      // text would be glued onto it.
      if (staleSurface) return;
      emitted = true;
      // Stamped before `deliver`, so a re-entrant sink that opens another
      // attempt from inside `emit` cannot back-date this delta to a newer one.
      const stamp = epoch;
      deliver({ kind: "text", turnId, epoch: stamp, seq: seq++, text });
    },

    finish(outcome) {
      if (finished) return;
      finished = true;
      // A pending reset means an earlier attempt's text is still on screen. On
      // success it has been superseded and must go; on failure it is the best
      // thing the reader has, and wiping it is strictly worse than leaving it.
      if (outcome === "succeeded") flushReset();
      else resetPending = null;
    },

    markProducedOutput() {
      if (finished) return;
      externalEffect = true;
    },

    get producedOutput() {
      if (externalEffect) return true;
      if (!emitted) return false;
      return !retractable || everLostReset || budgetSpent();
    },

    get epoch() {
      return epoch;
    },

    get resetCount() {
      return resetCount;
    },

    get sinkErrors() {
      return sinkErrors;
    },
  };
}
