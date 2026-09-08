import { useCallback, useContext, useEffect, useRef } from 'react';
import { ConversationVisibilityContext } from './conversation-visibility';

/** Debounce reads only while the host actually presents this conversation. */
export function useVisibleReadAcknowledgement(acknowledge: () => void): () => void {
  const visible = useContext(ConversationVisibilityContext);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const timer = useRef<number | null>(null);
  const schedule = useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    if (!visible) return;
    // Preserve the conversation's existing read debounce interval.
    timer.current = window.setTimeout(() => {
      timer.current = null;
      if (visibleRef.current) acknowledge();
    }, 250);
  }, [acknowledge, visible]);
  useEffect(() => {
    schedule();
    window.addEventListener('focus', schedule);
    document.addEventListener('visibilitychange', schedule);
    return () => {
      window.removeEventListener('focus', schedule);
      document.removeEventListener('visibilitychange', schedule);
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = null;
    };
  }, [schedule]);
  return schedule;
}
