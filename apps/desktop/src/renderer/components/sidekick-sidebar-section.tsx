import { ArrowDownUp } from 'lucide-react';
import { useMemo, useState, type RefObject } from 'react';
import { matchPath, useLocation } from 'react-router-dom';

import { useCollaborationSession } from '../lib/collaboration-session';
import { formatSidebarActivityTime } from '../lib/format';
import { formatNextRun, sidekickActivityAt, sidekickStatus } from '../lib/sidekick-status';
import { SIDEBAR_LIST_QUERY_KEYS, useSocketOwnedList } from '../lib/sidebar-list-store';
import type { AutomationSummary } from '../lib/types';
import { PinnableRow, PinnedSection, pinnedPosition, SectionHeading, splitPinned, usePinWrite, useRowPinDrop, useSectionMotion } from './navigation-rows';
import { DropdownSelect, ErrorNotice } from './primitives';
import { RelativeTime } from './relative-time';
import { SidebarListDown, usePushedListsDown } from './pushed-list-pending';
import { SidebarSkeletonRows } from './sidebar-skeleton';
import { AutomationGlyph } from './workstream-glyph';

/** This viewer's Sidekicks as the workspace socket keeps them; `undefined` until it has said. */
export function useSidekickList(): AutomationSummary[] | undefined {
  return useSocketOwnedList<AutomationSummary[]>(SIDEBAR_LIST_QUERY_KEYS.automations).data;
}

/**
 * A Sidekick row's second line, the state the PRD names: the question it is
 * waiting on, a run under way, paused, or when it next runs; else when it
 * last ran.
 */
function sidekickRowState(row: AutomationSummary): React.ReactNode {
  switch (sidekickStatus(row)) {
    case 'needs_input': return row.pendingQuestion ?? 'Needs input';
    case 'working': return <><span aria-hidden="true" className="sidekick-working-dot" />Working</>;
    case 'paused': return <span className="sidekick-row-paused">Paused</span>;
    case 'draft': return 'Draft';
    case 'active':
      if (row.nextRunAt) return `Runs ${formatNextRun(row.nextRunAt, 'long')}`;
      if (row.lastRunAt) return <>Last run <RelativeTime value={row.lastRunAt} /></>;
      return 'Active';
  }
}

type SidekickOrder = 'recent' | 'name';

/** design.html §3's "Recent ⇵": by what each last did, or by name. */
const SIDEKICK_ORDERS = [{ value: 'recent', label: 'Recent' }, { value: 'name', label: 'Name' }];

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
  // A socket that cannot open would leave the placeholders up for ever.
  const down = usePushedListsDown() && rows === undefined;
  const waiting = useMemo(() => (rows ?? []).filter((row) => row.needsInput), [rows]);
  const { pinned, rest } = useMemo(() => splitPinned((rows ?? []).filter((row) => !row.needsInput)), [rows]);
  const [order, setOrder] = useState<SidekickOrder>('recent');
  const sorted = useMemo(() => [...rest].sort(order === 'name'
    ? (a, b) => a.name.localeCompare(b.name)
    : (a, b) => sidekickActivityAt(b).localeCompare(sidekickActivityAt(a))), [order, rest]);
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
    time={<RelativeTime className="navigation-row-time" format={formatSidebarActivityTime} value={sidekickActivityAt(sidekick)} />}
    title={sidekick.name}
    to={`/sidekicks/${encodeURIComponent(sidekick.id)}`}
    // The server's unread, as the Canvas rows take it; a Sidekick waiting on
    // someone also carries the dot, as design §3 draws it.
    unread={sidekick.unread === true || sidekickStatus(sidekick) === 'needs_input'}
  />;
  return <>
    {pinError && <ErrorNotice occurrence={pinError}>The Sidekick could not be pinned. Try again.</ErrorNotice>}
    {waiting.length > 0 && <section aria-label="Needs input" className="navigation-section">
      <SectionHeading comesAndGoes motionKey="needs-input">Needs input</SectionHeading>
      {waiting.map((sidekick) => row(sidekick, { pinned: sidekick.pinnedPosition != null, draggable: false }))}
    </section>}
    <PinnedSection
      count={pinned.length}
      drop={drop}
      label="Pinned Sidekicks"
      loading={rows === undefined && !down}
      noun="Sidekick"
      reorderable={false}
      target={targetProps}
    >
      {pinned.map((sidekick, index) => row(sidekick, { pinned: true, position: pinnedPosition(index, pinned.length), draggable: false }))}
    </PinnedSection>
    <section aria-label="All Sidekicks" className="navigation-section">
      <SectionHeading
        motionKey="sidekicks"
        trailing={<DropdownSelect ariaLabel="Sort Sidekicks" icon={<ArrowDownUp aria-hidden="true" size={12} strokeWidth={1.8} />} onValueChange={(value) => setOrder(value === 'name' ? 'name' : 'recent')} options={SIDEKICK_ORDERS} value={order} variant="secondary" />}
      >All Sidekicks</SectionHeading>
      {rows === undefined && <SidebarSkeletonRows count={5} hint />}
      {rows !== undefined && rows.length === 0 && <p className="navigation-empty">No Sidekicks yet.</p>}
      {sorted.map((sidekick) => row(sidekick, { pinned: false, draggable: true }))}
    </section>
  </>;
}
