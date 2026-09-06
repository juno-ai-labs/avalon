import { useLayoutEffect, useRef, type RefObject } from 'react';

export const TRANSCRIPT_HISTORY_EDGE = 160;

/** Load adjacent history whenever layout or scrolling brings its edge near the viewport. */
export function useTranscriptHistory({
  scrollRef,
  conversationAddress,
  enabled,
  loadOlder,
}: {
  scrollRef: RefObject<HTMLElement | null>;
  conversationAddress: string;
  enabled: boolean;
  loadOlder: () => Promise<void>;
}): void {
  const requestInFlight = useRef<{ address: string } | null>(null);

  // Run after every commit: virtual row measurements can replace estimates
  // without changing the transcript data. Observe resizing as well, including
  // disclosure rows that collapse entirely within MessageFeed.
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element || !enabled) return;
    let frame: number | undefined;
    const check = (): void => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (document.visibilityState === 'hidden'
          || requestInFlight.current?.address === conversationAddress
          || element.clientHeight <= 0 || element.scrollTop >= TRANSCRIPT_HISTORY_EDGE) return;
        const request = { address: conversationAddress };
        requestInFlight.current = request;
        void loadOlder().finally(() => {
          if (requestInFlight.current === request) requestInFlight.current = null;
        });
      });
    };
    const observer = new ResizeObserver(check);
    observer.observe(element);
    if (element.firstElementChild) observer.observe(element.firstElementChild);
    element.addEventListener('scroll', check, { passive: true });
    document.addEventListener('visibilitychange', check);
    check();
    return () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      observer.disconnect();
      element.removeEventListener('scroll', check);
      document.removeEventListener('visibilitychange', check);
    };
  });

}
