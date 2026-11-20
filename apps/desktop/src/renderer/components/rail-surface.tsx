import clsx from 'clsx';
import { createContext, useContext, useEffect, useMemo, useRef, useState, type RefObject } from 'react';

import { isComposingKeyEvent } from '../lib/ime';

import { RailResizeHandle, type RailResize } from './rail-resize-handle';

/**
 * How long a panel that has just lost the slot stays on screen fading
 * out. The stylesheet animates over the same span, so the two have to agree.
 */
export const RAIL_EXIT_FADE_MS = 240;

/**
 * Whether the panel is still fading after it was dismissed. Opening
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

/**
 * Which side of the main pane a panel takes: `leading` sits beside the
 * sidebar with the conversation after it, `trailing` after the conversation.
 */
export type PanelSide = 'leading' | 'trailing';

interface PanelHostValue {
  side: PanelSide;
  /** Within two frames of the host mounting: a panel that mounts now is part of its arrival. */
  arriving: boolean;
}

/** A panel outside any host trails, and slides in. */
const NO_HOST: PanelHostValue = { side: 'trailing', arriving: false };
const PanelHostContext = createContext<PanelHostValue>(NO_HOST);

/**
 * What one conversation's panels share: the side they take, and whether one
 * mounting now belongs to the conversation's arrival. With no `side`, a host
 * inside another passes that one through. A host is mounted per conversation
 * (its screen is keyed), so its mount is the arrival.
 * `docs/desktop-shell.md#one-slot` owns the mechanism.
 */
export function PanelHost({ side, children }: { side?: PanelSide; children: React.ReactNode }): React.JSX.Element {
  const outer = useContext(PanelHostContext);
  const [arriving, setArriving] = useState(true);
  useEffect(() => afterTwoFrames(() => setArriving(false)), []);
  const own = useMemo<PanelHostValue>(() => ({ side: side ?? 'trailing', arriving }), [arriving, side]);
  return <PanelHostContext.Provider value={side === undefined && outer !== NO_HOST ? outer : own}>{children}</PanelHostContext.Provider>;
}

/** A box in window coordinates, as a native view is placed. */
export interface ViewBounds { x: number; y: number; width: number; height: number }

/**
 * The part of `rect` a native view may cover: inside every clip and inside
 * the window. Nothing in the page clips a native view, so it clips itself.
 */
export function visibleRect(
  rect: Pick<DOMRectReadOnly, 'left' | 'top' | 'right' | 'bottom'>,
  clips: readonly (Pick<DOMRectReadOnly, 'left' | 'top' | 'right' | 'bottom'> | undefined)[],
  viewport: { width: number; height: number },
): ViewBounds {
  let { left, top, right, bottom } = rect;
  for (const clip of [...clips, { left: 0, top: 0, right: viewport.width, bottom: viewport.height }]) {
    if (!clip) continue;
    left = Math.max(left, clip.left);
    top = Math.max(top, clip.top);
    right = Math.min(right, clip.right);
    bottom = Math.min(bottom, clip.bottom);
  }
  return { x: Math.round(left), y: Math.round(top), width: Math.max(0, Math.round(right - left)), height: Math.max(0, Math.round(bottom - top)) };
}

/**
 * What a native view in a panel re-measures on besides its own box: the
 * panel's frame, which clips it while the slot slides, and the main pane,
 * whose left edge carries a leading panel sideways, at the same size, when
 * the sidebar is resized.
 */
export function observePanelPlacement(observer: ResizeObserver, element: Element): void {
  const frame = element.closest('.rail-surface');
  if (frame) observer.observe(frame);
  const pane = element.closest('.main-pane');
  if (pane) observer.observe(pane);
}

function afterTwoFrames(run: () => void): () => void {
  let second = 0;
  const first = requestAnimationFrame(() => { second = requestAnimationFrame(run); });
  return () => {
    cancelAnimationFrame(first);
    cancelAnimationFrame(second);
  };
}

interface RailSurfaceProps {
  /** Names the sidebar itself; the panel inside it owns the heading. */
  label: string;
  className?: string;
  resizeLabel: string;
  width: number;
  onResize: RailResize;
  onClose: () => void;
  /** Lets the panel reach the surface, which holds focus when the rail opens. */
  surfaceRef?: RefObject<HTMLElement | null>;
  /** Automatic reveals preserve the person's current keyboard focus. */
  focusOnOpen?: boolean;
  /** True while this panel is fading out over the one that replaced it. */
  leaving?: boolean;
  /** Keys pressed inside the panel, the surface itself included; not in its portalled menus. */
  onKeyDown?: React.KeyboardEventHandler<HTMLElement>;
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
 * A panel's frame owns everything about the slot rather than its contents:
 * the side it takes (its host's), how it arrives, its grab handle, focus and
 * Escape. The shell reads `is-leading`, `is-shown` and `is-travelling` off
 * the frame with `:has()`; `docs/desktop-shell.md#one-slot` owns why.
 */
export function RailSurface({
  label,
  className,
  resizeLabel,
  width,
  onResize,
  onClose,
  leaving = false,
  focusOnOpen = true,
  onKeyDown,
  dropTarget,
  surfaceRef: hostRef,
  children,
}: RailSurfaceProps): React.JSX.Element {
  const ownRef = useRef<HTMLElement>(null);
  const surfaceRef = hostRef ?? ownRef;
  const host = useContext(PanelHostContext);
  const { side } = host;
  // An opening is shown two frames after it mounts: the mount can outlast the
  // slide, and a transition started inside it is over before a frame is drawn.
  // In place instead when it is part of its host's arrival, or takes over
  // from a panel already shown, which is still in the document as this renders.
  const [inPlace] = useState(() => host.arriving || document.querySelector('.rail-surface.is-shown') !== null);
  const [settled, setSettled] = useState(false);
  useEffect(() => afterTwoFrames(() => setSettled(true)), []);
  const shown = (inPlace || settled) && !leaving;
  const previousFocus = useRef<HTMLElement | null>(null);
  // A panel only ever becomes the leaving one after it has held the slot, so
  // this is what it was when it arrived, and the focus below is its arrival.
  const arrivedLeaving = useRef(leaving);
  const arrivedFocusOnOpen = useRef(focusOnOpen);

  useEffect(() => {
    if (arrivedLeaving.current || !arrivedFocusOnOpen.current) return;
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const arrivedFocus = document.activeElement;
    const parentSurface = surfaceRef.current?.parentElement?.closest<HTMLElement>('.rail-surface');
    const frame = requestAnimationFrame(() => {
      // The person can open a portalled menu before this frame. Do not steal
      // its focus and dismiss it when the panel's deferred arrival runs.
      if (document.activeElement === arrivedFocus || document.activeElement === document.body) surfaceRef.current?.focus();
    });
    return () => {
      cancelAnimationFrame(frame);
      // A panel fading out unmounts well after it stopped holding the slot, so
      // it hands focus back only when the sidebar is gone rather than in other
      // hands — where the panel that took it has already claimed focus.
      const remaining = [...document.querySelectorAll('.rail-surface:not(.is-leaving)')];
      // A surviving ancestor is still our conversation; a sibling is a
      // replacement panel and owns focus now.
      if (remaining.every((surface) => parentSurface && (surface === parentSurface || surface.contains(parentSurface)))) {
        const opener = previousFocus.current;
        (opener?.isConnected ? opener : parentSurface)?.focus();
      }
    };
  }, []);

  return (
    <>
      {!leaving && <RailResizeHandle label={resizeLabel} onResize={onResize} side={side} width={width} />}
      <aside
        aria-label={label}
        className={clsx('rail-surface', className, side === 'leading' && 'is-leading', shown && 'is-shown', settled && 'is-travelling', leaving && 'is-leaving', dropTarget?.dragging && 'is-file-dragging')}
        inert={leaving}
        onDragEnter={dropTarget?.onDragEnter}
        onDragLeave={dropTarget?.onDragLeave}
        onDragOver={dropTarget?.onDragOver}
        onDrop={dropTarget?.onDrop}
        onKeyDown={(event) => {
          // Portalled controls owned by the panel, such as its menus, can
          // still bubble through the React tree to here. Only keys raised
          // inside the visible sidebar reach the panel or close it.
          if (!event.currentTarget.contains(event.target as Node)) return;
          onKeyDown?.(event);
          if (event.key === 'Escape' && !event.defaultPrevented && !isComposingKeyEvent(event.nativeEvent)) {
            event.preventDefault();
            onClose();
          }
        }}
        ref={surfaceRef}
        tabIndex={-1}
      >
        <div className="rail-surface-content">{children}</div>
      </aside>
    </>
  );
}
