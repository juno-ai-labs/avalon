import { useLayoutEffect, useRef, useState, type RefObject } from 'react';

const TRANSCRIPT_HISTORY_EDGE = 160;

/** Observe the loaded edge; the surface owns readiness, requests, and errors. */
export function useTranscriptHistory({
  scrollRef,
  contentRef,
  conversationAddress,
  enabled,
  canLoad,
  loadOlder,
}: {
  scrollRef: RefObject<HTMLElement | null>;
  contentRef: RefObject<HTMLElement | null>;
  conversationAddress: string;
  enabled: boolean;
  canLoad: boolean;
  loadOlder: () => void;
}): boolean {
  const latest = useRef({ canLoad, loadOlder });
  const checkRef = useRef<(() => void) | null>(null);
  const [nearEdge, setNearEdge] = useState(false);
  useLayoutEffect(() => { latest.current = { canLoad, loadOlder }; });

  useLayoutEffect(() => {
    const element = scrollRef.current;
    const content = contentRef.current;
    setNearEdge(false);
    if (!element || !enabled) return;
    let frame: number | undefined;
    const check = (): void => {
      // Keep an already scheduled check: streaming commits must not postpone it.
      if (frame !== undefined) return;
      frame = requestAnimationFrame(() => {
        frame = undefined;
        const near = document.visibilityState !== 'hidden'
          && element.clientHeight > 0 && element.scrollTop < TRANSCRIPT_HISTORY_EDGE;
        setNearEdge(near);
        if (near && latest.current.canLoad) latest.current.loadOlder();
      });
    };
    checkRef.current = check;
    const observer = new ResizeObserver(check);
    observer.observe(element);
    if (content) observer.observe(content);
    element.addEventListener('scroll', check, { passive: true });
    document.addEventListener('visibilitychange', check);
    check();
    return () => {
      checkRef.current = null;
      if (frame !== undefined) cancelAnimationFrame(frame);
      observer.disconnect();
      element.removeEventListener('scroll', check);
      document.removeEventListener('visibilitychange', check);
    };
  }, [scrollRef, contentRef, enabled, conversationAddress]);

  // Row measurements may change on any commit. Recheck without rebuilding
  // observers or cancelling the frame another commit has already scheduled.
  useLayoutEffect(() => { checkRef.current?.(); });
  return nearEdge;
}
