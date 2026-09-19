import { IconPlus } from '@tabler/icons-react';
import clsx from 'clsx';
import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import {
  type ContainerOrder,
  type CreateSpaceRequest,
  type PersonalOrder,
  type SpaceColorKey,
  type SpaceIconKey,
  type SpaceSummary,
} from '@rally/contracts';
import { SpaceAppearancePicker, SpaceIcon } from '@rally/ui/components/space-appearance-picker';
import { SpacePlacementList, SpaceRow, SpaceRowContent } from '@rally/ui/components/space-row';
import { SPACE_SCOPE_OPTIONS } from '@rally/ui/components/space-dashboard';

import { compareWorkstreamRecency } from '../lib/format';
import { moveWithin, orderByStoredIds, storedOrderFor } from '../lib/personal-order';
import { PROJECT_COLOR_DEFAULT } from '../lib/project-palette';
import { spaceFailureSentence } from '../lib/space-failure-copy';
import { Button, DropdownSelect, IconButton, InlineError, Modal } from './primitives';
import { SidebarSkeletonRows } from './sidebar-skeleton';
import type { WorkstreamRowDrag } from './sidebar';
import type { WorkstreamSummary } from '../lib/types';

/**
 * What this section says when the server named no Space refusal of its own.
 *
 * The same rule the Projects section it replaces was put under: a Space action
 * shares persistent navigation with unrelated requests, so a server diagnostic
 * rendered here reads as Space content long after the action that was refused.
 * A named refusal goes through `spaceFailureCopy` with every other Space
 * surface; these two are what is left when there is no code to name — and they
 * say more than the shared sentence can, because "Spaces couldn't be
 * reordered" also accounts for the row that just snapped back.
 */
const spaceSectionFallbackCopy = {
  reorder: 'Spaces couldn’t be reordered.',
  reorder_channels: 'The channels in that space couldn’t be reordered.',
  add_channel: 'That channel couldn’t be added to the space.',
} as const;

/** The transfer type a Channel row writes, and the only one a Space accepts. */
const CHANNEL_DRAG_TYPE = 'application/x-rally-workstream-id';

/**
 * The Organization is still creating General and placing every Channel in it.
 *
 * Shown instead of the hierarchy rather than beside it: a Space directory
 * missing General, or a Channel with no Space, is not a state any surface is
 * allowed to render, so there is nothing truthful to show underneath.
 */
export function SpacesOpeningCard({ className }: { className?: string }): React.JSX.Element {
  return (
    <div className={clsx('space-opening-card', className)} role="status">
      <span>Rally is opening this organization. Spaces appear once every channel has one.</span>
    </div>
  );
}

interface SpaceSidebarSectionProps {
  spaces: SpaceSummary[];
  inactiveSpaces: SpaceSummary[];
  workstreams: WorkstreamSummary[];
  loading: boolean;
  /** False while the Organization has not finished its one-time cutover. */
  ready: boolean;
  /**
   * The rows on screen are the last ones the socket delivered and a refresh
   * failed. They stay — an emptier sidebar is a worse lie than a stale one —
   * and say so.
   */
  outOfDate: boolean;
  onRetry: () => void;
  onCreate: (input: CreateSpaceRequest) => Promise<SpaceSummary>;
  onAddChannel: (spaceId: string, workstreamId: string) => Promise<void>;
  /** One write for both lists this section arranges; see {@link ContainerOrder}. */
  onReorder: (order: ContainerOrder) => Promise<void>;
  /** Every list this person has arranged, including the two drawn here. */
  ordering: PersonalOrder;
  /**
   * The Organization, which is the container the Space list belongs to.
   *
   * Named rather than implied, so an order row says what it is about without
   * the object it is stored in being part of its key.
   */
  workspaceId: string;
  onRestore: (spaceId: string) => Promise<void>;
  /**
   * Placements use the same row the rest of the sidebar does — and, inside an
   * expanded Space, the same drag the pinned list uses.
   */
  renderWorkstream: (workstream: WorkstreamSummary, drag?: WorkstreamRowDrag) => ReactNode;
}

/**
 * The Organization's Spaces, and the Channels placed in each one.
 *
 * Always drawn, in every shell: every Channel belongs to at least one Space, so
 * a sidebar without this section would be a sidebar that cannot say where
 * anything lives. General is in the directory like any other Space and needs no
 * case here.
 *
 * A placement is not a copy. The rows under an expanded Space come from the
 * same work-stream list the sections below render, filtered by the Channel's
 * own `spaceIds`, and go through the same `renderWorkstream` — so a Channel in
 * two Spaces is one record shown twice, with one unread state and one
 * destination.
 */
export function SpaceSidebarSection({
  spaces,
  inactiveSpaces,
  workstreams,
  loading,
  ready,
  outOfDate,
  onRetry,
  onCreate,
  onAddChannel,
  onReorder,
  ordering,
  workspaceId,
  onRestore,
  renderWorkstream,
}: SpaceSidebarSectionProps): React.JSX.Element {
  const location = useLocation();
  const navigate = useNavigate();
  // Expansion follows the route: a Space whose dashboard is open is expanded,
  // however the route got there — a click, a deep link, a restore, Back or
  // Forward. This map holds only the exceptions a reader made by hand, so a
  // Space expanded without opening it stays open, and the open one they
  // collapsed stays shut.
  const [expansion, setExpansion] = useState<Record<string, boolean>>({});
  const [createOpen, setCreateOpen] = useState(false);
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const [name, setName] = useState('');
  const [iconKey, setIconKey] = useState<SpaceIconKey>('briefcase');
  const [colorKey, setColorKey] = useState<SpaceColorKey>(PROJECT_COLOR_DEFAULT);
  const [scope, setScope] = useState<'personal' | 'workspace'>('personal');
  const [saving, setSaving] = useState(false);
  const [modalFailure, setModalFailure] = useState<'create' | 'restore' | null>(null);
  const [sectionFailure, setSectionFailure] = useState<string | null>(null);
  const [dragOrder, setDragOrder] = useState<string[] | null>(null);
  const dragging = useRef<string | null>(null);
  /**
   * The arrangement a Channel drag is building inside one Space's placements,
   * and which Space's it is.
   *
   * `dropped` is what tells a reorder from a placement. `dragend` fires on the
   * row the drag started from wherever it ended, so without it a Channel
   * dragged out of this Space onto another would also commit the arrangement
   * the pointer happened to build inside this list on its way out.
   */
  const [placementOrder, setPlacementOrder] = useState<{ spaceId: string; ids: string[] } | null>(null);
  const placementDrag = useRef<{ spaceId: string; workstreamId: string; dropped: boolean } | null>(null);
  const spaceContainer = { kind: 'organization' as const, id: workspaceId };
  // The Space directory arrives already sorted by these same rows, and is
  // arranged here anyway: it is what makes a drag something this component can
  // show before the server has answered, and what makes all three hand-ordered
  // lists one rule rather than one rule and one convention.
  const storedSpaceIds = orderByStoredIds(
    spaces,
    storedOrderFor(ordering, spaceContainer),
    (space) => space.id,
  ).map((space) => space.id);
  // Two orders, and the difference between them is what a drop commits: the
  // one the server last confirmed, and the one the pointer is building on top
  // of it. Comparing a finished drag against the second would compare it with
  // itself and conclude nothing moved.
  const ordered = orderByStoredIds(spaces, dragOrder ?? storedSpaceIds, (space) => space.id);
  const openSpaceId = /^\/spaces\/([^/]+)/u.exec(location.pathname)?.[1] ?? null;
  // Opening a Space's dashboard expands its row even if it was collapsed by
  // hand the last time it was open: the exception was about that visit.
  useEffect(() => {
    if (openSpaceId === null) return;
    setExpansion((current) => {
      const next = { ...current };
      delete next[openSpaceId];
      return next;
    });
  }, [openSpaceId]);

  const closeCreate = (): void => {
    if (saving) return;
    setCreateOpen(false);
    setName('');
    setIconKey('briefcase');
    setColorKey(PROJECT_COLOR_DEFAULT);
    setScope('personal');
    setModalFailure(null);
  };

  const submit = async (): Promise<void> => {
    if (!name.trim() || saving) return;
    setSaving(true);
    setModalFailure(null);
    try {
      const created = await onCreate({ name: name.trim(), iconKey, colorKey, scope });
      setSaving(false);
      closeCreate();
      void navigate(`/spaces/${created.id}`);
    } catch {
      setModalFailure('create');
      setSaving(false);
    }
  };

  const commit = async (ids: string[]): Promise<void> => {
    setDragOrder(ids);
    setSectionFailure(null);
    try {
      await onReorder({ container: spaceContainer, itemIds: ids });
    } catch (cause) {
      // The arrangement is dropped rather than kept: the section then shows
      // what the server actually holds, which is what this person's other
      // windows are showing.
      setSectionFailure(spaceFailureSentence(cause, spaceSectionFallbackCopy.reorder));
    } finally {
      setDragOrder(null);
    }
  };

  const commitPlacements = async (spaceId: string, ids: string[]): Promise<void> => {
    setPlacementOrder({ spaceId, ids });
    setSectionFailure(null);
    try {
      await onReorder({ container: { kind: 'space', id: spaceId }, itemIds: ids });
    } catch (cause) {
      setSectionFailure(spaceFailureSentence(cause, spaceSectionFallbackCopy.reorder_channels));
    } finally {
      // Only while this call's arrangement is the one on screen. Two moves in
      // quick succession overlap, and clearing unconditionally would snap the
      // list back to an order the second has already moved past.
      setPlacementOrder((current) =>
        current?.spaceId === spaceId && current.ids === ids ? null : current);
    }
  };

  const setOpen = (spaceId: string, open: boolean): void =>
    setExpansion((current) => ({ ...current, [spaceId]: open }));

  return (
    <>
      <section aria-labelledby="spaces-heading" className="sidebar-section spaces-section">
        <div className="sidebar-section-heading">
          <h2 id="spaces-heading">Spaces</h2>
          {/* Nothing to create into while the Organization is still opening;
              the server refuses it with `space_bootstrap_pending`, and a
              control that can only fail is worse than one that is not there. */}
          {ready && <IconButton className="space-sidebar-action" label="New space" onClick={() => { setModalFailure(null); setCreateOpen(true); }}>
            <IconPlus size={15} stroke={1.8} />
          </IconButton>}
        </div>
        {!ready ? (
          <SpacesOpeningCard />
        ) : loading && spaces.length === 0 ? (
          // The same placeholder rows the lists below use. Spaces arrive on the
          // same answer they do, so a line of prose here read as a third kind
          // of wait next to two sections already showing their shape.
          <SidebarSkeletonRows count={3} />
        ) : spaces.length === 0 ? (
          <p className="sidebar-empty">No spaces yet</p>
        ) : (
          <div aria-describedby="spaces-reorder-help" className="sidebar-list">
            {/* Said once for the whole section rather than on every row: as a
                per-row description it lands inside each link's accessible
                name, so somebody arrowing through hears the instruction again
                before every title. Both lists here are arranged the same way,
                so it is one sentence about both. */}
            <p className="sr-only" id="spaces-reorder-help">
              Hold Alt and press the up or down arrow to move a space, or a channel within its space.
            </p>
            {outOfDate && (
              <div className="space-sidebar-stale">
                <p role="status">These spaces may be out of date.</p>
                <Button onClick={onRetry}>Try again</Button>
              </div>
            )}
            {ordered.map((space, index) => {
              const destination = `/spaces/${space.id}`;
              const active = location.pathname === destination || location.pathname.startsWith(`${destination}/`);
              const isExpanded = expansion[space.id] ?? active;
              // Recency is the natural order of a placement list, and the
              // arrangement this person committed goes in front of it: a
              // Channel they never dragged keeps moving up as it is used, and
              // one they did stays where they put it.
              const natural = workstreams
                .filter((workstream) => workstream.spaceIds.includes(space.id))
                .sort(compareWorkstreamRecency);
              // Two orders, and the difference between them is what a drop
              // commits: the one the server last confirmed, and the one the
              // pointer is building on top of it. Comparing a finished drag
              // against the second would compare it with itself and conclude
              // nothing moved.
              const stored = orderByStoredIds(
                natural,
                storedOrderFor(ordering, { kind: 'space', id: space.id }),
                (workstream) => workstream.id,
              ).map((workstream) => workstream.id);
              const placements = placementOrder?.spaceId === space.id
                ? orderByStoredIds(natural, placementOrder.ids, (workstream) => workstream.id)
                : orderByStoredIds(natural, stored, (workstream) => workstream.id);
              const placementIds = placements.map((workstream) => workstream.id);
              const placementRowDrag = (
                workstream: WorkstreamSummary,
                placementIndex: number,
              ): WorkstreamRowDrag => ({
                dragging: placementDrag.current?.workstreamId === workstream.id
                  && placementDrag.current.spaceId === space.id
                  && placementOrder?.spaceId === space.id,
                position: `In ${space.name}, ${placementIndex + 1} of ${placements.length}.`,
                onDragStart: (target) => {
                  placementDrag.current = { spaceId: space.id, workstreamId: target.id, dropped: false };
                  setPlacementOrder({ spaceId: space.id, ids: placementIds });
                },
                onDragOver: (targetId) => {
                  const current = placementDrag.current;
                  // Only a Channel that belongs to *this* list moves rows in
                  // it. One arriving from another Space is a placement being
                  // dropped here, and rearranging this list under it would
                  // leave an order built around a row that is not in it.
                  if (current === null || current.spaceId !== space.id) return;
                  if (current.workstreamId === targetId) return;
                  setPlacementOrder((held) => {
                    const ids = held?.spaceId === space.id ? held.ids : placementIds;
                    const targetPosition = ids.indexOf(targetId);
                    if (targetPosition < 0 || ids.indexOf(current.workstreamId) === targetPosition) {
                      return held;
                    }
                    return { spaceId: space.id, ids: moveWithin(ids, current.workstreamId, targetPosition) };
                  });
                },
                onDrop: () => {
                  const current = placementDrag.current;
                  if (current === null || current.spaceId !== space.id) return false;
                  placementDrag.current = { ...current, dropped: true };
                  return true;
                },
                onDragEnd: (cancelled) => {
                  const current = placementDrag.current;
                  const held = placementOrder?.spaceId === space.id ? placementOrder.ids : null;
                  placementDrag.current = null;
                  if (held === null) return;
                  // A release outside this list is the other meaning of the
                  // same gesture — put this Channel in that Space — and the
                  // Space row underneath has already taken it. Escape is the
                  // third: backing out of a drag must not be the same thing as
                  // finishing it.
                  if (cancelled || current?.dropped !== true || held.join() === stored.join()) {
                    setPlacementOrder(null);
                    return;
                  }
                  void commitPlacements(space.id, held);
                },
                onMove: (target, direction) => {
                  const from = placementIds.indexOf(target.id);
                  const to = from + direction;
                  if (from < 0 || to < 0 || to >= placementIds.length) return;
                  void commitPlacements(space.id, moveWithin(placementIds, target.id, to));
                },
              });
              return (
                <SpaceRow
                  active={active}
                  drag={{
                    onDragEnd: () => {
                      const ids = dragOrder ?? storedSpaceIds;
                      dragging.current = null;
                      if (ids.join() !== storedSpaceIds.join()) void commit(ids);
                      else setDragOrder(null);
                    },
                    onDragEnter: (event) => {
                      event.preventDefault();
                      const dragged = dragging.current;
                      if (!dragged || dragged === space.id) return;
                      setDragOrder((current) => moveWithin(current ?? ordered.map((item) => item.id), dragged, index));
                    },
                    onDragStart: (event) => {
                      // A Channel dragged out of this Space's placement list
                      // starts its drag on a row *inside* this item, and the
                      // event bubbles here. Without this the Space enters a
                      // reorder at the same time, so dropping the Channel on
                      // another Space both placed it and moved the Space it
                      // came from.
                      if (event.dataTransfer.types.includes(CHANNEL_DRAG_TYPE)) return;
                      dragging.current = space.id;
                      setDragOrder(ordered.map((item) => item.id));
                      event.dataTransfer.effectAllowed = 'move';
                      event.dataTransfer.setData('application/x-rally-space-id', space.id);
                    },
                    onDrop: (event) => {
                      const workstreamId = event.dataTransfer.getData(CHANNEL_DRAG_TYPE);
                      if (!workstreamId) return;
                      event.preventDefault();
                      event.stopPropagation();
                      dragging.current = null;
                      setSectionFailure(null);
                      // The two meanings of one gesture, told apart by where
                      // the Channel already is: a release inside the list it
                      // is in is a reorder, which the rows have already
                      // handled and whose event never reaches here, and a
                      // release anywhere else on a Space is a placement. A
                      // Channel dropped on a Space it is already in is neither
                      // — it is a drag that changed nothing.
                      if (placementIds.includes(workstreamId)) return;
                      void onAddChannel(space.id, workstreamId).catch((cause: unknown) => {
                        setSectionFailure(spaceFailureSentence(cause, spaceSectionFallbackCopy.add_channel));
                      });
                    },
                  }}
                  expanded={isExpanded}
                  key={space.id}
                  link={(
                    <NavLink
                      className={({ isActive }: { isActive: boolean }) => clsx('space-row-link', isActive && 'is-active')}
                      // Opening a Space selects its dashboard, and the route
                      // is what expands its row; clicking the row you are
                      // already on is the one way to close it again.
                      onClick={() => { if (active && isExpanded) setOpen(space.id, false); }}
                      to={destination}
                    >
                      <SpaceRowContent space={space} />
                    </NavLink>
                  )}
                  newChannelLabel={`New channel in ${space.name}`}
                  onNewChannel={() => void navigate(`${destination}/workstreams/new`)}
                  onRowKeyDown={(event) => {
                    // Alt rather than a bare arrow: the arrows move focus
                    // through the sidebar, and a Space must stay reachable by
                    // somebody who is reading rather than rearranging.
                    if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
                    event.preventDefault();
                    const to = event.key === 'ArrowUp' ? index - 1 : index + 1;
                    if (to < 0 || to >= ordered.length) return;
                    void commit(moveWithin(ordered.map((item) => item.id), space.id, to));
                  }}
                  onToggleExpanded={() => setOpen(space.id, !isExpanded)}
                  space={space}
                >
                  {/* The sidebar holds one page of the Organization's
                      Channels, so an expansion can list fewer than the Space
                      has. The count is not viewer-scoped and cannot be shown
                      as a number, but it is enough to keep a Space that holds
                      Channels this device has not loaded from claiming to be
                      empty. */}
                  {isExpanded && (placements.length === 0 && space.channelCount === 0
                    ? <p className="space-sidebar-empty">No channels</p>
                    : <SpacePlacementList spaceId={space.id}>
                      {placements.map((workstream, placementIndex) => (
                        <Fragment key={workstream.id}>
                          {renderWorkstream(workstream, placementRowDrag(workstream, placementIndex))}
                        </Fragment>
                      ))}
                    </SpacePlacementList>)}
                </SpaceRow>
              );
            })}
          </div>
        )}
        {sectionFailure && <InlineError>{sectionFailure}</InlineError>}
      </section>
      <Modal
        footer={<>
          {inactiveSpaces.length > 0 && <Button disabled={saving} onClick={() => { closeCreate(); setRecoveryOpen(true); }}>Restore archived space</Button>}
          <Button disabled={saving} onClick={closeCreate}>Cancel</Button>
          <Button className="button-primary" disabled={saving || !name.trim()} onClick={() => void submit()}>Create space</Button>
        </>}
        onOpenChange={(open) => open ? setCreateOpen(true) : closeCreate()}
        open={createOpen}
        title="New space"
      >
        <form className="space-create-form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
          <label className="form-field">
            <span>Name</span>
            <input autoFocus onChange={(event) => setName(event.target.value)} value={name} />
          </label>
          <SpaceAppearancePicker colorKey={colorKey} iconKey={iconKey} onColorChange={setColorKey} onIconChange={setIconKey} />
          <div className="form-field">
            <span>Who can see this space?</span>
            <DropdownSelect
              ariaLabel="Space audience"
              onValueChange={(value) => setScope(value as 'personal' | 'workspace')}
              options={[...SPACE_SCOPE_OPTIONS]}
              value={scope}
            />
          </div>
          {modalFailure === 'create' && <InlineError>The space couldn’t be created.</InlineError>}
        </form>
      </Modal>
      <Modal
        footer={<Button onClick={() => { setModalFailure(null); setRecoveryOpen(false); }}>Cancel</Button>}
        onOpenChange={(open) => { if (!open) setModalFailure(null); setRecoveryOpen(open); }}
        open={recoveryOpen}
        title="Restore archived space"
      >
        <div className="space-recovery-list">{inactiveSpaces.map((space) => (
          <Button key={space.id} onClick={() => {
            setModalFailure(null);
            void onRestore(space.id)
              .then(() => { setRecoveryOpen(false); void navigate(`/spaces/${space.id}`); })
              .catch(() => setModalFailure('restore'));
          }}><SpaceIcon space={space} /> {space.name}</Button>
        ))}</div>
        {modalFailure === 'restore' && <InlineError>The space couldn’t be restored.</InlineError>}
      </Modal>
    </>
  );
}
