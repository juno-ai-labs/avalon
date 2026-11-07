import * as ContextMenu from '@radix-ui/react-context-menu';
import { IconPin, IconPinnedOff } from '@tabler/icons-react';
import clsx from 'clsx';
import { useCallback, useLayoutEffect, useMemo, useState, type RefObject } from 'react';
import { Link, matchPath, useLocation } from 'react-router-dom';

import { useCollaborationSession } from '../lib/collaboration-session';
import { formatSidebarActivityTime } from '../lib/format';
import { SIDEBAR_LIST_QUERY_KEYS, useSocketOwnedList } from '../lib/sidebar-list-store';
import type { AutomationSummary } from '../lib/types';
import { useListMotionPass } from '../lib/use-list-motion';
import { PinnedSection, pinnedPosition, RowLayout, SectionHeading, splitPinned, useRowPinDrop } from './navigation-rows';
import { ErrorNotice } from './primitives';
import { RelativeTime } from './relative-time';
import { SidebarSkeletonRows } from './sidebar-skeleton';
import { AutomationGlyph } from './workstream-glyph';

/** This viewer's Sidekicks as the workspace socket keeps them; `undefined` until it has said. */
function useSidekickList(): AutomationSummary[] | undefined {
  return useSocketOwnedList<AutomationSummary>(SIDEBAR_LIST_QUERY_KEYS.automations).data;
}

/** How many Sidekicks wait on someone or hold something unread: the section's badge. */
export function useSidekickAttentionCount(): number {
  return (useSidekickList() ?? []).filter((row) => row.needsInput || row.unread).length;
}

/** A Sidekick row's second line: what it is waiting on, or where it stands. */
function sidekickRowState(row: AutomationSummary): React.ReactNode {
  if (row.needsInput) return 'Needs input';
  if (row.status === 'paused') return 'Paused';
  if (row.status === 'draft') return 'Draft';
  if (row.nextRunAt) return <>Next run <RelativeTime value={row.nextRunAt} /></>;
  return 'Active';
}

/**
 * The Sidekicks section: the Sidekicks waiting on information only a person
 * has (Needs input), then the Pinned group, then every other Sidekick. A row
 * is its hexagon and name, and what it is waiting on or where it stands; an
 * unread row is bold with a red dot. A row dragged into Pinned is pinned
 * (`POST /sidekicks/:id/pin`).
 */
export function SidekicksSection({ scroll }: { scroll: RefObject<HTMLElement | null> }): React.JSX.Element {
  const { api } = useCollaborationSession();
  const rows = useSidekickList();
  const waiting = useMemo(() => (rows ?? []).filter((row) => row.needsInput), [rows]);
  const { pinned, rest } = useMemo(() => splitPinned((rows ?? []).filter((row) => !row.needsInput)), [rows]);
  const pinnedIds = useMemo(() => new Set(pinned.map((row) => row.id)), [pinned]);
  const [pinError, setPinError] = useState<Error | null>(null);
  const setPinned = useCallback(async (id: string, next: boolean): Promise<void> => {
    if (!api) throw new Error('Rally is not connected yet.');
    setPinError(null);
    try {
      await api.setSidekickPinned(id, next);
    } catch (cause) {
      setPinError(cause instanceof Error ? cause : new Error('The Sidekick could not be pinned.'));
      throw cause;
    }
  }, [api]);
  const { drop, sourceProps, targetProps } = useRowPinDrop(pinnedIds, (id) => setPinned(id, true));
  const motion = useListMotionPass(scroll);
  useLayoutEffect(() => motion());
  const { pathname } = useLocation();
  const open = (matchPath('/sidekicks/:id', pathname) ?? matchPath('/automations/:id', pathname))?.params.id;
  const row = (sidekick: AutomationSummary, options: { pinned: boolean; position?: string; draggable: boolean }): React.JSX.Element => <SidekickRow
    active={sidekick.id === open}
    drag={options.draggable ? sourceProps(sidekick.id) : {}}
    key={sidekick.id}
    onPin={(next) => { void setPinned(sidekick.id, next).catch(() => undefined); }}
    pinned={options.pinned}
    position={options.position}
    row={sidekick}
  />;
  return <>
    {pinError && <ErrorNotice occurrence={pinError}>The Sidekick could not be pinned. Try again.</ErrorNotice>}
    {waiting.length > 0 && <section aria-label="Needs input" className="navigation-section">
      <SectionHeading motionKey="needs-input">Needs input</SectionHeading>
      {waiting.map((sidekick) => row(sidekick, { pinned: sidekick.pinnedPosition != null, draggable: false }))}
    </section>}
    <PinnedSection
      count={pinned.length}
      drop={drop}
      label="Pinned Sidekicks"
      loading={rows === undefined}
      noun="Sidekick"
      reorderable={false}
      target={targetProps}
    >
      {pinned.map((sidekick, index) => row(sidekick, { pinned: true, position: pinnedPosition(index, pinned.length), draggable: false }))}
    </PinnedSection>
    <section aria-label="All Sidekicks" className="navigation-section">
      <SectionHeading motionKey="sidekicks">All Sidekicks</SectionHeading>
      {rows === undefined && <SidebarSkeletonRows count={5} hint />}
      {rows !== undefined && rows.length === 0 && <p className="navigation-empty">No Sidekicks yet.</p>}
      {rest.map((sidekick) => row(sidekick, { pinned: false, draggable: true }))}
    </section>
  </>;
}

function SidekickRow({ active, drag, onPin, pinned, position, row }: {
  active: boolean;
  drag: React.HTMLAttributes<HTMLElement>;
  onPin: (pinned: boolean) => void;
  pinned: boolean;
  position: string | undefined;
  row: AutomationSummary;
}): React.JSX.Element {
  const unread = row.unread === true;
  return <ContextMenu.Root>
    <ContextMenu.Trigger asChild>
      <Link
        aria-current={active ? 'page' : undefined}
        className={clsx('navigation-row navigation-sidekick-row', active && 'is-active', unread && 'is-unread')}
        data-motion-key={`sidekick:${row.id}`}
        to={`/sidekicks/${encodeURIComponent(row.id)}`}
        {...drag}
      >
        <RowLayout
          detail={sidekickRowState(row)}
          tile={<span className="navigation-sidekick-mark"><AutomationGlyph {...(row.appearance ? { appearance: row.appearance } : {})} id={row.id} /></span>}
          time={<RelativeTime className="navigation-row-time" format={formatSidebarActivityTime} value={row.lastRunAt ?? row.updatedAt} />}
          title={row.name}
          unread={unread}
        />
        {position && <span className="sr-only">{position}</span>}
      </Link>
    </ContextMenu.Trigger>
    <ContextMenu.Portal>
      <ContextMenu.Content className="menu-content">
        <ContextMenu.Item className="menu-item" onSelect={() => onPin(!pinned)}>
          {pinned ? <IconPinnedOff aria-hidden="true" size={15} stroke={1.8} /> : <IconPin aria-hidden="true" size={15} stroke={1.8} />}
          {pinned ? 'Unpin' : 'Pin'}
        </ContextMenu.Item>
      </ContextMenu.Content>
    </ContextMenu.Portal>
  </ContextMenu.Root>;
}
