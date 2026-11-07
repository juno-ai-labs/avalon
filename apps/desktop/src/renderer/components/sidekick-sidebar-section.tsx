import { useMemo, type RefObject } from 'react';
import { matchPath, useLocation } from 'react-router-dom';

import { useCollaborationSession } from '../lib/collaboration-session';
import { formatSidebarActivityTime } from '../lib/format';
import { SIDEBAR_LIST_QUERY_KEYS, useSocketOwnedList } from '../lib/sidebar-list-store';
import type { AutomationSummary } from '../lib/types';
import { PinnableRow, PinnedSection, pinnedPosition, SectionHeading, splitPinned, usePinWrite, useRowPinDrop, useSectionMotion } from './navigation-rows';
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
  const { error: pinError, setPinned } = usePinWrite(api ? (id, next) => api.setSidekickPinned(id, next) : undefined, 'Sidekick');
  const { drop, sourceProps, targetProps } = useRowPinDrop(pinnedIds, (id) => setPinned(id, true));
  useSectionMotion(scroll, undefined);
  const { pathname } = useLocation();
  const open = (matchPath('/sidekicks/:id', pathname) ?? matchPath('/automations/:id', pathname))?.params.id;
  const row = (sidekick: AutomationSummary, options: { pinned: boolean; position?: string; draggable: boolean }): React.JSX.Element => <PinnableRow
    active={sidekick.id === open}
    className="navigation-sidekick-row"
    detail={sidekickRowState(sidekick)}
    drag={options.draggable ? sourceProps(sidekick.id) : {}}
    key={sidekick.id}
    motionKey={`sidekick:${sidekick.id}`}
    onPin={(next) => { void setPinned(sidekick.id, next).catch(() => undefined); }}
    pinned={options.pinned}
    position={options.position}
    tile={<span className="navigation-sidekick-mark"><AutomationGlyph {...(sidekick.appearance ? { appearance: sidekick.appearance } : {})} id={sidekick.id} /></span>}
    time={<RelativeTime className="navigation-row-time" format={formatSidebarActivityTime} value={sidekick.lastRunAt ?? sidekick.updatedAt} />}
    title={sidekick.name}
    to={`/sidekicks/${encodeURIComponent(sidekick.id)}`}
    unread={sidekick.unread === true}
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
