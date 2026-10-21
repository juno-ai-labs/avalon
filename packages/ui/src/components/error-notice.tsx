import { Children, createContext, isValidElement, useCallback, useContext, useEffect, useRef, useState, type PropsWithChildren, type ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import * as Tooltip from '@radix-ui/react-tooltip';

import { Button, Modal } from './primitives';

export interface AcknowledgedError {
  title: string;
  copy: ReactNode;
}

export function AcknowledgedErrorDialog({ error, onAcknowledge }: {
  error: AcknowledgedError | null;
  onAcknowledge: () => void;
}): React.JSX.Element {
  const acknowledgeRef = useRef<HTMLButtonElement>(null);
  return <Tooltip.Provider><Modal
    role="alertdialog"
    footer={<Button onClick={(event) => { event.stopPropagation(); onAcknowledge(); }} ref={acknowledgeRef}>OK</Button>}
    initialFocusRef={acknowledgeRef}
    onOpenChange={(open) => { if (!open) onAcknowledge(); }}
    open={error !== null}
    restoreFocus
    showCloseButton={false}
    title={error?.title ?? 'Something went wrong'}
  >
    {error && <Dialog.Description asChild><div className="modal-copy" data-error-notice>{error.copy}</div></Dialog.Description>}
  </Modal></Tooltip.Provider>;
}

interface Notice extends AcknowledgedError { signature: string }
const ErrorNotices = createContext<((notice: Notice) => void) | null>(null);

/** One queue per window; errors survive a menu or failed surface unmounting. */
export function ErrorNoticeProvider({ children }: PropsWithChildren): React.JSX.Element {
  const [queue, setQueue] = useState<Notice[]>([]);
  const publish = useCallback((notice: Notice) => {
    setQueue((current) => current.some((item) => item.signature === notice.signature)
      ? current : [...current, notice]);
  }, []);
  const acknowledge = useCallback(() => setQueue((current) => current.slice(1)), []);
  return <ErrorNotices.Provider value={publish}>
    {children}
    <AcknowledgedErrorDialog error={queue[0] ?? null} onAcknowledge={acknowledge} />
  </ErrorNotices.Provider>;
}

function copyText(children: ReactNode): string {
  return Children.toArray(children).map((child): string => {
    if (isValidElement<PropsWithChildren>(child)) return copyText(child.props.children);
    return typeof child === 'string' || typeof child === 'number' ? String(child) : '';
  }).join('');
}

/**
 * Declare a failure where its state is owned, without occupying layout space.
 * Acknowledgement leaves the draft and failure/retry state with the caller.
 * Clearing and re-raising the error (or changing occurrence) reports it again.
 */
export function ErrorNotice({ children, title = 'Something went wrong', occurrence }: PropsWithChildren<{
  title?: string;
  /** A query error object or attempt id distinguishes identical retry failures. */
  occurrence?: unknown;
}>): React.JSX.Element | null {
  const publish = useContext(ErrorNotices);
  const signature = JSON.stringify([title, copyText(children)]);
  const reported = useRef<{ signature: string; occurrence: unknown } | null>(null);
  const [dismissed, setDismissed] = useState<{ signature: string; occurrence: unknown } | null>(null);
  useEffect(() => {
    if (!publish || (reported.current?.signature === signature && Object.is(reported.current.occurrence, occurrence))) return;
    reported.current = { signature, occurrence };
    publish({ title, copy: children, signature });
  }, [publish, signature, title, children, occurrence]);

  // Also usable in an isolated component host, without an application shell.
  if (publish) return null;
  return <AcknowledgedErrorDialog
    error={dismissed?.signature === signature && Object.is(dismissed.occurrence, occurrence) ? null : { title, copy: children }}
    onAcknowledge={() => setDismissed({ signature, occurrence })}
  />;
}
