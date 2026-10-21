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

interface Notice extends AcknowledgedError { signature: string; occurrence?: unknown }
const ErrorNotices = createContext<((notice: Notice, reopen?: boolean) => void) | null>(null);

/** One queue per window; errors survive a menu or failed surface unmounting. */
export function ErrorNoticeProvider({ children }: PropsWithChildren): React.JSX.Element {
  const [queue, setQueue] = useState<Notice[]>([]);
  const reportedOccurrences = useRef(new Map<unknown, Set<string>>());
  const publish = useCallback((notice: Notice, reopen = false) => {
    if (notice.occurrence !== undefined) {
      const reported = reportedOccurrences.current.get(notice.occurrence) ?? new Set<string>();
      if (!reopen && reported.has(notice.signature)) return;
      reported.add(notice.signature);
      reportedOccurrences.current.set(notice.occurrence, reported);
    }
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
 * New attempts supply a new occurrence; old occurrences stay acknowledged
 * across remounts. Without an occurrence, clearing and raising reports again.
 */
export function ErrorNotice({ children, title = 'Something went wrong', occurrence, automatic = true, detailsLabel }: PropsWithChildren<{
  title?: string;
  /** A query error object or attempt id distinguishes identical retry failures. */
  occurrence?: unknown;
  /** Stored transcript failures expose details without interrupting on scroll. */
  automatic?: boolean;
  /** Keep the popup available after acknowledgement without inline error copy. */
  detailsLabel?: string;
}>): React.JSX.Element | null {
  const publish = useContext(ErrorNotices);
  const signature = JSON.stringify([title, copyText(children)]);
  const reported = useRef<{ signature: string; occurrence: unknown } | null>(null);
  const [dismissed, setDismissed] = useState<{ signature: string; occurrence: unknown } | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  useEffect(() => {
    if (!automatic || !publish || (reported.current?.signature === signature && Object.is(reported.current.occurrence, occurrence))) return;
    reported.current = { signature, occurrence };
    publish({ title, copy: children, signature, occurrence });
  }, [automatic, publish, signature, title, children, occurrence]);

  const details = detailsLabel && <Button onClick={(event) => {
    event.stopPropagation();
    if (publish) publish({ title, copy: children, signature, occurrence }, true);
    else setDetailsOpen(true);
  }}>{detailsLabel}</Button>;

  // Also usable in an isolated component host, without an application shell.
  if (publish) return details || null;
  const acknowledged = dismissed?.signature === signature && Object.is(dismissed.occurrence, occurrence);
  return <>{details}<AcknowledgedErrorDialog
    error={detailsOpen || (automatic && !acknowledged) ? { title, copy: children } : null}
    onAcknowledge={() => { setDetailsOpen(false); setDismissed({ signature, occurrence }); }}
  /></>;
}
