import clsx from 'clsx';
import { useEffect, useRef, useState } from 'react';

import { RailResizeHandle } from './rail-resize-handle';

/**
 * How long a panel that has just lost the right sidebar stays on screen fading
 * out. The stylesheet animates over the same span, so the two have to agree.
 */
export const RAIL_CROSSFADE_MS = 190;

/**
 * Which panel is leaving the right sidebar, for as long as it is still fading
 * out — over the panel that replaced it, or over nothing when the sidebar was
 * dismissed. Opening it has nothing to fade from.
 *
 * A hand-off does not always reach this hook as one change: HyperSight taking
 * the slot is a preference write that settles a microtask after the inspector
 * has already let go, so the slot is briefly empty in between. Carrying the
 * outgoing panel through that gap is what makes both directions cross-fade
 * rather than only the one that happens to change hands in a single commit.
 */
export function useRailCrossFade(activeId: string | null): string | null {
  const [shownId, setShownId] = useState(activeId);
  const [leavingId, setLeavingId] = useState<string | null>(null);

  if (shownId !== activeId) {
    setShownId(activeId);
    if (shownId !== null) setLeavingId(shownId);
  }

  useEffect(() => {
    if (leavingId === null) return;
    const timer = window.setTimeout(() => setLeavingId(null), RAIL_CROSSFADE_MS);
    return () => window.clearTimeout(timer);
  }, [leavingId]);

  // A panel that takes the slot back before its own fade is over is on screen
  // as itself, not as its own ghost.
  return leavingId === activeId ? null : leavingId;
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
 * The right sidebar's frame, shared by HyperSight and the inspector rail. Only
 * one of them holds the slot at a time, so the frame owns everything that is
 * about the slot rather than its contents: the scrim, the grab handle beside
 * it, focus, Escape, and the width the stylesheet animates between panels.
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
          // A block prompt's dialog is portalled to the document body, but a
          // React synthetic event still bubbles up the React tree to here — so
          // without this, dismissing that dialog would also close the sidebar.
          // Only Escapes raised inside the sidebar itself close it.
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
