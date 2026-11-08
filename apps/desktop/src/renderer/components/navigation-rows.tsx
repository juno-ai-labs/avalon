import * as ContextMenu from '@radix-ui/react-context-menu';
import { IconPencil, IconPin, IconPinnedOff } from '@tabler/icons-react';
import clsx from 'clsx';
import { useCallback, useEffect, useId, useLayoutEffect, useState, type ReactNode, type RefObject } from 'react';
import { Link } from 'react-router-dom';

import { useListMotionPass } from '../lib/use-list-motion';

import { Tip } from './primitives';
import { SidebarSkeletonRows } from './sidebar-skeleton';

/*
 * The navigation sidebar's row primitives, shared by every list it draws: a
 * row's layout, a section heading, and the Pinned group a row is dragged into.
 * Nothing here knows what a row stands for; each section supplies its tiles,
 * names and pin writes.
 */

/**
 * The Pinned section of a tab. It is always there, because it is where a row
 * is dragged to pin it: with nothing pinned it says so, and it wakes in the
 * accent while a row is being dragged. The whole section, heading included,
 * is the drop target, so a release in a gap between rows still counts.
 */
export function PinnedSection({ children, count, drop, heading = 'Pinned', howToPin, label, loading = false, noun, pinnedOnly = false, reorderable, target }: {
  children: ReactNode;
  count: number;
  /** A row being dragged toward the section, and the slot it would take; null while none is. */
  drop: { index: number | null } | null;
  heading?: string;
  /** The heading mark's tip while there is nothing to arrange, where dragging a row in is not how this kind is pinned. */
  howToPin?: string;
  label: string;
  /**
   * In the Pinned tab, where no list beside it shows its own placeholders:
   * the rows are still being read, so placeholders stand in for them.
   */
  loading?: boolean;
  noun: string;
  /** In the Pinned tab, where no unpinned row sits beside it to be moved in. */
  pinnedOnly?: boolean;
  /** Whether any one kind holds two or more pins; each kind reorders on its own. */
  reorderable: boolean;
  target: React.HTMLAttributes<HTMLElement>;
}): React.JSX.Element {
  const hint = useId();
  // How to reorder is said once, for the section; each row says only its
  // place (`pinnedPosition`). As a per-row description it would be repeated
  // before every title.
  return <section aria-busy={loading || undefined} aria-describedby={reorderable ? hint : undefined} aria-label={label} className="navigation-section" {...target}>
    <SectionHeading motionKey={pinnedOnly ? `pinned:${noun}` : 'pinned'} trailing={<PinnedMark howToPin={howToPin} reorderable={reorderable} />}>{heading}</SectionHeading>
    {reorderable && <p className="sr-only" id={hint}>Hold Alt and press the up or down arrow to move a pinned {noun}.</p>}
    {loading && <SidebarSkeletonRows count={Math.max(1, count)} />}
    {!loading && count === 0 && drop?.index == null && <div className={clsx('pinned-empty-drop-surface', drop && 'is-armed')}>
      <IconPin aria-hidden="true" size={15} stroke={1.7} />
      <span>{pinnedOnly ? `Pin ${/^[aeiou]/u.test(noun) ? 'an' : 'a'} ${noun} to keep it here` : `Move a ${noun} here to pin it`}</span>
    </div>}
    {children}
  </section>;
}

/** A pinned row's place, read after its title. */
export function pinnedPosition(index: number, count: number): string {
  return `Pinned, ${index + 1} of ${count}.`;
}


/**
 * Where a link's own click should be left to the browser: a modifier or a
 * button other than the main one opens it somewhere else (a new tab, in the
 * web app), so it is not this window opening the row.
 */
export function opensElsewhere(event: React.MouseEvent): boolean {
  return event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;
}


/** A placeholder row: a picture of where a dragged row would land, out of reach of focus and assistive technology. */
export function ghostProps(ghost: boolean): React.HTMLAttributes<HTMLElement> {
  return ghost ? { 'aria-hidden': true, tabIndex: -1 } : {};
}


/**
 * A section's heading. It is a held row of the list motion, so it travels with
 * the rows under it when a section above appears or goes, rather than being
 * the thing seen to leave.
 */
export function SectionHeading({ children, motionKey, trailing }: {
  children: ReactNode;
  motionKey: string;
  trailing?: ReactNode;
}): React.JSX.Element {
  return <div className="navigation-section-heading" data-motion-hold="" data-motion-key={`heading:${motionKey}`}>
    <span>{children}</span>
    {trailing && <span className="navigation-section-trailing">{trailing}</span>}
  </div>;
}

/** The Pinned heading's pin; its tooltip says how to pin, then how to arrange once there is something to arrange. */
export function PinnedMark({ howToPin = 'Drag a row here or right-click it to pin', reorderable }: { howToPin?: string | undefined; reorderable: boolean }): React.JSX.Element {
  const mark = <span aria-hidden="true" className="navigation-section-mark">
    <IconPin size={14} stroke={1.8} />
  </span>;
  return <Tip label={reorderable ? 'Drag to reorder' : howToPin}>{mark}</Tip>;
}


/**
 * One row of any of the three lists: a tile, a name with its time, and a
 * second line with an optional unread dot at its end.
 */
export function RowLayout({ detail, tile, time, title, titleExtra, unread, unreadLabel = 'Unread' }: {
  detail: ReactNode;
  tile: ReactNode;
  time?: ReactNode;
  title: ReactNode;
  titleExtra?: ReactNode;
  unread: boolean;
  /** What the dot is called; Activity's word for it is "Unseen". */
  unreadLabel?: string;
}): React.JSX.Element {
  return <>
    {tile}
    <span className="navigation-row-copy">
      <span className="navigation-row-line">
        <span className="navigation-row-title">{title}</span>
        {titleExtra}
        {time}
      </span>
      <span className="navigation-row-line">
        <span className="navigation-row-detail">{detail}</span>
        {unread && <span aria-label={unreadLabel} className="navigation-row-unread-dot" role="img" />}
      </span>
    </span>
  </>;
}


/** An unpinned row being dragged toward a Pinned group, and whether it was let go there. */
export interface RowPinDrop {
  id: string;
  index: number | null;
  landed: boolean;
}

/**
 * Pinning by dragging an unpinned row into its list's Pinned group, for a list
 * whose pins are a flag on its own rows (`pinnedPosition`) rather than the
 * shared pin list: a Canvas, a Sidekick. A drop pins the row at the end of the
 * group; a landed row's state clears once the list holds the pin, and goes
 * back if the write fails.
 */
export function useRowPinDrop(pinnedIds: ReadonlySet<string>, pin: (id: string) => Promise<void>): {
  drop: RowPinDrop | null;
  sourceProps: (id: string) => React.HTMLAttributes<HTMLElement> & { draggable: boolean };
  targetProps: React.HTMLAttributes<HTMLElement>;
} {
  const [state, setState] = useState<RowPinDrop | null>(null);
  const drop = state && !pinnedIds.has(state.id) ? state : null;
  const settled = state?.landed === true && pinnedIds.has(state.id);
  useEffect(() => {
    if (settled) setState(null);
  }, [settled]);
  return {
    drop,
    sourceProps: (id) => ({
      draggable: true,
      onDragStart: (event) => {
        event.dataTransfer.effectAllowed = 'move';
        // Chromium will not start a drag with an empty payload.
        event.dataTransfer.setData('text/plain', id);
        setState({ id, index: null, landed: false });
      },
      onDragEnd: () => setState((current) => (current?.landed ? current : null)),
    }),
    targetProps: {
      onDragOver: (event) => {
        if (!drop || drop.landed) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
      },
      onDrop: (event) => {
        if (!drop || drop.landed) return;
        event.preventDefault();
        setState({ ...drop, landed: true });
        pin(drop.id).catch(() => setState((current) => (current?.id === drop.id ? null : current)));
      },
    },
  };
}

/** Pinned first in the order the viewer pinned them; then the list's own order, most recently active first. */
export function splitPinned<T extends { pinnedPosition?: number | null | undefined }>(rows: readonly T[]): { pinned: T[]; rest: T[] } {
  const pinned = rows.filter((row) => row.pinnedPosition != null)
    .sort((left, right) => (left.pinnedPosition ?? 0) - (right.pinnedPosition ?? 0));
  return { pinned, rest: rows.filter((row) => row.pinnedPosition == null) };
}

const NO_CONTAINER: RefObject<HTMLElement | null> = { current: null };

/**
 * A section's list motion: its own over the scroll box, or, inside the Pinned
 * tab, the tab's shared one. Call after `usePinReveal`.
 */
export function useSectionMotion(scroll: RefObject<HTMLElement | null>, shared: (() => void) | undefined): void {
  const own = useListMotionPass(shared ? NO_CONTAINER : scroll);
  const run = shared ?? own;
  useLayoutEffect(() => run());
}

/**
 * The pin write of a list whose pins are a flag on its own rows, and the
 * failure it last met, for the section's notice. The write rethrows, so a drop
 * into Pinned can put the row back.
 */
export function usePinWrite(
  write: ((id: string, pinned: boolean) => Promise<unknown>) | undefined,
  noun: string,
): { error: Error | null; setPinned: (id: string, pinned: boolean) => Promise<void> } {
  const [error, setError] = useState<Error | null>(null);
  const setPinned = useCallback(async (id: string, pinned: boolean): Promise<void> => {
    if (!write) throw new Error('Rally is not connected yet.');
    setError(null);
    try {
      await write(id, pinned);
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error(`The ${noun} could not be pinned.`));
      throw cause;
    }
  }, [noun, write]);
  return { error, setPinned };
}

/**
 * One row of a list whose pins are a flag on its own rows: a link drawn with
 * `RowLayout`, draggable into Pinned while unpinned, and a context menu that
 * pins or unpins it. The section supplies what the row stands for.
 */
export function PinnableRow({ active, className, drag, motionKey, onPin, onRename, pinned, position, to, unread, ...layout }: {
  active: boolean;
  className: string;
  drag: React.HTMLAttributes<HTMLElement>;
  motionKey: string;
  onPin: (pinned: boolean) => void;
  /** Offers Rename… in the row's menu; absent where the row cannot be renamed from here. */
  onRename?: (() => void) | undefined;
  pinned: boolean;
  position: string | undefined;
  to: string;
  unread: boolean;
  detail: ReactNode;
  tile: ReactNode;
  time: ReactNode;
  title: ReactNode;
}): React.JSX.Element {
  return <ContextMenu.Root>
    <ContextMenu.Trigger asChild>
      <Link
        aria-current={active ? 'page' : undefined}
        className={clsx('navigation-row', className, active && 'is-active', unread && 'is-unread')}
        data-motion-key={motionKey}
        to={to}
        {...drag}
      >
        <RowLayout {...layout} unread={unread} />
        {position && <span className="sr-only">{position}</span>}
      </Link>
    </ContextMenu.Trigger>
    <ContextMenu.Portal>
      <ContextMenu.Content className="menu-content">
        <ContextMenu.Item className="menu-item" onSelect={() => onPin(!pinned)}>
          {pinned ? <IconPinnedOff aria-hidden="true" size={15} stroke={1.8} /> : <IconPin aria-hidden="true" size={15} stroke={1.8} />}
          {pinned ? 'Unpin' : 'Pin'}
        </ContextMenu.Item>
        {onRename && <ContextMenu.Item className="menu-item" onSelect={onRename}>
          <IconPencil aria-hidden="true" size={15} stroke={1.8} />
          Rename…
        </ContextMenu.Item>}
      </ContextMenu.Content>
    </ContextMenu.Portal>
  </ContextMenu.Root>;
}
