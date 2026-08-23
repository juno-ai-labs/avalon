import type { Message } from './types';
import type { StreamCursor } from './workstream-socket-resume';

/**
 * Paced reveal for streamed agent text — see `docs/streaming-reveal.md`.
 *
 * The wire batches model tokens into a frame roughly every 100ms
 * (`createSequencedStreamDeltaBatcher`), so text arrives in ~12-character
 * bursts at ~8Hz while the display paints at 60Hz: measured against the
 * running client, 85% of painted frames revealed nothing and the rest revealed
 * a burst, which reads as text arriving a line at a time. These functions
 * decouple the two clocks: the socket appends everything it receives to
 * `StreamCursor.receivedText`, and an animation-frame loop reveals a prefix of
 * it at a rate that tracks the backlog, so the visible text grows a few
 * characters per painted frame instead of a burst per wire frame.
 */

/**
 * The reveal's smoothing window. Each painted frame reveals
 * `elapsed / STREAM_REVEAL_DRAIN_MS` of the *remaining* backlog, so the
 * backlog decays exponentially — roughly 6% per 60Hz frame, halving about
 * every 190ms — rather than draining linearly in one window: under a steady
 * stream the visible text lags the wire by about one window's worth, and an
 * outsized burst (a 2,048-character frame, a stalled tab catching up) is
 * substantially caught up within half a second and within a few characters
 * inside ~1.5s. Derived from the wire cadence rather than guessed: the
 * work-stream batcher (`createSequencedStreamDeltaBatcher`) coalesces for up
 * to 100ms (`maxDelayMs`) and the measured inter-arrival p95 against the
 * running client was 133ms, so the window must exceed that or the buffer
 * empties between frames and the reveal stalls-then-bursts — the exact
 * cadence this module exists to remove. Twice the measured p95, rounded,
 * keeps the buffer occupied through ordinary jitter while holding the
 * steady-state added latency under a third of a second.
 */
export const STREAM_REVEAL_DRAIN_MS = 270;

/** What one frame's elapsed time is taken to be before there is a previous frame. */
const FIRST_FRAME_MS = 17;

/**
 * How many characters a reveal tick may show, given the backlog and the time
 * since the last tick. Proportional to both, so a large burst (a 2,048-char
 * frame, a stalled tab catching up) drains quickly while a steady stream
 * reveals a near-constant few characters per frame; the floor of one character
 * keeps a trickle moving rather than parking it below the rounding threshold.
 */
export function revealBudget(backlog: number, elapsedMs: number): number {
  if (backlog <= 0) return 0;
  const proportional = Math.ceil((backlog * elapsedMs) / STREAM_REVEAL_DRAIN_MS);
  return Math.min(backlog, Math.max(1, proportional));
}

/**
 * Never leave the reveal boundary between the halves of a surrogate pair. The
 * budget counts UTF-16 code units, and slicing after a high surrogate would
 * paint a replacement glyph for a frame every time an emoji streams in; when
 * the boundary lands mid-pair, the low surrogate rides along in the same
 * tick. Joined sequences (ZWJ emoji, combining marks) can still split across
 * ticks — that renders as valid intermediate characters for a frame, not as
 * corruption, and grapheme segmentation was judged not worth its cost here.
 */
export function alignRevealBoundary(text: string, index: number): number {
  if (index <= 0) return 0;
  if (index >= text.length) return text.length;
  const preceding = text.charCodeAt(index - 1);
  return preceding >= 0xd800 && preceding <= 0xdbff ? index + 1 : index;
}

/**
 * Advance every cursor's revealed length by one tick. Mutates the cursors —
 * they are the socket hook's own non-React state, shared across the foreground
 * and background hook instances for one work stream. That sharing is why the
 * rate integrates over `lastRevealAt` rather than assuming one tick per frame:
 * two loops ticking the same cursor in one frame see near-zero elapsed time on
 * the second tick and reveal nothing extra.
 *
 * `ReadonlyMap` promises only that the map's key set is left alone; the
 * cursor values are deliberately mutable, here and in `flushStreamReveal`.
 */
export function advanceStreamReveal(
  cursors: ReadonlyMap<string, StreamCursor>,
  now: number,
): { changed: boolean; backlogRemains: boolean } {
  let changed = false;
  let backlogRemains = false;
  for (const cursor of cursors.values()) {
    if (cursor.completed) continue;
    const backlog = cursor.receivedText.length - cursor.revealed;
    if (backlog <= 0) {
      cursor.lastRevealAt = null;
      continue;
    }
    const elapsed = cursor.lastRevealAt === null
      ? FIRST_FRAME_MS
      : Math.max(0, now - cursor.lastRevealAt);
    const budget = revealBudget(backlog, elapsed);
    if (budget > 0) {
      cursor.revealed = alignRevealBoundary(cursor.receivedText, cursor.revealed + budget);
      cursor.lastRevealAt = now;
      changed = true;
    }
    if (cursor.receivedText.length > cursor.revealed) backlogRemains = true;
  }
  return { changed, backlogRemains };
}

/** Reveal everything at once — the document went hidden, so nobody is watching the animation. */
export function flushStreamReveal(cursors: ReadonlyMap<string, StreamCursor>): boolean {
  let changed = false;
  for (const cursor of cursors.values()) {
    if (cursor.completed) continue;
    if (cursor.revealed < cursor.receivedText.length) {
      cursor.revealed = cursor.receivedText.length;
      cursor.lastRevealAt = null;
      changed = true;
    }
  }
  return changed;
}

/**
 * Write each streaming message's revealed prefix into the transcript. Returns
 * the input array untouched when no visible text changed, so the cache write
 * is a no-op and nothing re-renders.
 */
export function applyRevealedText(
  messages: Message[] | undefined,
  cursors: ReadonlyMap<string, StreamCursor>,
): Message[] {
  if (!messages || messages.length === 0) return messages ?? [];
  let mutated = false;
  const next = messages.map((message) => {
    if (message.streaming !== true) return message;
    const cursor = cursors.get(message.id);
    if (!cursor || cursor.completed) return message;
    const text = cursor.receivedText.slice(0, cursor.revealed);
    if ((message.text ?? '') === text) return message;
    mutated = true;
    return { ...message, text };
  });
  return mutated ? next : messages;
}
