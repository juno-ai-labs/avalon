import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';

/**
 * How close to the end the viewport counts as showing the newest message. It is
 * slack for the drift between what the virtualizer has measured and what the
 * container has laid out, not a reading position.
 */
export const TRANSCRIPT_END_SLACK = 80;

/**
 * How far a scroll may land from the position the transcript wrote and still be
 * that write coming back. A tenth of a pixel would do for the write itself; the
 * tolerance is for the browser clamping it to a fractional maximum that
 * `scrollHeight - clientHeight` — both integers — cannot express.
 */
const OWN_SCROLL_TOLERANCE = 1.5;

/**
 * Whether the transcript should still follow the newest message, given a scroll
 * the transcript did not itself perform.
 *
 * Moving *away* from the end is the whole signal, and it is read before the
 * slack: someone who has pulled back a single wheel tick has taken the viewport
 * even though they are still inside it. Reading the slack first is what let the
 * old screen re-arm itself — a tick up landed 60px from the end, which still
 * counted as being at the end, so the follow fired again and took it straight
 * back. A scroll that comes to rest inside the slack *without having moved away
 * to get there* hands the viewport back.
 */
export function nextTranscriptFollowState(
  following: boolean,
  previousDistanceFromEnd: number,
  distanceFromEnd: number,
): boolean {
  if (distanceFromEnd > previousDistanceFromEnd) return false;
  if (distanceFromEnd < TRANSCRIPT_END_SLACK) return true;
  return following;
}

export interface TranscriptFollow {
  /**
   * Whether the newest message is being shown. False whenever the transcript is
   * not following, so it never reports the end from a measurement that stopped
   * being updated — content growing below the fold fires no scroll event.
   */
  atEnd: boolean;
  onScroll: (element: HTMLElement) => void;
  onWheel: (element: HTMLElement, deltaY: number) => void;
  /** Stop following, because the screen has put the viewport somewhere else. */
  release: () => void;
  /** Move the viewport without it being read as the reader having moved it. */
  scrollTo: (top: number) => void;
  /** Go to the newest message and follow it from there. */
  scrollToEnd: (options?: { smooth?: boolean }) => void;
}

/**
 * Keeps a scrolling transcript at its newest message while a turn streams in,
 * and gets out of the way the moment the reader scrolls.
 *
 * The rule the whole hook exists to enforce is that **only the reader's own
 * scrolling decides where the viewport sits**. Following is a service, not a
 * claim, and the scrolling this hook performs to provide it must never be read
 * back as though the reader had asked for it — which is exactly what an earlier
 * transcript did, leaving no way to read a reply from the top until it finished.
 *
 * Every write to the container therefore goes through `scrollTo`, `scrollToEnd`,
 * or the follow itself, each of which records the position it left behind. A
 * scroll event that reports that position is the transcript's own; anything else
 * is the reader's. Ownership is decided by the value rather than by a flag
 * because a flag has to be spent exactly once, and a write the browser clamps
 * away spends it on the reader's next scroll instead.
 *
 * `canFollow` is the screen's own gate: it has finished positioning this work
 * stream, there is a transcript, and the end of it is loaded rather than a page
 * away. `resetKey` is the work stream — the screen is not remounted when the
 * reader moves between two, so nothing else would clear the last one's state.
 */
export function useTranscriptFollow(
  scrollElementRef: RefObject<HTMLElement | null>,
  canFollow: boolean,
  resetKey: string,
): TranscriptFollow {
  const [atEnd, setAtEnd] = useState(true);
  // Held in refs, not state: a scroll event has to be able to stop the follow
  // *before* the next commit runs it, and an update scheduled from the scroll
  // handler is not guaranteed to have been applied by then. A follow that runs
  // one more time has already taken the viewport back off the reader.
  const followingRef = useRef(true);
  const ownScrollTopRef = useRef<number | null>(null);
  const distanceFromEndRef = useRef(0);
  // A smooth scroll to the end delivers a scroll event per frame, each further
  // from the end than the last while it accelerates. Following is armed when it
  // arrives rather than when it starts, so its own animation cannot be read as
  // the reader pulling away from the end it is travelling towards.
  const followWhenSettledRef = useRef(false);

  const stopFollowing = useCallback((): void => {
    followingRef.current = false;
    followWhenSettledRef.current = false;
    setAtEnd(false);
  }, []);

  /** Record where a write of our own left the viewport, as the browser has it. */
  const recordOwnScroll = useCallback((element: HTMLElement): void => {
    // Read back rather than reusing the value written: the browser clamps to its
    // own fractional maximum, and the scroll event reports that.
    ownScrollTopRef.current = element.scrollTop;
    distanceFromEndRef.current = element.scrollHeight - element.scrollTop - element.clientHeight;
  }, []);

  /**
   * Deliberately every commit, with no dependency list. A streaming turn grows
   * the last row without changing anything this could depend on — the row
   * re-measures, the list publishes a new total size, and that commit is the
   * only moment at which the end has moved. Correcting before paint is also
   * what keeps it smooth: deferring into an animation frame paints one frame of
   * the new text at the old scroll position first.
   */
  useLayoutEffect(() => {
    if (!followingRef.current || !canFollow) return;
    const element = scrollElementRef.current;
    if (!element) return;
    const end = element.scrollHeight - element.clientHeight;
    if (Math.abs(element.scrollTop - end) < 1) return;
    element.scrollTop = end;
    recordOwnScroll(element);
  });

  // Nothing else clears the last work stream's decision: the screen is one
  // component across every route under /workstreams/:id, so its hooks are never
  // remounted and a reader who scrolled away from one would arrive at the next
  // already not following it.
  useEffect(() => {
    followingRef.current = true;
    followWhenSettledRef.current = false;
    ownScrollTopRef.current = null;
    distanceFromEndRef.current = 0;
    setAtEnd(true);
  }, [resetKey]);

  const onScroll = useCallback((element: HTMLElement): void => {
    const distanceFromEnd = element.scrollHeight - element.scrollTop - element.clientHeight;
    const own = ownScrollTopRef.current;
    if (own !== null && Math.abs(element.scrollTop - own) < OWN_SCROLL_TOLERANCE) {
      // The transcript's own scroll, coming back. It says nothing about where
      // the reader wants to be, so it may only record the position it left.
      ownScrollTopRef.current = null;
      distanceFromEndRef.current = distanceFromEnd;
      setAtEnd(followingRef.current && distanceFromEnd < TRANSCRIPT_END_SLACK);
      return;
    }
    if (followWhenSettledRef.current) {
      // Mid-flight in a scroll the reader asked for. Arm on arrival; a wheel is
      // what cancels it, and that is handled in `onWheel`.
      if (distanceFromEnd < TRANSCRIPT_END_SLACK) {
        followWhenSettledRef.current = false;
        followingRef.current = true;
      }
    } else {
      followingRef.current = nextTranscriptFollowState(
        followingRef.current,
        distanceFromEndRef.current,
        distanceFromEnd,
      );
    }
    distanceFromEndRef.current = distanceFromEnd;
    setAtEnd(followingRef.current && distanceFromEnd < TRANSCRIPT_END_SLACK);
  }, []);

  /**
   * A wheel reaches the main thread on the input itself. The scroll it causes is
   * applied by the compositor and its event can arrive a frame later — late
   * enough for a follow to have already corrected it away and for the scroll to
   * report the end, which is how a trackpad gesture was swallowed one tick at a
   * time.
   *
   * It is read only when the transcript can actually act on it. `wheel` bubbles,
   * so a reader scrolling a code block, a wide table, or an expanded tool output
   * inside a message sends one here too, and a transcript already at its top or
   * shorter than its viewport cannot move at all — in both cases no scroll event
   * follows to correct a wrong guess, so the follow would stay off for the rest
   * of the turn on a gesture that never touched it.
   */
  const onWheel = useCallback((element: HTMLElement, deltaY: number): void => {
    if (deltaY >= 0 || element.scrollTop <= 0) return;
    stopFollowing();
  }, [stopFollowing]);

  const release = useCallback((): void => {
    followingRef.current = false;
    followWhenSettledRef.current = false;
    ownScrollTopRef.current = null;
    distanceFromEndRef.current = 0;
    setAtEnd(false);
  }, []);

  const scrollTo = useCallback((top: number): void => {
    const element = scrollElementRef.current;
    if (!element || element.scrollTop === top) return;
    element.scrollTop = top;
    recordOwnScroll(element);
  }, [recordOwnScroll, scrollElementRef]);

  const scrollToEnd = useCallback((options?: { smooth?: boolean }): void => {
    const element = scrollElementRef.current;
    if (!element) {
      followingRef.current = true;
      setAtEnd(true);
      return;
    }
    const end = element.scrollHeight - element.clientHeight;
    if (options?.smooth && Math.abs(element.scrollTop - end) >= 1) {
      followWhenSettledRef.current = true;
      followingRef.current = false;
      setAtEnd(true);
      // An explicit `behavior` here wins over the stylesheet's global
      // `scroll-behavior: auto !important` kill switch per spec, so the
      // reduced-motion preference has to be read here too rather than left to
      // CSS — the same gate `sidebar.tsx` applies to its own `scrollTo` call.
      element.scrollTo({
        behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
        top: end,
      });
      return;
    }
    followWhenSettledRef.current = false;
    followingRef.current = true;
    setAtEnd(true);
    if (element.scrollTop === end) return;
    element.scrollTop = end;
    recordOwnScroll(element);
  }, [recordOwnScroll, scrollElementRef]);

  return { atEnd, onScroll, onWheel, release, scrollTo, scrollToEnd };
}
