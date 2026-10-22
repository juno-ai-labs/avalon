import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { useRetainedPresence } from '../lib/retained-presence';

const TOAST_FRAMES = [
  { opacity: 0, transform: 'translateY(-7px) scale(.98)' },
  { opacity: 1, transform: 'translateY(0) scale(1)' },
];

export interface ToastProps {
  children: ReactNode;
  icon?: ReactNode;
  /** The caller controls duration; closing retains the content until its exit finishes. */
  open: boolean;
}

/**
 * A non-blocking confirmation over its nearest positioned container.
 * The caller owns `open` and its lifetime; this owns motion and announcement.
 * Keep it mounted while closed so the live region exists before an update.
 * Operational failures use ErrorNotice instead.
 */
export function Toast({ children, icon, open }: ToastProps): React.JSX.Element {
  const body = useRef<HTMLDivElement>(null);
  const retained = useRetainedPresence(open, body, TOAST_FRAMES);
  const previous = useRef({ children, icon });
  useLayoutEffect(() => { if (open) previous.current = { children, icon }; }, [children, icon, open]);
  const content = open ? { children, icon } : previous.current;
  return <div aria-atomic="true" aria-live="polite" className="toast-viewport" role="status">
    {(open || retained) &&
      <div aria-hidden={!open || undefined} className="toast" data-native-overlay="" ref={body}>
        {content.icon}
        <span>{content.children}</span>
      </div>}
  </div>;
}
