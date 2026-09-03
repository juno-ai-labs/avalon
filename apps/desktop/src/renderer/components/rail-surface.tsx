import clsx from 'clsx';
import { useEffect, useRef, useState } from 'react';

import { RailResizeHandle } from './rail-resize-handle';

/**
 * How long a panel that has just lost the right sidebar stays on screen fading
 * out. The stylesheet animates over the same span, so the two have to agree.
 */
export const RAIL_EXIT_FADE_MS = 190;

/**
 * Whether the right sidebar is still fading after it was dismissed. Opening
 * it has nothing to fade from.
 *
 * `scope` names what the panels belong to — the work stream, for the sidebar
 * the work-stream screen owns. A panel does not fade out of a scope it is no
 * longer in: it has nothing to dissolve into there, and holding it on screen
 * would lay the arriving scope out around a panel from the one just left. So a
 * changed scope adopts whatever is active in it and forgets everything about
 * the old one, including a fade already running. Callers with one scope leave
 * it out.
 */
export function useRailExitFade(
  open: boolean,
  scope?: string | null,
): boolean {
  const [shownScope, setShownScope] = useState(scope);
  const [shownOpen, setShownOpen] = useState(open);
  const [departure, setDeparture] = useState<number | null>(null);

  if (shownScope !== scope) {
    setShownScope(scope);
    setShownOpen(open);
    setDeparture(null);
  } else if (shownOpen !== open) {
    setShownOpen(open);
    setDeparture(open ? null : (departure ?? 0) + 1);
  }

  useEffect(() => {
    if (departure === null) return;
    const timer = window.setTimeout(() => setDeparture(null), RAIL_EXIT_FADE_MS);
    return () => window.clearTimeout(timer);
  }, [departure]);

  return departure !== null && !open;
}

interface RailSurfaceProps {
  /** Names the sidebar itself; the panel inside it owns the heading. */
  label: string;
  className?: string;
  /** Distinct from the header's close control, so the two do not read alike. */
  scrimLabel: string;
  resizeLabel: string;
  width: number;
  onResize: (width: number) => void;
  onClose: () => void;
  /** True while this panel is fading out over the one that replaced it. */
  leaving?: boolean;
  dropTarget?: {
    dragging: boolean;
    onDragEnter: React.DragEventHandler<HTMLElement>;
    onDragLeave: React.DragEventHandler<HTMLElement>;
    onDragOver: React.DragEventHandler<HTMLElement>;
    onDrop: React.DragEventHandler<HTMLElement>;
  };
  children: React.ReactNode;
}

/**
 * The right sidebar's frame owns everything about the slot rather than its
 * contents: the scrim, grab handle, focus, Escape, and width animation.
 */
export function RailSurface({
  label,
  className,
  scrimLabel,
  resizeLabel,
  width,
  onResize,
  onClose,
  leaving = false,
  dropTarget,
  children,
}: RailSurfaceProps): React.JSX.Element {
  const surfaceRef = useRef<HTMLElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  // A panel only ever becomes the leaving one after it has held the slot, so
  // this is what it was when it arrived, and the focus below is its arrival.
  const arrivedLeaving = useRef(leaving);

  useEffect(() => {
    if (arrivedLeaving.current) return;
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    requestAnimationFrame(() => surfaceRef.current?.focus());
    return () => {
      // A panel fading out unmounts well after it stopped holding the slot, so
      // it hands focus back only when the sidebar is gone rather than in other
      // hands — where the panel that took it has already claimed focus.
      if (!document.querySelector('.rail-surface:not(.is-leaving)')) previousFocus.current?.focus();
    };
  }, []);

  return (
    <>
      {!leaving && <button aria-label={scrimLabel} className="rail-scrim" onClick={onClose} type="button" />}
      {!leaving && <RailResizeHandle label={resizeLabel} onResize={onResize} width={width} />}
      <aside
        aria-label={label}
        className={clsx('rail-surface', className, leaving && 'is-leaving', dropTarget?.dragging && 'is-file-dragging')}
        inert={leaving}
        onDragEnter={dropTarget?.onDragEnter}
        onDragLeave={dropTarget?.onDragLeave}
        onDragOver={dropTarget?.onDragOver}
        onDrop={dropTarget?.onDrop}
        onKeyDown={(event) => {
          // Portalled controls owned by the panel can still bubble through the
          // React tree to here. Only Escapes raised inside the visible sidebar
          // close it.
          if (event.key !== 'Escape' || !event.currentTarget.contains(event.target as Node)) return;
          onClose();
        }}
        ref={surfaceRef}
        tabIndex={-1}
      >
        {children}
      </aside>
    </>
  );
}
