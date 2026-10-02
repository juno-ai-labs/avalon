import { IconArchive, IconRestore } from '@tabler/icons-react';
import * as ContextMenu from '@radix-ui/react-context-menu';
import type { SpaceSummary } from '@rally/contracts';
import { SpaceIcon } from '@rally/ui/components/space-icon';
import { SpacePill, SpacePillAddButton, SpacePillStrip } from '@rally/ui/components/space-pills';
import { SidebarRefreshRow } from '@rally/ui/components/sidebar-refresh-row';
import { compareAlphabeticalName } from '@rally/ui/lib/alphabetical';
import clsx from 'clsx';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { useNavigate } from 'react-router-dom';

import { blockedChannelLabel, spaceFailureSentence, spaceRefusalChannelIds } from '../lib/space-failure-copy';
import type { WorkstreamSummary } from '../lib/types';
import { NewWorkstreamMenu } from './new-workstream-menu';
import { AcknowledgedErrorDialog, type AcknowledgedError } from './acknowledged-error-dialog';
import { Button, InlineError, Modal } from './primitives';

interface SpacePillsProps {
  inactiveSpaces: SpaceSummary[];
  loading?: boolean;
  readOnly?: boolean;
  /** Every active Space, General included; General is never drawn as a pill. */
  spaces: SpaceSummary[];
  /** The Space the list is filtered to, or null for All. */
  selectedSpaceId: string | null;
  revealSelection?: { revision: number; spaceId: string } | null;
  ready: boolean;
  outOfDate: boolean;
  onCreateChannel: (input: { name: string; spaceId: string }) => Promise<void>;
  onCreateSpace: (name: string) => Promise<void>;
  onArchive?: ((spaceId: string) => Promise<void>) | undefined;
  onMoveChannel: (sourceSpaceId: string, targetSpaceId: string, workstreamId: string) => Promise<void>;
  onRetry: () => void;
  onRestore: (spaceId: string) => Promise<void>;
  onSelect: (spaceId: string | null) => void;
  workstreams: WorkstreamSummary[];
}

const CHANNEL_DRAG_TYPE = 'application/x-rally-workstream-id';
const CHANNEL_DRAG_SOURCE_SPACE_TYPE = 'application/x-rally-channel-source-space-id';
const CHANNEL_DROP_ACCEPTED_FLASH_MS = 780;

/**
 * The Organization's Spaces as filters across the top of the sidebar.
 *
 * Navigation only, as the Spaces rail it replaces was: WorkspaceDO's Space
 * directory stays the authority, and a pill only says which placement list
 * the Channel list below draws. **All** is every Channel the reader holds.
 * General is the Organization's default home rather than a place anybody
 * chose, so it has no pill: its Channels are under All.
 *
 * All leads, then every other pill sorts by name, case-insensitive A–Z. The
 * order is not arranged by hand, so a pill has no drag or keyboard reorder;
 * dragging a Channel onto a pill still places it in that Space.
 */
export function SpacePills({
  inactiveSpaces,
  loading = false,
  readOnly = false,
  spaces,
  selectedSpaceId,
  revealSelection = null,
  ready,
  outOfDate,
  onCreateChannel,
  onCreateSpace,
  onArchive,
  onMoveChannel,
  onRetry,
  onRestore,
  onSelect,
  workstreams,
}: SpacePillsProps): React.JSX.Element {
  const navigate = useNavigate();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const revealedRevision = useRef<number | null>(null);
  const [failure, setFailure] = useState<AcknowledgedError | null>(null);
  const [channelDropTargetId, setChannelDropTargetId] = useState<string | null>(null);
  const [acceptedChannelDropTargetId, setAcceptedChannelDropTargetId] = useState<string | null>(null);
  const acceptedChannelDropTimer = useRef<{
    handle: ReturnType<typeof setTimeout>;
    token: number;
  } | null>(null);
  const acceptedChannelDropGeneration = useRef(0);
  const [archiveTarget, setArchiveTarget] = useState<SpaceSummary | null>(null);
  const [archiveFailure, setArchiveFailure] = useState<string | null>(null);
  const [archiveSaving, setArchiveSaving] = useState(false);
  const [blockedChannelIds, setBlockedChannelIds] = useState<string[]>([]);
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const [restoreFailed, setRestoreFailed] = useState(false);
  useEffect(() => () => {
    if (acceptedChannelDropTimer.current !== null) {
      clearTimeout(acceptedChannelDropTimer.current.handle);
    }
  }, []);
  const orderedSpaces = useMemo(() => spaces
    .filter((space) => space.systemRole !== 'general')
    .sort(compareAlphabeticalName), [spaces]);
  useLayoutEffect(() => {
    if (revealSelection === null || revealedRevision.current === revealSelection.revision) return;
    const pill = scrollRef.current?.querySelector<HTMLElement>(
      `[data-space-id="${revealSelection.spaceId}"]`,
    );
    if (!pill) return;
    revealedRevision.current = revealSelection.revision;
    pill.scrollIntoView?.({ block: 'nearest', inline: 'nearest', behavior: 'auto' });
  }, [orderedSpaces, revealSelection]);
  // The selected pill is brought into the strip's view, so a filter chosen
  // from a route, a new Space or a restore is never one the reader cannot see.
  useLayoutEffect(() => {
    if (selectedSpaceId === null) return;
    scrollRef.current?.querySelector<HTMLElement>(`[data-space-id="${selectedSpaceId}"]`)
      ?.scrollIntoView?.({ block: 'nearest', inline: 'nearest', behavior: 'auto' });
  }, [selectedSpaceId]);
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

  const flashAcceptedChannelDrop = (spaceId: string): number => {
    const token = acceptedChannelDropGeneration.current + 1;
    acceptedChannelDropGeneration.current = token;
    if (acceptedChannelDropTimer.current !== null) {
      clearTimeout(acceptedChannelDropTimer.current.handle);
    }
    setAcceptedChannelDropTargetId(spaceId);
    const handle = setTimeout(() => {
      if (acceptedChannelDropTimer.current?.token !== token) return;
      setAcceptedChannelDropTargetId(null);
      acceptedChannelDropTimer.current = null;
    }, CHANNEL_DROP_ACCEPTED_FLASH_MS);
    acceptedChannelDropTimer.current = { handle, token };
    return token;
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
      if (selectedSpaceId === archiveTarget.id) onSelect(null);
    } catch (cause) {
      setBlockedChannelIds(spaceRefusalChannelIds(cause));
      setArchiveFailure(spaceFailureSentence(cause, 'The space could not be archived.'));
    } finally {
      setArchiveSaving(false);
    }
  };

  const addButton = !readOnly && ready && <ContextMenu.Root>
    <ContextMenu.Trigger asChild disabled={restorableSpaces.length === 0}>
      <span className="space-pill-add-slot">
        <NewWorkstreamMenu offer="space" onCreateChannel={onCreateChannel} onCreateSpace={onCreateSpace} tooltipLabel="New space" trigger="direct">
          <SpacePillAddButton />
        </NewWorkstreamMenu>
      </span>
    </ContextMenu.Trigger>
    <ContextMenu.Portal>
      <ContextMenu.Content className="menu-content sidebar-context-menu" collisionPadding={8}>
        <ContextMenu.Item className="menu-item" onSelect={() => { setRestoreFailed(false); setRecoveryOpen(true); }}>
          <IconRestore aria-hidden="true" size={16} stroke={1.8} /> Restore archived space
        </ContextMenu.Item>
      </ContextMenu.Content>
    </ContextMenu.Portal>
  </ContextMenu.Root>;

  return (
    <>
      <SpacePillStrip leading={addButton || undefined} ref={scrollRef}>
        {!ready ? (
          <span className="space-pill-strip-note">Opening this organization…</span>
        ) : loading && spaces.length === 0 ? (
          <span aria-hidden="true" className="skeleton-bar space-pill-skeleton" />
        ) : <>
          {outOfDate && <SidebarRefreshRow onRefresh={onRetry} />}
          <SpacePill onClick={() => onSelect(null)} selected={selectedSpaceId === null}>All</SpacePill>
          {orderedSpaces.map((space) => (
            <ContextMenu.Root key={space.id}>
              <ContextMenu.Trigger asChild>
                <SpacePill
                  aria-description={space.scope === 'workspace' ? 'Public space' : undefined}
                  className={clsx(
                    channelDropTargetId === space.id && 'is-channel-drop-target',
                    acceptedChannelDropTargetId === space.id && 'is-channel-drop-accepted',
                  )}
                  data-space-id={space.id}
                  onClick={() => onSelect(space.id)}
                  onDragEnter={(event: DragEvent<HTMLElement>) => {
                    const placesChannel = space.reach !== 'through_channel'
                      && selectedSpaceId !== space.id
                      && event.dataTransfer.types.includes(CHANNEL_DRAG_TYPE)
                      && event.dataTransfer.types.includes(CHANNEL_DRAG_SOURCE_SPACE_TYPE);
                    if (placesChannel) {
                      event.preventDefault();
                      setChannelDropTargetId(space.id);
                    }
                  }}
                  onDragOver={(event: DragEvent<HTMLElement>) => {
                    const placesChannel = space.reach !== 'through_channel'
                      && selectedSpaceId !== space.id
                      && event.dataTransfer.types.includes(CHANNEL_DRAG_TYPE)
                      && event.dataTransfer.types.includes(CHANNEL_DRAG_SOURCE_SPACE_TYPE);
                    if (!placesChannel) return;
                    event.preventDefault();
                    event.dataTransfer.dropEffect = 'move';
                  }}
                  onDragLeave={(event: DragEvent<HTMLElement>) => {
                    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
                    setChannelDropTargetId((current) => current === space.id ? null : current);
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
                    // The row leaves the source list optimistically, so the
                    // destination acknowledges the same drop immediately. A
                    // server refusal still restores the placement and opens
                    // the failure dialog; the pulse describes the gesture,
                    // not network latency.
                    const dropToken = flashAcceptedChannelDrop(space.id);
                    void onMoveChannel(sourceSpaceId, space.id, workstreamId)
                      .catch((cause: unknown) => {
                        if (acceptedChannelDropTimer.current?.token === dropToken) {
                          clearTimeout(acceptedChannelDropTimer.current.handle);
                          acceptedChannelDropTimer.current = null;
                          setAcceptedChannelDropTargetId(null);
                        }
                        setFailure({
                          title: 'Channel could not be moved',
                          copy: spaceFailureSentence(
                            cause,
                            'The channel is still in the space it came from. Try again in a moment.',
                          ),
                        });
                      });
                  }}
                  selected={selectedSpaceId === space.id}
                >
                  {space.name}
                </SpacePill>
              </ContextMenu.Trigger>
              <ContextMenu.Portal>
                <ContextMenu.Content className="menu-content sidebar-context-menu" collisionPadding={8}>
                  <ContextMenu.Item className="menu-item" onSelect={() => void navigate(`/spaces/${space.id}`)}>
                    <SpaceIcon size={16} space={space} /> Open space
                  </ContextMenu.Item>
                  {space.reach !== 'through_channel' && onArchive !== undefined && <>
                  <ContextMenu.Separator className="menu-separator" />
                  <ContextMenu.Item className="menu-item menu-item-danger" onSelect={() => {
                    setArchiveFailure(null);
                    setBlockedChannelIds([]);
                    setArchiveTarget(space);
                  }}>
                    <IconArchive aria-hidden="true" size={16} stroke={1.8} /> Archive space
                  </ContextMenu.Item>
                  </>}
                </ContextMenu.Content>
              </ContextMenu.Portal>
            </ContextMenu.Root>
          ))}
        </>}
      </SpacePillStrip>
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
          {blockedChannelIds.map((id) => <li key={id}>{blockedChannelLabel(id, workstreams)}</li>)}
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
              .then(() => { setRecoveryOpen(false); onSelect(space.id); })
              .catch(() => setRestoreFailed(true));
          }}><SpaceIcon space={space} /> {space.name}</Button>
        ))}</div>
        {restoreFailed && <InlineError>The space couldn’t be restored.</InlineError>}
      </Modal>
    </>
  );
}
