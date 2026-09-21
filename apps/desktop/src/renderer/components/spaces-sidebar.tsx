import { IconArchive, IconRestore } from '@tabler/icons-react';
import * as ContextMenu from '@radix-ui/react-context-menu';
import * as Tooltip from '@radix-ui/react-tooltip';
import type { ContainerOrder, PersonalOrder, SpaceSummary } from '@rally/contracts';
import { SpaceIcon } from '@rally/ui/components/space-appearance-picker';
import clsx from 'clsx';
import { PanelLeftClose, PanelLeftOpen, Plus } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';

import { useListMotion } from '../lib/use-list-motion';
import { committedOrder, moveWithin, orderByStoredIds, storedOrderFor } from '../lib/personal-order';
import { spaceFailureSentence, spaceRefusalChannelIds } from '../lib/space-failure-copy';
import type { WorkstreamSummary } from '../lib/types';
import { NewWorkstreamMenu } from './new-workstream-menu';
import { Button, IconButton, InlineError, Modal } from './primitives';
import { SidebarSearch } from './sidebar-search';
import { SidebarSkeletonRows } from './sidebar-skeleton';

interface SpacesSidebarProps {
  accountSlotRef: (element: HTMLDivElement | null) => void;
  sidekickSlotRef: (element: HTMLDivElement | null) => void;
  collapsed: boolean;
  currentPath: string;
  inactiveSpaces: SpaceSummary[];
  loading?: boolean;
  spaces: SpaceSummary[];
  selectedSpaceId: string | null;
  ready: boolean;
  outOfDate: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
  onCreateChannel: (input: { name: string; spaceId: string }) => Promise<void>;
  onCreateSpace: (name: string) => Promise<void>;
  onImportChannel: (input: { clientMessageId: string; name: string; spaceId: string; url: string }) => Promise<void>;
  onOpenSearch?: () => void;
  onArchive?: ((spaceId: string) => Promise<void>) | undefined;
  onAddChannel: (spaceId: string, workstreamId: string) => Promise<void>;
  onReorder: (order: ContainerOrder) => Promise<void>;
  onRetry: () => void;
  onRestore: (spaceId: string) => Promise<void>;
  onSelect: (spaceId: string) => void;
  ordering: PersonalOrder;
  workstreams: WorkstreamSummary[];
}

const CHANNEL_DRAG_TYPE = 'application/x-rally-workstream-id';
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
  sidekickSlotRef,
  collapsed,
  currentPath,
  inactiveSpaces,
  loading = false,
  spaces,
  selectedSpaceId,
  ready,
  outOfDate,
  onCollapsedChange,
  onCreateChannel,
  onCreateSpace,
  onImportChannel,
  onOpenSearch,
  onArchive,
  onAddChannel,
  onReorder,
  onRetry,
  onRestore,
  onSelect,
  ordering,
  workstreams,
}: SpacesSidebarProps): React.JSX.Element {
  const navigate = useNavigate();
  const onNewChannelRoute = currentPath === '/workstreams/new';
  const commandRef = useRef<HTMLDivElement | null>(null);
  const [dragOrder, setDragOrder] = useState<string[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const draggingSpaceId = useRef<string | null>(null);
  const [archiveTarget, setArchiveTarget] = useState<SpaceSummary | null>(null);
  const [archiveFailure, setArchiveFailure] = useState<string | null>(null);
  const [archiveSaving, setArchiveSaving] = useState(false);
  const [blockedChannelIds, setBlockedChannelIds] = useState<string[]>([]);
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const [restoreFailed, setRestoreFailed] = useState(false);
  // The compact Create control is a row inserted beneath Search. The shared
  // list-motion primitive draws both its leftward entrance and its leftward
  // stand-in exit; the titlebar control travels through the opposite edge in
  // CSS over the same sidebar interval.
  useListMotion(commandRef, collapsed);
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

  const commitOrder = async (ids: string[]): Promise<void> => {
    setDragOrder(ids);
    setFailure(null);
    try {
      await onReorder({ container: { kind: 'organization' }, itemIds: ids });
    } catch {
      setFailure('Spaces couldn\u2019t be reordered.');
    } finally {
      setDragOrder((current) => current === ids ? null : current);
    }
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
      <aside
        aria-label="Spaces sidebar"
        className={clsx('spaces-sidebar', collapsed && 'is-compact')}
      >
        <div className="spaces-sidebar-titlebar window-drag">
          <span>Spaces</span>
          <div className="spaces-sidebar-titlebar-actions window-no-drag">
          {ready && restorableSpaces.length > 0 && <IconButton className="spaces-sidebar-restore" label="Restore archived space" onClick={() => { setRestoreFailed(false); setRecoveryOpen(true); }}>
            <IconRestore size={16} stroke={1.8} />
          </IconButton>}
          {ready && <NewWorkstreamMenu
            canCreateSpace
            spaces={spaces}
            onCreateChannel={onCreateChannel}
            onCreateSpace={onCreateSpace}
            onImportChannel={onImportChannel}
          >
            <button
              aria-hidden={collapsed}
              aria-label="New channel"
              className={clsx('sidebar-new-button window-no-drag', onNewChannelRoute && 'is-active')}
              tabIndex={collapsed ? -1 : undefined}
              type="button"
            >
              <Plus aria-hidden="true" size={16} />
            </button>
          </NewWorkstreamMenu>}
          </div>
        </div>
        {ready && <div className="sidebar-commandbar spaces-sidebar-commandbar window-no-drag" ref={commandRef}>
          <SidebarSearch mode="button" onClick={onOpenSearch} disabled={!onOpenSearch} aria-label="Search organization" />
          {collapsed && <NewWorkstreamMenu
            tooltipSide="right"
            canCreateSpace
            spaces={spaces}
            onCreateChannel={onCreateChannel}
            onCreateSpace={onCreateSpace}
            onImportChannel={onImportChannel}
          >
            <button
              aria-label="New channel"
              className={clsx('sidebar-new-button sidebar-rail-new-button window-no-drag', onNewChannelRoute && 'is-active')}
              data-motion-insert=""
              data-motion-key="action:new"
              type="button"
            >
              <Plus aria-hidden="true" size={19} strokeWidth={1.6} />
            </button>
          </NewWorkstreamMenu>}
        </div>}
        {ready && spaces.length > 1 && <p className="sr-only" id="spaces-reorder-help">
          Hold Alt and press the Up or Down Arrow key to reorder a space.
        </p>}
        <nav
          aria-describedby={ready && spaces.length > 1 ? 'spaces-reorder-help' : undefined}
          aria-label="Spaces"
          className="spaces-sidebar-scroll"
        >
          {!ready ? (
            <p className="spaces-sidebar-empty">Rally is opening this organization. Spaces appear once every channel has one.</p>
          ) : loading && spaces.length === 0 ? (
            <SidebarSkeletonRows count={4} hint />
          ) : spaces.length === 0 ? (
            <p className="spaces-sidebar-empty">No spaces yet</p>
          ) : <>
            {outOfDate && <div className="space-sidebar-stale">
              <p role="status">These spaces may be out of date.</p>
              <Button onClick={onRetry}>Try again</Button>
            </div>}
            {failure && <p className="spaces-sidebar-error" role="alert">{failure}</p>}
            {orderedSpaces.map((space, index) => (
            <Tooltip.Root key={space.id} delayDuration={300}>
              <ContextMenu.Root>
              <ContextMenu.Trigger asChild>
              <Tooltip.Trigger asChild>
                <NavLink
                  aria-label={space.name}
                  className={clsx('spaces-sidebar-row', selectedSpaceId === space.id && 'is-active')}
                  draggable
                  onDragEnd={(event) => {
                    const next = committedOrder(dragOrder, storedIds, (event.dataTransfer?.dropEffect ?? 'none') !== 'move');
                    draggingSpaceId.current = null;
                    if (next) void commitOrder(next);
                    else setDragOrder(null);
                  }}
                  onDragEnter={(event) => {
                    if (!event.dataTransfer.types.includes(SPACE_DRAG_TYPE)) return;
                    event.preventDefault();
                    const dragged = draggingSpaceId.current;
                    if (!dragged || dragged === space.id) return;
                    setDragOrder((current) => moveWithin(current ?? orderedSpaces.map((item) => item.id), dragged, index));
                  }}
                  onDragOver={(event) => {
                    const reordersSpace = event.dataTransfer.types.includes(SPACE_DRAG_TYPE);
                    const placesChannel = space.reach !== 'through_channel'
                      && event.dataTransfer.types.includes(CHANNEL_DRAG_TYPE);
                    if (!reordersSpace && !placesChannel) return;
                    event.preventDefault();
                    event.dataTransfer.dropEffect = reordersSpace ? 'move' : 'copy';
                  }}
                  onDragStart={(event) => {
                    draggingSpaceId.current = space.id;
                    setDragOrder(orderedSpaces.map((item) => item.id));
                    event.dataTransfer.effectAllowed = 'move';
                    event.dataTransfer.setData(SPACE_DRAG_TYPE, space.id);
                  }}
                  onDrop={(event) => {
                    const workstreamId = event.dataTransfer.getData(CHANNEL_DRAG_TYPE);
                    if (!workstreamId || space.reach === 'through_channel') return;
                    event.preventDefault();
                    event.stopPropagation();
                    setFailure(null);
                    void onAddChannel(space.id, workstreamId).catch(() => {
                      setFailure('That channel couldn\u2019t be added to the space.');
                    });
                  }}
                  onKeyDown={(event) => {
                    if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
                    event.preventDefault();
                    const nextIndex = index + (event.key === 'ArrowUp' ? -1 : 1);
                    if (nextIndex < 0 || nextIndex >= orderedSpaces.length) return;
                    void commitOrder(moveWithin(orderedSpaces.map((item) => item.id), space.id, nextIndex));
                  }}
                  onClick={() => onSelect(space.id)}
                  to={`/spaces/${space.id}`}
                >
                  <span className="spaces-sidebar-mark"><SpaceIcon size={22} space={space} /></span>
                  <span className="spaces-sidebar-copy">
                    <strong>{space.name}</strong>
                    <small>{space.channelCount === 1 ? '1 channel' : `${space.channelCount} channels`}</small>
                  </span>
                </NavLink>
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
                      {space.scope === 'personal' ? 'Private space' : 'Organization space'} · {space.channelCount === 1 ? '1 channel' : `${space.channelCount} channels`}
                    </p>
                  </div>
                </Tooltip.Content>
              </Tooltip.Portal>
            </Tooltip.Root>
            ))}
          </>}
        </nav>
        <div className="spaces-sidekick-slot" ref={sidekickSlotRef} />
        <div className="spaces-sidebar-footer">
          <div className="spaces-account-slot" ref={accountSlotRef} />
          <IconButton
            label={collapsed ? 'Expand spaces' : 'Collapse spaces'}
            aria-expanded={!collapsed}
            onClick={() => onCollapsedChange(!collapsed)}
          >
            {collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
          </IconButton>
        </div>
      </aside>
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
