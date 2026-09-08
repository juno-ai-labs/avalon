import type { Message } from './types';
import type { StreamCursor } from './workstream-socket-resume';

/** The wire's 100ms batch interval seeds cadence and sets the estimator's weighting timescale. */
export const STREAM_REVEAL_CADENCE_MS = 100;
const FIRST_FRAME_MS = 17;

/**
 * Update only for accepted, nonempty text deltas, never replayed frames.
 * `characters` and `backlog` count UTF-16 code units, matching string slicing.
 */
export function recordStreamArrival(
  previous: StreamCursor['pacing'],
  characters: number,
  backlog: number,
  now: number,
): NonNullable<StreamCursor['pacing']> {
  // A drained buffer has no active arrival clock. Retain its cadence rather
  // than teaching the estimator how long the provider was idle. Packet size
  // still updates the rate, so a resumed fast stream can accelerate immediately.
  const elapsed = previous?.lastArrivalAt != null
    ? Math.max(0, now - previous.lastArrivalAt)
    : previous?.cadenceMs ?? STREAM_REVEAL_CADENCE_MS;
  // Weight by elapsed time so co-delivered packets cannot manufacture a huge
  // rate. Accumulate their characters until there is a measurable interval.
  const pending = (previous?.pendingCharacters ?? 0) + characters;
  if (previous && elapsed === 0) {
    return {
      ...previous,
      pendingCharacters: pending,
      drawRate: Math.max(previous.drawRate, backlog / previous.cadenceMs),
    };
  }
  const weight = elapsed / (STREAM_REVEAL_CADENCE_MS + elapsed);
  const cadenceMs = previous
    ? previous.cadenceMs + weight * (elapsed - previous.cadenceMs)
    : STREAM_REVEAL_CADENCE_MS;
  const measuredRate = pending / elapsed;
  const rate = previous
    ? previous.rate + weight * (measuredRate - previous.rate)
    : measuredRate;
  return {
    lastArrivalAt: now, cadenceMs, rate, pendingCharacters: 0,
    // Hold the catch-up rate through the packet's drain, avoiding a slow tail.
    drawRate: Math.max(rate, backlog / cadenceMs),
    credit: previous?.credit ?? 0,
  };
}

/** Fractional UTF-16 units; callers carry the remainder across painted frames. */
export function revealBudget(backlog: number, elapsedMs: number, rate: number): number {
  return Math.min(backlog, Math.max(0, rate * elapsedMs));
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

/** Park on the last drawing tick, not on a future tick that may never run. */
function parkStreamReveal(cursor: StreamCursor): void {
  cursor.lastRevealAt = null;
  if (cursor.pacing) {
    cursor.pacing.credit = 0;
    cursor.pacing.lastArrivalAt = null;
    cursor.pacing.pendingCharacters = 0;
  }
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
      parkStreamReveal(cursor);
      continue;
    }
    const elapsed = cursor.lastRevealAt === null
      ? FIRST_FRAME_MS
      : Math.max(0, now - cursor.lastRevealAt);
    const pacing = cursor.pacing ??= recordStreamArrival(undefined, backlog, backlog, now);
    const available = revealBudget(backlog, elapsed, pacing.drawRate)
      + pacing.credit;
    const budget = Math.min(backlog, Math.max(0, Math.floor(available)));
    cursor.lastRevealAt = now;
    pacing.credit = available - budget;
    if (budget > 0) {
      const previousRevealed = cursor.revealed;
      cursor.revealed = alignRevealBoundary(cursor.receivedText, previousRevealed + budget);
      pacing.credit -= cursor.revealed - previousRevealed - budget;
      changed = true;
    }
    if (cursor.receivedText.length > cursor.revealed) {
      backlogRemains = true;
    } else {
      // This is the last scheduled tick: there may never be an empty-buffer
      // tick to do cleanup. Neither drawing nor estimation may bank idle time.
      parkStreamReveal(cursor);
    }
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
      changed = true;
    }
    parkStreamReveal(cursor);
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
