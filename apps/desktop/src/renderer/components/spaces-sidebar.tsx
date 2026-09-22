import { IconArchive, IconRestore } from '@tabler/icons-react';
import * as ContextMenu from '@radix-ui/react-context-menu';
import * as Tooltip from '@radix-ui/react-tooltip';
import type { ContainerOrder, PersonalOrder, SpaceSummary } from '@rally/contracts';
import { SpaceIcon } from '@rally/ui/components/space-appearance-picker';
import { SidebarNavigationRowContent } from '@rally/ui/components/navigation';
import { SidebarRefreshRow } from '@rally/ui/components/sidebar-refresh-row';
import {
  ResizableSidebar,
  SidebarCollapseFooter,
  SidebarHeader,
  SidebarHorizontalLine,
  SidebarList,
  SidebarRow,
  SidebarScroll,
} from '@rally/ui/components/resizable-sidebar';
import {
  COLLAPSED_SIDEBAR_WIDTH,
  MAX_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
  SIDEBAR_COLLAPSE_DRAG_THRESHOLD,
  SIDEBAR_EXPAND_DRAG_THRESHOLD,
} from '@rally/ui/lib/sidebar-geometry';
import clsx from 'clsx';
import { Plus } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';

import { useListMotion } from '../lib/use-list-motion';
import { committedOrder, moveWithin, orderByStoredIds, storedOrderFor } from '../lib/personal-order';
import { spaceFailureSentence, spaceRefusalChannelIds } from '../lib/space-failure-copy';
import type { WorkstreamSummary } from '../lib/types';
import { NewWorkstreamMenu } from './new-workstream-menu';
import { AcknowledgedErrorDialog, type AcknowledgedError } from './acknowledged-error-dialog';
import { Button, IconButton, InlineError, Modal, Tip } from './primitives';
import { SidebarSearch } from './sidebar-search';
import { SidebarSkeletonRows } from './sidebar-skeleton';

interface SpacesSidebarProps {
  accountSlotRef: (element: HTMLDivElement | null) => void;
  availableWidth: number;
  sidekickSlotRef: (element: HTMLDivElement | null) => void;
  collapsed: boolean;
  constrained: boolean;
  width: number;
  currentPath: string;
  inactiveSpaces: SpaceSummary[];
  loading?: boolean;
  readOnly?: boolean;
  spaces: SpaceSummary[];
  selectedSpaceId: string | null;
  ready: boolean;
  outOfDate: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
  onWidthChange: (width: number) => void;
  onCreateChannel: (input: { name: string; spaceId: string }) => Promise<void>;
  onCreateSpace: (name: string) => Promise<void>;
  onImportChannel: (input: { clientMessageId: string; name: string; spaceId: string; url: string }) => Promise<void>;
  onOpenSearch?: () => void;
  onOrderPreviewChange: (order: string[] | null) => void;
  onArchive?: ((spaceId: string) => Promise<void>) | undefined;
  onMoveChannel: (sourceSpaceId: string, targetSpaceId: string, workstreamId: string) => Promise<void>;
  onReorder: (order: ContainerOrder) => Promise<void>;
  onRetry: () => void;
  onRestore: (spaceId: string) => Promise<void>;
  onSelect: (spaceId: string) => void;
  ordering: PersonalOrder;
  workstreams: WorkstreamSummary[];
}

const CHANNEL_DRAG_TYPE = 'application/x-rally-workstream-id';
const CHANNEL_DRAG_SOURCE_SPACE_TYPE = 'application/x-rally-channel-source-space-id';
const CHANNEL_DROP_ACCEPTED_FLASH_MS = 780;
const SPACE_DRAG_TYPE = 'application/x-rally-space-id';

/**
 * The first level of the Organization hierarchy.
 *
 * This is deliberately navigation only. WorkspaceDO's Space directory remains
 * the authority; selecting a row tells the adjacent Channel sidebar which
 * placement list to draw. Keeping the rails separate avoids turning a Space
 * row into a second, accordion-shaped owner of Channel state.
 */
export function SpacesSidebar({
  accountSlotRef,
  availableWidth,
  sidekickSlotRef,
  collapsed,
  constrained,
  width,
  currentPath,
  inactiveSpaces,
  loading = false,
  readOnly = false,
  spaces,
  selectedSpaceId,
  ready,
  outOfDate,
  onCollapsedChange,
  onWidthChange,
  onCreateChannel,
  onCreateSpace,
  onImportChannel,
  onOpenSearch,
  onOrderPreviewChange,
  onArchive,
  onMoveChannel,
  onReorder,
  onRetry,
  onRestore,
  onSelect,
  ordering,
  workstreams,
}: SpacesSidebarProps): React.JSX.Element {
  const navigate = useNavigate();
  const sidebarRef = useRef<HTMLElement>(null);
  const onNewChannelRoute = currentPath === '/workstreams/new';
  const commandRef = useRef<HTMLDivElement | null>(null);
  const [dragOrder, setDragOrder] = useState<string[] | null>(null);
  const dragOrderRef = useRef<string[] | null>(null);
  const [failure, setFailure] = useState<AcknowledgedError | null>(null);
  const draggingSpaceId = useRef<string | null>(null);
  const [channelDropTargetId, setChannelDropTargetId] = useState<string | null>(null);
  const [acceptedChannelDropTargetId, setAcceptedChannelDropTargetId] = useState<string | null>(null);
  const acceptedChannelDropTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [archiveTarget, setArchiveTarget] = useState<SpaceSummary | null>(null);
  const [archiveFailure, setArchiveFailure] = useState<string | null>(null);
  const [archiveSaving, setArchiveSaving] = useState(false);
  const [blockedChannelIds, setBlockedChannelIds] = useState<string[]>([]);
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const [restoreFailed, setRestoreFailed] = useState(false);
  // The compact Create control is a row inserted above Search. Search keeps
  // its second grid track while the first track opens; list motion draws the
  // Create control's leftward entrance and stand-in exit independently.
  useListMotion(commandRef, collapsed);
  useEffect(() => () => {
    if (acceptedChannelDropTimer.current !== null) clearTimeout(acceptedChannelDropTimer.current);
  }, []);
  const storedSpaces = useMemo(() => orderByStoredIds(
    spaces,
    storedOrderFor(ordering, { kind: 'organization' }),
    (space) => space.id,
  ), [ordering, spaces]);
  const storedIds = storedSpaces.map((space) => space.id);
  const orderedSpaces = dragOrder === null
    ? storedSpaces
    : orderByStoredIds(spaces, dragOrder, (space) => space.id);
  const restorableSpaces = inactiveSpaces.filter((space) => space.reach !== 'through_channel');
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
  const effectiveWidth = collapsed ? COLLAPSED_SIDEBAR_WIDTH : width;
  const resize = useCallback((requested: number): void => {
    if (collapsed) {
      if (requested < SIDEBAR_EXPAND_DRAG_THRESHOLD || constrained) return;
      onWidthChange(Math.min(MAX_SIDEBAR_WIDTH, requested, availableWidth));
      onCollapsedChange(false);
      return;
    }
    if (requested < SIDEBAR_COLLAPSE_DRAG_THRESHOLD) {
      onCollapsedChange(true);
      return;
    }
    if (constrained) return;
    onWidthChange(Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, requested, availableWidth)));
  }, [availableWidth, collapsed, constrained, onCollapsedChange, onWidthChange]);
  const toggle = useCallback((): void => {
    if (!collapsed) {
      onCollapsedChange(true);
      return;
    }
    if (constrained) return;
    onWidthChange(Math.min(width, availableWidth));
    onCollapsedChange(false);
  }, [availableWidth, collapsed, constrained, onCollapsedChange, onWidthChange, width]);

  const previewOrder = (order: string[] | null): void => {
    dragOrderRef.current = order;
    setDragOrder(order);
    onOrderPreviewChange(order);
  };

  const commitOrder = async (ids: string[]): Promise<void> => {
    previewOrder(ids);
    setFailure(null);
    try {
      await onReorder({ container: { kind: 'organization' }, itemIds: ids });
    } catch {
      setFailure({
        title: 'Spaces could not be reordered',
        copy: 'The spaces are back in the order they were in. Try again in a moment.',
      });
    } finally {
      if (dragOrderRef.current === ids) previewOrder(null);
    }
  };

  const flashAcceptedChannelDrop = (spaceId: string): void => {
    if (acceptedChannelDropTimer.current !== null) clearTimeout(acceptedChannelDropTimer.current);
    setAcceptedChannelDropTargetId(spaceId);
    acceptedChannelDropTimer.current = setTimeout(() => {
      setAcceptedChannelDropTargetId(null);
      acceptedChannelDropTimer.current = null;
    }, CHANNEL_DROP_ACCEPTED_FLASH_MS);
  };

  const closeArchive = (): void => {
    if (archiveSaving) return;
    setArchiveTarget(null);
    setArchiveFailure(null);
    setBlockedChannelIds([]);
  };
  const submitArchive = async (): Promise<void> => {
    if (!archiveTarget || !onArchive || archiveUnavailableSentence || archiveSaving) return;
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

  return (
    <>
      <ResizableSidebar
        aria-label="Spaces sidebar"
        className="spaces-sidebar"
        compact={collapsed}
        constrained={constrained}
        onResize={resize}
        onToggle={toggle}
        resizeLabel="Resize spaces sidebar"
        sidebarRef={sidebarRef}
        width={effectiveWidth}
      >
        <SidebarHeader aria-label="Space actions" className="spaces-sidebar-titlebar window-drag">
          <div className="spaces-sidebar-titlebar-actions window-no-drag">
          {!readOnly && ready && restorableSpaces.length > 0 && <IconButton className="spaces-sidebar-restore" label="Restore archived space" onClick={() => { setRestoreFailed(false); setRecoveryOpen(true); }}>
            <IconRestore size={16} stroke={1.8} />
          </IconButton>}
          {!readOnly && ready && <NewWorkstreamMenu
            canCreateSpace
            tooltipLabel="New channel or space"
            spaces={spaces}
            onCreateChannel={onCreateChannel}
            onCreateSpace={onCreateSpace}
            onImportChannel={onImportChannel}
          >
            <button
              aria-hidden={collapsed}
              aria-label="New channel or space"
              className={clsx('sidebar-new-button window-no-drag', onNewChannelRoute && 'is-active')}
              tabIndex={collapsed ? -1 : undefined}
              type="button"
            >
              <Plus aria-hidden="true" size={16} />
            </button>
          </NewWorkstreamMenu>}
          </div>
        </SidebarHeader>
        {ready && <div className="sidebar-commandbar spaces-sidebar-commandbar window-no-drag" ref={commandRef}>
          {!readOnly && collapsed && <NewWorkstreamMenu
            tooltipSide="right"
            tooltipLabel="New channel or space"
            canCreateSpace
            spaces={spaces}
            onCreateChannel={onCreateChannel}
            onCreateSpace={onCreateSpace}
            onImportChannel={onImportChannel}
          >
            <button
              aria-label="New channel or space"
              className={clsx('sidebar-new-button sidebar-rail-new-button window-no-drag', onNewChannelRoute && 'is-active')}
              data-motion-insert=""
              data-motion-key="action:new"
              type="button"
            >
              <Plus aria-hidden="true" size={19} strokeWidth={1.6} />
            </button>
          </NewWorkstreamMenu>}
          <Tip describesTrigger={false} label="Search" side={collapsed ? 'right' : 'bottom'}>
            <SidebarSearch mode="button" onClick={onOpenSearch} disabled={!onOpenSearch} aria-label="Search organization" />
          </Tip>
        </div>}
        {!readOnly && ready && spaces.length > 1 && <p className="sr-only" id="spaces-reorder-help">
          Hold Alt and press the Up or Down Arrow key to reorder a space.
        </p>}
        <SidebarScroll
          as="nav"
          aria-describedby={!readOnly && ready && spaces.length > 1 ? 'spaces-reorder-help' : undefined}
          aria-label="Spaces"
          className="spaces-sidebar-scroll"
        >
          <SidebarList>
          {!ready ? (
            <p className="spaces-sidebar-empty">Rally is opening this organization. Spaces appear once every channel has one.</p>
          ) : loading && spaces.length === 0 ? (
            <SidebarSkeletonRows count={4} hint />
          ) : spaces.length === 0 ? (
            <p className="spaces-sidebar-empty">No spaces yet</p>
          ) : <>
            {outOfDate && <SidebarRefreshRow onRefresh={onRetry} />}
            {orderedSpaces.map((space, index) => (
            <Tooltip.Root key={space.id} delayDuration={300}>
              <ContextMenu.Root>
              <ContextMenu.Trigger asChild>
              <Tooltip.Trigger asChild>
                <SidebarRow
                  as={readOnly ? 'button' : NavLink}
                  {...(readOnly ? { type: 'button' as const } : { to: `/spaces/${space.id}` })}
                  aria-label={space.name}
                  aria-description={space.scope === 'workspace' ? 'Public space' : 'Private space'}
                  badge={{
                    count: space.attentionCount ?? 0,
                    label: `${space.attentionCount ?? 0} ${space.attentionCount === 1 ? 'conversation needs' : 'conversations need'} attention in ${space.name}`,
                  }}
                  className={clsx(
                    'spaces-sidebar-row',
                    selectedSpaceId === space.id && 'is-active',
                    channelDropTargetId === space.id && 'is-channel-drop-target',
                    acceptedChannelDropTargetId === space.id && 'is-channel-drop-accepted',
                  )}
                  draggable={!readOnly}
                  onDragEnd={(event: DragEvent<HTMLElement>) => {
                    const next = committedOrder(dragOrder, storedIds, (event.dataTransfer?.dropEffect ?? 'none') !== 'move');
                    draggingSpaceId.current = null;
                    if (next) void commitOrder(next);
                    else previewOrder(null);
                  }}
                  onDragEnter={(event: DragEvent<HTMLElement>) => {
                    const placesChannel = space.reach !== 'through_channel'
                      && selectedSpaceId !== space.id
                      && event.dataTransfer.types.includes(CHANNEL_DRAG_TYPE)
                      && event.dataTransfer.types.includes(CHANNEL_DRAG_SOURCE_SPACE_TYPE);
                    if (placesChannel) {
                      event.preventDefault();
                      setChannelDropTargetId(space.id);
                      return;
                    }
                    if (!event.dataTransfer.types.includes(SPACE_DRAG_TYPE)) return;
                    event.preventDefault();
                    const dragged = draggingSpaceId.current;
                    if (!dragged || dragged === space.id) return;
                    previewOrder(moveWithin(
                      dragOrderRef.current ?? orderedSpaces.map((item) => item.id),
                      dragged,
                      index,
                    ));
                  }}
                  onDragOver={(event: DragEvent<HTMLElement>) => {
                    const reordersSpace = event.dataTransfer.types.includes(SPACE_DRAG_TYPE);
                    const placesChannel = space.reach !== 'through_channel'
                      && selectedSpaceId !== space.id
                      && event.dataTransfer.types.includes(CHANNEL_DRAG_TYPE)
                      && event.dataTransfer.types.includes(CHANNEL_DRAG_SOURCE_SPACE_TYPE);
                    if (!reordersSpace && !placesChannel) return;
                    event.preventDefault();
                    event.dataTransfer.dropEffect = 'move';
                  }}
                  onDragLeave={(event: DragEvent<HTMLElement>) => {
                    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
                    setChannelDropTargetId((current) => current === space.id ? null : current);
                  }}
                  onDragStart={(event: DragEvent<HTMLElement>) => {
                    if (readOnly) return;
                    draggingSpaceId.current = space.id;
                    previewOrder(orderedSpaces.map((item) => item.id));
                    event.dataTransfer.effectAllowed = 'move';
                    event.dataTransfer.setData(SPACE_DRAG_TYPE, space.id);
                  }}
                  onDrop={(event: DragEvent<HTMLElement>) => {
                    const workstreamId = event.dataTransfer.getData(CHANNEL_DRAG_TYPE);
                    const sourceSpaceId = event.dataTransfer.getData(CHANNEL_DRAG_SOURCE_SPACE_TYPE);
                    const sourceIsWritable = spaces.some((candidate) => (
                      candidate.id === sourceSpaceId && candidate.reach !== 'through_channel'
                    ));
                    if (!workstreamId || !sourceSpaceId || sourceSpaceId === space.id
                      || selectedSpaceId === space.id || !sourceIsWritable
                      || space.reach === 'through_channel') return;
                    event.preventDefault();
                    event.stopPropagation();
                    setChannelDropTargetId(null);
                    setFailure(null);
                    event.dataTransfer.dropEffect = 'move';
                    // The row leaves the source rail optimistically, so the
                    // destination acknowledges the same drop immediately. A
                    // server refusal still restores the placement and opens
                    // the failure dialog; the pulse describes the gesture,
                    // not network latency.
                    flashAcceptedChannelDrop(space.id);
                    void onMoveChannel(sourceSpaceId, space.id, workstreamId)
                      .catch((cause: unknown) => {
                        if (acceptedChannelDropTimer.current !== null) {
                          clearTimeout(acceptedChannelDropTimer.current);
                          acceptedChannelDropTimer.current = null;
                        }
                        setAcceptedChannelDropTargetId((current) => current === space.id ? null : current);
                        setFailure({
                          title: 'Channel could not be moved',
                          copy: spaceFailureSentence(
                            cause,
                            'The channel is still in the space it came from. Try again in a moment.',
                          ),
                        });
                      });
                  }}
                  onKeyDown={(event: KeyboardEvent<HTMLElement>) => {
                    if (readOnly) return;
                    if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
                    event.preventDefault();
                    const nextIndex = index + (event.key === 'ArrowUp' ? -1 : 1);
                    if (nextIndex < 0 || nextIndex >= orderedSpaces.length) return;
                    void commitOrder(moveWithin(orderedSpaces.map((item) => item.id), space.id, nextIndex));
                  }}
                  onClick={() => onSelect(space.id)}
                >
                  <SidebarNavigationRowContent
                    description={space.scope === 'workspace' ? 'Public space' : 'Private space'}
                    icon={<span className="spaces-sidebar-mark"><SpaceIcon size={22} space={space} /></span>}
                    title={space.name}
                  />
                </SidebarRow>
              </Tooltip.Trigger>
              </ContextMenu.Trigger>
              {space.reach !== 'through_channel' && space.systemRole !== 'general' && onArchive !== undefined && <ContextMenu.Portal>
                <ContextMenu.Content className="menu-content sidebar-context-menu" collisionPadding={8}>
                  <ContextMenu.Item className="menu-item menu-item-danger" onSelect={() => {
                    setArchiveFailure(null);
                    setBlockedChannelIds([]);
                    setArchiveTarget(space);
                  }}>
                    <IconArchive aria-hidden="true" size={16} stroke={1.8} /> Archive space
                  </ContextMenu.Item>
                </ContextMenu.Content>
              </ContextMenu.Portal>}
              </ContextMenu.Root>
              <Tooltip.Portal>
                <Tooltip.Content
                  align="center"
                  className="sidebar-workstream-preview-surface spaces-sidebar-preview-surface"
                  collisionPadding={8}
                  side="right"
                  sideOffset={8}
                >
                  <div className="sidebar-workstream-preview">
                    <div className="sidebar-workstream-preview-header">
                      <span className="sidebar-workstream-preview-identity">
                        <SpaceIcon size={16} space={space} />
                        <span className="sidebar-workstream-preview-name">{space.name}</span>
                      </span>
                    </div>
                    <p className="sidebar-workstream-preview-scope">
                      {space.scope === 'personal' ? 'Private space' : 'Organization space'}
                    </p>
                  </div>
                </Tooltip.Content>
              </Tooltip.Portal>
            </Tooltip.Root>
            ))}
          </>}
          </SidebarList>
        </SidebarScroll>
        <div className="spaces-sidekick-slot" ref={sidekickSlotRef} />
        <SidebarHorizontalLine className="spaces-sidebar-footer-line" />
        <SidebarCollapseFooter
          collapseLabel="Collapse spaces"
          compact={collapsed}
          constrained={constrained}
          constrainedTitle="Widen the window to expand spaces"
          expandLabel="Expand spaces"
          leading={<div className="spaces-account-slot" ref={accountSlotRef} />}
          onToggle={toggle}
        />
      </ResizableSidebar>
      <AcknowledgedErrorDialog
        error={failure}
        onAcknowledge={() => setFailure(null)}
      />
      <Modal
        footer={<>
          <Button disabled={archiveSaving} onClick={closeArchive}>Cancel</Button>
          <Button className="button-danger" disabled={archiveSaving || archiveUnavailableSentence !== null} onClick={() => void submitArchive()}>Archive space</Button>
        </>}
        onOpenChange={(open) => { if (!open) closeArchive(); }}
        open={archiveTarget !== null}
        title="Archive space?"
      >
        <p>Its channels keep the resources and Sidekicks they already have, and stay in every other space they belong to. A channel whose only space is this one has to be moved first.</p>
        {archiveUnavailableSentence
          ? <InlineError>{archiveUnavailableSentence}</InlineError>
          : archiveFailure && <InlineError>{archiveFailure}</InlineError>}
        {blockedChannelIds.length > 0 && <ul aria-label="Channels to move first" className="space-dashboard-blocked-channels">
          {blockedChannelIds.map((id) => <li key={id}>{workstreams.find((workstream) => workstream.id === id)?.title ?? 'A channel not loaded on this device'}</li>)}
        </ul>}
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
