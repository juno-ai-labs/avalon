import { IconArchive, IconRestore } from '@tabler/icons-react';
import * as ContextMenu from '@radix-ui/react-context-menu';
import clsx from 'clsx';
import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import {
  type ContainerOrder,
  type PersonalOrder,
  type SpaceSummary,
} from '@rally/contracts';
import { SpaceIcon } from '@rally/ui/components/space-icon';
import { SidebarRefreshRow } from '@rally/ui/components/sidebar-refresh-row';
import { SpacePlacementList, SpaceRow, SpaceRowContent } from '@rally/ui/components/space-row';
import { SidebarList } from '@rally/ui/components/resizable-sidebar';

import { compareWorkstreamRecency } from '../lib/format';
import { committedOrder, moveWithin, orderByStoredIds, storedOrderFor } from '../lib/personal-order';
import { blockedChannelLabel, spaceFailureSentence, spaceRefusalChannelIds } from '../lib/space-failure-copy';
import { Button, IconButton, InlineError, Modal } from './primitives';
import { AcknowledgedErrorDialog, type AcknowledgedError } from './acknowledged-error-dialog';
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
 * surface; these action-specific fallbacks are what is left when there is no
 * code to name. The title says what failed, while the acknowledged dialog's
 * copy says what happened to the optimistic row or placement.
 */
const spaceSectionFailure = {
  reorder: {
    title: 'Spaces could not be reordered',
    copy: 'The spaces are back in the order they were in. Try again in a moment.',
  },
  reorder_channels: {
    title: 'Channels could not be reordered',
    copy: 'The channels in that space are back in the order they were in. Try again in a moment.',
  },
  add_channel: {
    title: 'Channel could not be added to that space',
    copy: 'The channel is still in the spaces it was in. Try again in a moment.',
  },
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
   * beside a normal refresh action.
   */
  outOfDate: boolean;
  onRetry: () => void;
  onAddChannel: (spaceId: string, workstreamId: string) => Promise<void>;
  /** One write for both lists this section arranges; see {@link ContainerOrder}. */
  onReorder: (order: ContainerOrder) => Promise<void>;
  /** Every list this person has arranged, including the two drawn here. */
  ordering: PersonalOrder;
  onRestore: (spaceId: string) => Promise<void>;
  /** Omitted until this device has a live Space directory to mutate. */
  onArchive?: ((spaceId: string) => Promise<void>) | undefined;
  /**
   * The Organization's Channel list is paged, and an expanded Space is the one
   * surface that can say the page in hand is not enough.
   *
   * The sidebar's own trigger is the nav's scroll, which reached the end of the
   * time-grouped list of every Channel. That list is gone for a member, so
   * their nav is short and the scroll rarely gets near the bottom: a Space
   * holding 60 Channels would list the 43 that happened to be on page one and
   * offer no way to ask for the rest. `channelCount` is the Organization's
   * count rather than this viewer's, so "short" is not proof anything is
   * missing — but it is enough to keep asking while pages remain, and pages
   * running out is what stops it.
   */
  hasMoreChannels: boolean;
  loadingMoreChannels: boolean;
  onLoadMoreChannels?: (() => void) | undefined;
  /**
   * Placements use the same row the rest of the sidebar does — and, inside an
   * expanded Space, the same drag the pinned list uses.
   */
  renderWorkstream: (
    workstream: WorkstreamSummary,
    drag?: WorkstreamRowDrag,
    placementSpaceId?: string,
  ) => ReactNode;
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
  onAddChannel,
  onReorder,
  ordering,
  onRestore,
  onArchive,
  hasMoreChannels,
  loadingMoreChannels,
  onLoadMoreChannels,
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
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const [restoreFailed, setRestoreFailed] = useState(false);
  const [archiveTarget, setArchiveTarget] = useState<SpaceSummary | null>(null);
  const [archiveFailure, setArchiveFailure] = useState<string | null>(null);
  const [archiveSaving, setArchiveSaving] = useState(false);
  const currentArchiveTarget = archiveTarget === null
    ? null
    : spaces.find((space) => space.id === archiveTarget.id) ?? null;
  const archiveUnavailableSentence = archiveTarget === null
    ? null
    : onArchive === undefined
      ? 'The space directory is unavailable. Reconnect and try again.'
      : currentArchiveTarget === null
          || currentArchiveTarget.reach === 'through_channel'
          || currentArchiveTarget.systemRole === 'general'
        ? 'This space is no longer available to archive.'
        : null;
  const [blockedChannelIds, setBlockedChannelIds] = useState<string[]>([]);
  const [sectionFailure, setSectionFailure] = useState<AcknowledgedError | null>(null);
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
  const spaceContainer = { kind: 'organization' as const };
  // Restoring a Space is a write, so the list offers only the ones this person
  // could actually restore. An archive stages every membership out of `active`
  // before it commits, so today nothing reaches this list by the third
  // visibility clause — but `listInactive` renders the predicate anyway so a
  // change to what an archive stages carries, and if one ever does, a row here
  // is a control that can only fail: `canEdit` refuses the restore, which is
  // the case removed from every other Space surface in this file.
  const restorableSpaces = inactiveSpaces.filter((space) => space.reach !== 'through_channel');
  // The Space directory arrives already sorted by these same rows, and is
  // arranged here anyway: it is what makes a drag something this component can
  // show before the server has answered, and what makes all three hand-ordered
  // lists one rule rather than one rule and one convention.
  const storedSpaces = orderByStoredIds(
    spaces,
    storedOrderFor(ordering, spaceContainer),
    (space) => space.id,
  );
  const storedSpaceIds = storedSpaces.map((space) => space.id);
  // Two orders, and the difference between them is what a drop commits: the
  // one the server last confirmed, and the one the pointer is building on top
  // of it. Comparing a finished drag against the second would compare it with
  // itself and conclude nothing moved. The rule is applied once — running it
  // again over its own output is idempotent and reads as a second rule.
  const ordered = dragOrder === null
    ? storedSpaces
    : orderByStoredIds(spaces, dragOrder, (space) => space.id);
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

  /** Whether this Space's placements are drawn, which is the route unless a reader said otherwise. */
  const isOpen = (space: SpaceSummary): boolean =>
    expansion[space.id] ?? (location.pathname === `/spaces/${space.id}`
      || location.pathname.startsWith(`/spaces/${space.id}/`));
  // An expanded Space listing fewer Channels than the Organization says it
  // holds. Not proof that a page is missing — the count is not viewer-scoped —
  // and it does not have to be: what it costs is asking for a page that turns
  // out to hold nothing for this Space, and what stops it is running out of
  // pages rather than the count ever being reached.
  const expandedShortOfPages = ordered.some((space) => isOpen(space)
    && workstreams.filter((workstream) => workstream.spaceIds.includes(space.id)).length
      < space.channelCount);
  const expandedPageKey = `${ordered.filter(isOpen).map((space) => space.id).join(',')}:${workstreams.length}`;
  const lastAutomaticPage = useRef<string | null>(null);
  useEffect(() => {
    // Guarded on the in-flight flag as well as on the cursor: each page that
    // arrives runs this again, and without it the same page would be asked for
    // once per render until the first answer landed.
    if (!expandedShortOfPages || !hasMoreChannels || loadingMoreChannels
      || lastAutomaticPage.current === expandedPageKey) return;
    lastAutomaticPage.current = expandedPageKey;
    onLoadMoreChannels?.();
  }, [expandedPageKey, expandedShortOfPages, hasMoreChannels, loadingMoreChannels, onLoadMoreChannels]);

  const closeArchive = (): void => {
    if (archiveSaving) return;
    setArchiveTarget(null);
    setArchiveFailure(null);
    setBlockedChannelIds([]);
  };

  const submitArchive = async (): Promise<void> => {
    if (archiveTarget === null || onArchive === undefined
      || archiveUnavailableSentence !== null || archiveSaving) return;
    setArchiveSaving(true);
    setArchiveFailure(null);
    setBlockedChannelIds([]);
    try {
      await onArchive(archiveTarget.id);
      setArchiveTarget(null);
    } catch (cause) {
      setBlockedChannelIds(spaceRefusalChannelIds(cause));
      setArchiveFailure(spaceFailureSentence(cause, 'The space could not be archived.'));
    } finally {
      setArchiveSaving(false);
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
      setSectionFailure({
        title: spaceSectionFailure.reorder.title,
        copy: spaceFailureSentence(cause, spaceSectionFailure.reorder.copy),
      });
    } finally {
      // Only while this call's arrangement is the one on screen. Two moves in
      // quick succession overlap — two Alt+Arrows on a focused row is one
      // gesture to a reader — and clearing unconditionally would flash the
      // list back to an order the second has already moved past.
      setDragOrder((current) => current === ids ? null : current);
    }
  };

  const commitPlacements = async (spaceId: string, ids: string[]): Promise<void> => {
    setPlacementOrder({ spaceId, ids });
    setSectionFailure(null);
    try {
      await onReorder({ container: { kind: 'space', id: spaceId }, itemIds: ids });
    } catch (cause) {
      setSectionFailure({
        title: spaceSectionFailure.reorder_channels.title,
        copy: spaceFailureSentence(cause, spaceSectionFailure.reorder_channels.copy),
      });
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
      {/*
        The whole section is the drop target, heading included — the rule the
        pinned list is already under. A release anywhere a reader would call
        "inside the list they are arranging" has to count as a drop, because
        `dragend` now reads a release nothing accepted as a cancellation: the
        gap between two rows, or the strip of heading above the first one,
        would otherwise throw the arrangement away. A Channel released on a
        Space is the other gesture and is claimed by that row, which stops the
        event before it reaches here.
      */}
      <section
        // On the section rather than on the list `div` under it, which has no
        // role: a description hung on a `generic` element is one a screen
        // reader is free to ignore, and a `<section>` with a name is a
        // `region`. The pinned section says its own hint the same way.
        aria-describedby={ready && spaces.length > 0 ? "spaces-reorder-help" : undefined}
        aria-labelledby="spaces-heading"
        className="sidebar-section spaces-section"
        onDragOver={(event) => {
          event.preventDefault();
          event.dataTransfer.dropEffect = 'move';
        }}
        onDrop={(event) => event.preventDefault()}
      >
        <div className="sidebar-section-heading">
          <h2 id="spaces-heading">Spaces</h2>
          {ready && restorableSpaces.length > 0 && <IconButton className="space-sidebar-action" label="Restore archived space" onClick={() => { setRestoreFailed(false); setRecoveryOpen(true); }}>
            <IconRestore size={15} stroke={1.8} />
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
          <SidebarList>
            {/* Said once for the whole section rather than on every row: as a
                per-row description it lands inside each link's accessible
                name, so somebody arrowing through hears the instruction again
                before every title. Both lists here are arranged the same way,
                so it is one sentence about both. */}
            <p className="sr-only" id="spaces-reorder-help">
              Hold Alt and press the up or down arrow to move a space, or a channel within its space.
            </p>
            {outOfDate && <SidebarRefreshRow onRefresh={onRetry} />}
            {ordered.map((space, index) => {
              const destination = `/spaces/${space.id}`;
              const active = location.pathname === destination || location.pathname.startsWith(`${destination}/`);
              const isExpanded = isOpen(space);
              // A Space this reader reaches only through a Channel placed in
              // it. They are shown its mark and name so that Channel has
              // somewhere to be drawn; every write on the Space is refused
              // them by name, so the row raises none of them — no plus, and
              // no drop. Its placements are still theirs to arrange, because
              // an arrangement is their own view preference.
              const readOnly = space.reach === 'through_channel';
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
              // nothing moved. The rule is applied once — running it again
              // over its own output is idempotent and reads as a second rule.
              const storedPlacements = orderByStoredIds(
                natural,
                storedOrderFor(ordering, { kind: 'space', id: space.id }),
                (workstream) => workstream.id,
              );
              const stored = storedPlacements.map((workstream) => workstream.id);
              const placements = placementOrder?.spaceId === space.id
                ? orderByStoredIds(natural, placementOrder.ids, (workstream) => workstream.id)
                : storedPlacements;
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
                  const committed = committedOrder(
                    held, stored, cancelled || current?.dropped !== true,
                  );
                  if (committed === null) {
                    setPlacementOrder(null);
                    return;
                  }
                  void commitPlacements(space.id, committed);
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
                  {...(!readOnly && space.systemRole !== 'general' && onArchive !== undefined ? {
                    contextMenu: (
                      <ContextMenu.Item
                        className="menu-item menu-item-danger"
                        onSelect={() => {
                          setArchiveFailure(null);
                          setBlockedChannelIds([]);
                          setArchiveTarget(space);
                        }}
                      >
                        <IconArchive aria-hidden="true" size={16} stroke={1.8} /> Archive space
                      </ContextMenu.Item>
                    ),
                  } : {})}
                  drag={{
                    // Escape, or a release outside the section, must not be the
                    // same thing as finishing the drag: the arrangement built
                    // while the pointer crossed the other rows is abandoned
                    // rather than persisted to every one of this person's
                    // sessions.
                    onDragEnd: (cancelled) => {
                      const committed = committedOrder(dragOrder, storedSpaceIds, cancelled);
                      dragging.current = null;
                      if (committed) void commit(committed);
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
                      // Not a drop target. Ignored the way a Channel released
                      // on a Space it is already in is ignored — the gesture
                      // simply changed nothing — rather than refused, because
                      // there is nothing here for a refusal to name.
                      if (readOnly) return;
                      event.preventDefault();
                      event.stopPropagation();
                      dragging.current = null;
                      setSectionFailure(null);
                      const currentPlacement = placementDrag.current;
                      if (currentPlacement?.spaceId === space.id
                        && currentPlacement.workstreamId === workstreamId) {
                        // A gap or gutter inside this placement list belongs to
                        // the list just as a row does. The last hover position
                        // is the order being accepted.
                        placementDrag.current = { ...currentPlacement, dropped: true };
                        event.dataTransfer.dropEffect = 'move';
                        return;
                      }
                      // A placement is not a reorder in the list the Channel
                      // came from (including Pinned). Its dragend sees `copy`
                      // and discards any incidental arrangement built while
                      // the pointer crossed that list.
                      event.dataTransfer.dropEffect = 'copy';
                      // The two meanings of one gesture, told apart by where
                      // the Channel already is: a release inside the list it
                      // is in is a reorder, which the rows have already
                      // handled and whose event never reaches here, and a
                      // release anywhere else on a Space is a placement. A
                      // Channel dropped on a Space it is already in is neither
                      // — it is a drag that changed nothing.
                      //
                      // `placementIds` is what this device has loaded, so a
                      // Channel already in the Space but outside that page
                      // falls through and is added again. That costs a round
                      // trip and nothing else: `prepareMembership` answers an
                      // already-active membership with its own generation
                      // rather than staging a second, and an order write
                      // merges rather than replacing.
                      if (placementIds.includes(workstreamId)) return;
                      void onAddChannel(space.id, workstreamId).catch((cause: unknown) => {
                        setSectionFailure({
                          title: spaceSectionFailure.add_channel.title,
                          copy: spaceFailureSentence(cause, spaceSectionFailure.add_channel.copy),
                        });
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
                      has. The count is read for its zero and nothing else: it
                      keeps a Space holding Channels this device has not loaded
                      from claiming to be empty. It is the Organization's count
                      for a Space this person is in — a number they have no
                      business being shown, because it may exceed the rows they
                      can see — and this viewer's own for one they reach
                      through a Channel in it, where it is never zero at all.
                      Two readings of one number, and neither is a number worth
                      drawing. */}
                  {isExpanded && (placements.length === 0 && space.channelCount === 0
                    ? <p className="space-sidebar-empty">No channels</p>
                    : <SpacePlacementList spaceId={space.id}>
                      {placements.map((workstream, placementIndex) => (
                        <Fragment key={workstream.id}>
                          {renderWorkstream(
                            workstream,
                            placementRowDrag(workstream, placementIndex),
                            space.id,
                          )}
                        </Fragment>
                      ))}
                    </SpacePlacementList>)}
                </SpaceRow>
              );
            })}
          </SidebarList>
        )}
      </section>
      <AcknowledgedErrorDialog
        error={sectionFailure}
        onAcknowledge={() => setSectionFailure(null)}
      />
      <Modal
        footer={<>
          <Button disabled={archiveSaving} onClick={closeArchive}>Cancel</Button>
          <Button
            className="button-danger"
            disabled={archiveSaving || archiveUnavailableSentence !== null}
            onClick={() => void submitArchive()}
          >Archive space</Button>
        </>}
        onOpenChange={(open) => { if (!open) closeArchive(); }}
        open={archiveTarget !== null}
        title="Archive space?"
      >
        <p>Its channels keep the resources and Sidekicks they already have, and stay in every other space they belong to. A channel whose only space is this one has to be moved first.</p>
        {archiveUnavailableSentence
          ? <InlineError>{archiveUnavailableSentence}</InlineError>
          : archiveFailure && <InlineError>{archiveFailure}</InlineError>}
        {blockedChannelIds.length > 0 && (
          <ul aria-label="Channels to move first" className="space-dashboard-blocked-channels">
            {blockedChannelIds.map((id) => (
              <li key={id}>{blockedChannelLabel(id, workstreams)}</li>
            ))}
          </ul>
        )}
      </Modal>
      <Modal
        footer={<Button onClick={() => { setRestoreFailed(false); setRecoveryOpen(false); }}>Cancel</Button>}
        onOpenChange={(open) => { if (!open) setRestoreFailed(false); setRecoveryOpen(open); }}
        open={recoveryOpen}
        title="Restore archived space"
      >
        <div className="space-recovery-list">{restorableSpaces.map((space) => (
          <Button key={space.id} onClick={() => {
            setRestoreFailed(false);
            void onRestore(space.id)
              .then(() => { setRecoveryOpen(false); void navigate(`/spaces/${space.id}`); })
              .catch(() => setRestoreFailed(true));
          }}><SpaceIcon space={space} /> {space.name}</Button>
        ))}</div>
        {restoreFailed && <InlineError>The space couldn’t be restored.</InlineError>}
      </Modal>
    </>
  );
}
