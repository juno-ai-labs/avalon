import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';

/**
 * How close to the end the viewport counts as showing the newest message. It is
 * slack for the drift between what the virtualizer has measured and what the
 * container has laid out, not a reading position.
 */
export const TRANSCRIPT_END_SLACK = 80;

/**
 * Whether the transcript should still follow the newest message, given a scroll
 * the transcript did not itself perform.
 *
 * Moving *away* from the end is the whole signal, and it is read before the
 * slack: someone who has pulled back a single wheel tick has taken the viewport
 * even though they are still inside it. Reading the slack first is what let the
 * old screen re-arm itself — a tick up landed 60px from the end, which still
 * counted as being at the end, so the follow fired again and took it straight
 * back. Coming to rest inside the slack hands the viewport back.
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
  /** Whether the viewport is showing the end of the transcript. */
  atEnd: boolean;
  /** Declare that the next scroll event belongs to the screen, not the reader. */
  claimNextScroll: () => void;
  onScroll: (element: HTMLElement) => void;
  onWheel: (deltaY: number) => void;
  /** Stop following, because the screen has put the viewport somewhere else. */
  release: () => void;
  /** Follow again — the reader asked for the newest message. */
  resume: () => void;
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
 * `canFollow` is the screen's own gate: it has finished positioning this work
 * stream, there is a transcript, and the end of it is loaded rather than a page
 * away.
 */
export function useTranscriptFollow(
  scrollElementRef: RefObject<HTMLElement | null>,
  canFollow: boolean,
): TranscriptFollow {
  const [atEnd, setAtEnd] = useState(true);
  // Held in refs, not state: a scroll event has to be able to stop the follow
  // *before* the next commit runs it, and an update scheduled from the scroll
  // handler is not guaranteed to have been applied by then. A follow that runs
  // one more time has already taken the viewport back off the reader.
  const followingRef = useRef(true);
  const screenOwnsNextScrollRef = useRef(false);
  const distanceFromEndRef = useRef(0);

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
    screenOwnsNextScrollRef.current = true;
    element.scrollTop = end;
    distanceFromEndRef.current = 0;
  });

  const onScroll = useCallback((element: HTMLElement): void => {
    const distanceFromEnd = element.scrollHeight - element.scrollTop - element.clientHeight;
    if (screenOwnsNextScrollRef.current) {
      // The screen's own scroll. It says nothing about where the reader wants
      // to be, so it may only record the position it left behind.
      screenOwnsNextScrollRef.current = false;
    } else {
      followingRef.current = nextTranscriptFollowState(
        followingRef.current,
        distanceFromEndRef.current,
        distanceFromEnd,
      );
    }
    distanceFromEndRef.current = distanceFromEnd;
    setAtEnd(distanceFromEnd < TRANSCRIPT_END_SLACK);
  }, []);

  /**
   * A wheel reaches the main thread on the input itself. The scroll it causes is
   * applied by the compositor and its event can arrive a frame later — late
   * enough for a follow to have already undone the tick and for the scroll to
   * report the end, which is how a trackpad gesture was swallowed one tick at a
   * time. Reading the intent from the input settles it on the first tick.
   */
  const onWheel = useCallback((deltaY: number): void => {
    if (deltaY < 0) followingRef.current = false;
  }, []);

  const claimNextScroll = useCallback((): void => {
    screenOwnsNextScrollRef.current = true;
  }, []);

  const release = useCallback((): void => {
    followingRef.current = false;
    distanceFromEndRef.current = 0;
    setAtEnd(false);
  }, []);

  const resume = useCallback((): void => {
    followingRef.current = true;
    distanceFromEndRef.current = 0;
    setAtEnd(true);
  }, []);

  return { atEnd, claimNextScroll, onScroll, onWheel, release, resume };
}
