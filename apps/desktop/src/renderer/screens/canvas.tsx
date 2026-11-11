import type { CanvasDetail, WorkstreamAppearancePatch } from '@rally/contracts';
import { AppearancePicker } from '@rally/ui/components/appearance-picker';
import { ActionTile, ActionTiles, TitleMenuItem, TitleMenuSeparator, TitlePillHeader, TitlePillTitleInput, type TitlePillLevel } from '@rally/ui/components/title-pill';
import { IconArchive, IconLayoutSidebarRight, IconLink, IconPalette, IconPencil, IconPin, IconPinnedOff, IconUsers } from '@tabler/icons-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';

import { useActivityList } from '../components/activity-sidebar-section';
import { CanvasAccessRequestPane } from '../components/canvas-access-request';
import { ComposerAgentActivity } from '../components/composer-agent-activity';
import { useOptionalWorkspaceSocket } from '../lib/workspace-socket';
import { CanvasMark, canvasHue } from '../components/canvas-mark';
import { PaneState } from '../components/pane-state';
import { CanvasShareDialog } from '../components/canvas-share-dialog';
import { CanvasSidekicksSection, madeSidekicksArchiveCopy } from '../components/canvas-sidekicks-menu';
import { AvatarStack, Button, EmptyState, ErrorNotice, Modal, OpeningState, TitleSkeleton } from '../components/primitives';
import { canvasAccessQueryKey, canvasDetailQueryKey, canvasNaming, canvasRenameRefusal, canvasRenameRequested, canvasShareRequested, useCanvasList, useCanvasNameSources } from '../lib/canvases';
import { copyLink } from '../lib/copy-link';
import { sidebarListApplied } from '../lib/sidebar-list-store';
import { useDocumentTitle } from '../lib/document-title';
import { ApiError } from '../lib/api';
import { isNotFoundError, useRestoredRouteFallback } from '../lib/landing';
import { useCollaborationSession } from '../lib/collaboration-session';
import { layoutKey, readArtifactPanel } from '../lib/desktop-layout';
import { openResourceRequest, openResourceState } from '../lib/navigation-routes';
import { SidekickPanel } from './automation';
import { ConversationOpeningSkeleton, ConversationSurface, type ConversationHeaderContext } from './conversation-surface';

/**
 * `/canvases/:id`: a Canvas open. Its Chat, the `canvas`-kind conversation
 * whose parent id is the Canvas id, fills the main pane as a Thread's does,
 * and its artifacts open in the same right rail, with the same per-conversation
 * restore (`artifact-panel:<canvas>:0`). Arriving with nothing saved there, the
 * newest artifact opens; a Canvas with none opens with the rail closed.
 * `docs/canvases.md` owns the model.
 */
export function CanvasScreen(): React.JSX.Element {
  const { id } = useParams();
  if (!id) return <EmptyState description="This link names no Canvas." title="Canvas" />;
  return <CanvasConversation id={id} key={id} />;
}

function CanvasConversation({ id }: { id: string }): React.JSX.Element {
  const { api, session } = useCollaborationSession();
  const workspaceSocket = useOptionalWorkspaceSocket();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const canvas = useQuery({
    queryKey: canvasDetailQueryKey(id),
    queryFn: ({ signal }) => api!.getCanvas(id, signal),
    enabled: Boolean(api),
    staleTime: 5_000,
  });
  // The list row paints the name before the detail answers.
  const row = useCanvasList()?.find((candidate) => candidate.id === id);
  // A Canvas that answered not found may exist in the Organization without
  // admitting this person; only then is its access asked, so opening one they
  // are in costs nothing more. A malformed id names nothing to ask about.
  const unreachable = !row && canvas.error instanceof ApiError && canvas.error.status === 404;
  const access = useQuery({
    queryKey: canvasAccessQueryKey(id),
    queryFn: ({ signal }) => api!.getCanvasAccess(id, signal),
    enabled: Boolean(api) && unreachable,
    retry: false,
  });
  // Only a Canvas that exists nowhere leaves a restored route: a requestable
  // one keeps it, since it may be granted later.
  const leaving = useRestoredRouteFallback(unreachable ? access.error : canvas.error, '/canvases');
  // The grant opens the Canvas without a refresh: it arrives as the Canvas
  // joining this person's list, or as their `access_granted` row.
  const activityItems = useActivityList()?.items;
  const granted = activityItems?.find((item) => item.kind === 'access_granted' && item.parentId === id)?.id;
  // A decline arrives as the requester's `access_denied` row: the pane then
  // reads the access again, which says declined and offers Request access.
  const declined = activityItems?.find((item) => item.kind === 'access_denied' && item.parentId === id)?.id;
  const listed = Boolean(row);
  const refetchCanvas = canvas.refetch;
  const awaitingGrant = Boolean(canvas.error) && access.data !== undefined;
  useEffect(() => {
    if (awaitingGrant && (listed || granted)) void refetchCanvas();
  }, [awaitingGrant, granted, listed, refetchCanvas]);
  // Only a decline that arrives after the access read landed re-reads it: a
  // row already listed when the pane opened is what that read answered.
  const refetchAccess = access.refetch;
  const answeredDecline = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (!awaitingGrant) return;
    if (answeredDecline.current === undefined) {
      answeredDecline.current = declined ?? null;
      return;
    }
    if (declined && declined !== answeredDecline.current) {
      answeredDecline.current = declined;
      void refetchAccess();
    }
  }, [awaitingGrant, declined, refetchAccess]);
  // The access read says the viewer can open it after all: the detail's 404
  // was stale (a grant landing between the two reads), so read it again.
  const alreadyOpen = access.error instanceof ApiError && access.error.code === 'canvas_access_open';
  useEffect(() => {
    if (alreadyOpen) void refetchCanvas();
  }, [alreadyOpen, refetchCanvas]);
  const { membersById } = useCanvasNameSources(api);
  const [sharing, setSharing] = useState(false);
  const [confirmingArchive, setConfirmingArchive] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [archiveError, setArchiveError] = useState<Error | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const archiveCanvas = async (): Promise<void> => {
    if (!api || archiving) return;
    setArchiving(true);
    setArchiveError(null);
    try {
      await api.archiveCanvas(id);
      queryClient.removeQueries({ queryKey: canvasDetailQueryKey(id) });
      if (mounted.current) void navigate('/canvases', { replace: true });
    } catch (cause) {
      if (mounted.current) setArchiveError(cause instanceof Error ? cause : new Error('The Canvas could not be archived.'));
    } finally {
      if (mounted.current) setArchiving(false);
    }
  };
  // The Sidekicks attached to it, from the list row the socket keeps current:
  // one the Chat just made, or one renamed, paused or archived, arrives there
  // while this screen's detail is still the copy it opened with. The detail
  // serves until the list has the row; a server older than attaching sends none.
  const sidekicks = row?.sidekicks ?? canvas.data?.sidekicks ?? [];
  const [choosingAppearance, setChoosingAppearance] = useState(false);
  const [pinError, setPinError] = useState<Error | null>(null);
  const [linkError, setLinkError] = useState<Error | null>(null);
  const [renaming, setRenaming] = useState(() => canvasRenameRequested(location.state));
  const [renamePending, setRenamePending] = useState(false);
  const [renameError, setRenameError] = useState<Error | null>(null);
  // The sidebar row's Rename… arrives as route state; it is spent once read,
  // so Back to this entry does not start another edit.
  const renameRequested = canvasRenameRequested(location.state);
  useEffect(() => {
    if (!renameRequested) return;
    setRenaming(true);
    void navigate(`${location.pathname}${location.search}`, { replace: true, state: null });
  }, [location.pathname, location.search, navigate, renameRequested]);
  // The row's Share… arrives the same way, and opens the panel once the
  // detail it shares has answered.
  const shareRequested = canvasShareRequested(location.state);
  useEffect(() => {
    if (!shareRequested || !canvas.data) return;
    setSharing(true);
    void navigate(`${location.pathname}${location.search}`, { replace: true, state: null });
  }, [canvas.data, location.pathname, location.search, navigate, shareRequested]);
  // A link that opens the Canvas onto one artifact arrives here as
  // `?artifact=` on both hosts (`canvasArtifactRoute`, the form of the link's
  // `/a/` segment); it becomes the route state the rail opens from.
  const linkedArtifact = new URLSearchParams(location.search).get('artifact');
  useEffect(() => {
    if (linkedArtifact) void navigate(location.pathname, { replace: true, state: openResourceState(id, linkedArtifact) });
  }, [id, linkedArtifact, location.pathname, navigate]);
  // Beside the Chat, not over it: nobody asked for this artifact, so the
  // conversation they opened stays in view.
  useOpenNewestArtifact(id, canvas.data, session?.workspace?.id, session?.user.id, linkedArtifact ? openResourceState(id, linkedArtifact) : location.state, (resourceId) => {
    void navigate(`${location.pathname}${location.search}`, { replace: true, state: openResourceState(id, resourceId, { expanded: false }) });
  });
  const workspace = session?.workspace;
  const copyCanvasLink = (): void => {
    if (!workspace) return;
    setLinkError(null);
    copyLink({ kind: 'canvas', region: workspace.region, workspaceId: workspace.id, canvasId: id })
      .catch((cause: unknown) => setLinkError(cause instanceof Error ? cause : new Error('The link could not be copied.')));
  };
  // A rename from anywhere reaches this window as the list's push, which
  // carries the row's new title; the detail is not pushed, so the push writes
  // its title through rather than leaving the header on the old one until a
  // refetch. Only a change, and only once the socket has applied the list:
  // the device cache seeds the list too, asynchronously and without the
  // ledger, and its row may be older than the detail the server just answered.
  // The naming state moves the same way, and on its own: naming can settle
  // and leave the title as it was (no model, an empty answer).
  // A chosen icon or colour travels the same way, as the row's appearance.
  const rowTitle = row?.title;
  const rowTitleStatus = row?.titleStatus;
  const rowIcon = row?.appearance?.icon;
  const rowColor = row?.appearance?.color;
  const seenRow = useRef({ title: rowTitle, titleStatus: rowTitleStatus, icon: rowIcon, color: rowColor });
  useEffect(() => {
    const seen = seenRow.current;
    if (seen.title === rowTitle && seen.titleStatus === rowTitleStatus && seen.icon === rowIcon && seen.color === rowColor) return;
    seenRow.current = { title: rowTitle, titleStatus: rowTitleStatus, icon: rowIcon, color: rowColor };
    if (rowTitle === undefined || !sidebarListApplied(queryClient, 'canvases')) return;
    queryClient.setQueryData<CanvasDetail>(canvasDetailQueryKey(id), (cached) => {
      if (!cached) return cached;
      const sameAppearance = rowIcon === undefined || (cached.appearance?.icon === rowIcon && cached.appearance.color === rowColor);
      if (cached.title === rowTitle && cached.titleStatus === rowTitleStatus && sameAppearance) return cached;
      const next: CanvasDetail = { ...cached, title: rowTitle };
      if (rowTitleStatus) next.titleStatus = rowTitleStatus;
      else delete next.titleStatus;
      if (rowIcon !== undefined && rowColor !== undefined) next.appearance = { icon: rowIcon, color: rowColor };
      return next;
    });
  }, [id, queryClient, rowColor, rowIcon, rowTitle, rowTitleStatus]);
  const title = canvas.data?.title ?? row?.title ?? '';
  const naming = canvasNaming(canvas.data ?? row);
  const missing = Boolean(canvas.error && !row && isNotFoundError(unreachable ? access.error : canvas.error));
  const requestable = unreachable && access.data !== undefined;
  useDocumentTitle(missing ? 'Canvas not found' : requestable ? 'Request access' : naming ? undefined : title || undefined);
  const saveTitle = (next: string): void => {
    if (!api) return;
    setRenamePending(true);
    setRenameError(null);
    api.renameCanvas(id, next).then((updated) => {
      queryClient.setQueryData(canvasDetailQueryKey(id), updated);
      setRenaming(false);
    }, (cause: unknown) => {
      setRenameError(cause instanceof Error ? cause : new Error('The Canvas could not be renamed.'));
    }).finally(() => setRenamePending(false));
  };
  const cancelRename = (): void => {
    setRenaming(false);
    setRenameError(null);
  };
  // One choice saved; the answer is the detail, so the pill draws it at once.
  // A refusal rejects, which the picker shows as its error.
  const saveAppearance = async (patch: WorkstreamAppearancePatch): Promise<void> => {
    if (!api) throw new Error('Not connected');
    queryClient.setQueryData(canvasDetailQueryKey(id), await api.setCanvasAppearance(id, patch));
  };
  const pinned = row ? row.pinnedPosition !== null : false;
  const togglePin = (): void => {
    if (!api) return;
    setPinError(null);
    api.setCanvasPinned(id, !pinned).catch((cause: unknown) => setPinError(cause instanceof Error ? cause : new Error('The Canvas could not be pinned.')));
  };
  if (leaving) return <OpeningState label="Opening Canvases…" />;
  if (canvas.error && !row) {
    // One in-pane state, never a dialog over it (canvases.md). A malformed id
    // names nothing that could exist, so it reads as a missing one does, and
    // there is nothing to try again. One that exists but does not admit this
    // person offers Request access instead.
    if (unreachable) {
      if (access.data) return <CanvasAccessRequestPane access={access.data} canvasId={id} />;
      if (!access.error || alreadyOpen) return <ConversationOpeningSkeleton label="Opening Canvas…" parentKind="canvas" />;
      // A guest cannot ask to be let in, and the refusal says nothing about
      // whether the Canvas exists, so neither does the pane. Trying again
      // would only be refused again.
      if (access.error instanceof ApiError && access.error.code === 'canvas_access_request_not_member') {
        return <PaneState description="It may have been removed, or it has not been shared with you. Ask whoever sent the link to share it." title="You can’t open this Canvas." />;
      }
      if (!isNotFoundError(access.error)) {
        return <PaneState action={<Button onClick={() => void access.refetch()}>Try again</Button>} description={access.error.message} title="This Canvas could not be opened." />;
      }
    }
    if (isNotFoundError(canvas.error)) {
      return <PaneState description="It may have been removed, or the link may be wrong." title="This Canvas does not exist." />;
    }
    return <PaneState action={<Button onClick={() => void canvas.refetch()}>Try again</Button>} description={canvas.error.message} title="This Canvas could not be opened." />;
  }
  // A Canvas this window has not seen in its list is opened once its detail
  // answers, so a link to one that does not exist draws the state above rather
  // than a conversation whose socket then fails as well. One in the list opens
  // at once, beside the detail read.
  if (!row && !canvas.data) return <ConversationOpeningSkeleton label="Opening Canvas…" parentKind="canvas" />;
  const newestArtifact = canvas.data?.artifacts[0];
  const appearance = canvas.data?.appearance ?? row?.appearance;
  const kind = canvas.data?.artifacts[0]?.kind ?? row?.artifactKind ?? null;
  const mark = <CanvasMark appearance={appearance} id={id} kind={kind} size={24} />;
  // The mark is the palette's own button, as a Sidekick's hexagon is (the
  // pill's icon action, beside its menu trigger); the menu's Change appearance
  // opens the same palette from there.
  const appearancePicker = <AppearancePicker
    {...(appearance ? { appearance } : {})}
    defaults={{ icon: null, color: canvasHue(id) }}
    id={id}
    label="Change appearance"
    onChange={saveAppearance}
    onOpenChange={setChoosingAppearance}
    open={choosingAppearance}
    renderGlyph={(chosen) => <CanvasMark appearance={chosen} id={id} kind={kind} size={24} />}
  />;
  // Keep the common actions in the same tile row as an artifact's title menu.
  const menuItems = (panelOpen: boolean, openPanel?: ConversationHeaderContext['openPanel']): React.JSX.Element => <>
    <ActionTiles>
      <ActionTile disabled={!canvas.data} icon={<IconUsers aria-hidden="true" size={20} stroke={1.6} />} label="Share" onSelect={() => setSharing(true)} />
      <ActionTile disabled={!newestArtifact || panelOpen} disabledReason={!newestArtifact ? 'This Canvas has no artifacts yet.' : panelOpen ? 'The artifact panel is already open.' : undefined} icon={<IconLayoutSidebarRight aria-hidden="true" size={20} stroke={1.6} />} label="Open artifact" onSelect={() => {
        // Replace the entry so Back leaves the Canvas rather than reopening its panel.
        if (newestArtifact) void navigate(location.pathname, { replace: true, state: openResourceState(id, newestArtifact.resourceId, { expanded: false }) });
      }} />
      <ActionTile disabled={!workspace} icon={<IconLink aria-hidden="true" size={20} stroke={1.6} />} label="Copy link" onSelect={copyCanvasLink} />
      <ActionTile disabled={!api} icon={pinned ? <IconPinnedOff aria-hidden="true" size={20} stroke={1.6} /> : <IconPin aria-hidden="true" size={20} stroke={1.6} />} label={pinned ? 'Unpin' : 'Pin'} onSelect={togglePin} />
    </ActionTiles>
    <TitleMenuItem disabled={!api} icon={<IconPencil aria-hidden="true" size={16} stroke={1.8} />} onSelect={() => { setRenameError(null); setRenaming(true); }}>
      Rename…
    </TitleMenuItem>
    {/* The palette the pill's mark opens, the Sidekick's own. */}
    <TitleMenuItem disabled={!api} icon={<IconPalette aria-hidden="true" size={16} stroke={1.8} />} onSelect={() => {
      setChoosingAppearance(true);
    }}>
      Change appearance
    </TitleMenuItem>
    <CanvasSidekicksSection
      onOpen={(sidekick) => {
        if (!openPanel) { void navigate(`/sidekicks/${encodeURIComponent(sidekick.id)}`); return; }
        openPanel({
        key: `sidekick:${sidekick.id}`,
        label: `Sidekick: ${sidekick.name}`,
        render: (controls) => <SidekickPanel id={sidekick.id} key={sidekick.id} controls={controls} />,
        });
      }}
      sidekicks={sidekicks}
    />
    {canvas.data?.canManage && <>
      <TitleMenuSeparator />
      <TitleMenuItem danger disabled={!api || archiving} icon={<IconArchive aria-hidden="true" size={16} stroke={1.8} />} onSelect={() => {
        setArchiveError(null);
        setConfirmingArchive(true);
      }}>Archive canvas</TitleMenuItem>
    </>}
  </>;
  // Edited from the title the pill shows, so not before there is one to show.
  const level = (panelOpen: boolean, openPanel?: ConversationHeaderContext['openPanel']): TitlePillLevel => renaming && (canvas.data || row) ? {
    // Set aside while the title is edited, so a click in the field is not a press of the menu.
    key: `canvas:${id}`,
    icon: mark,
    title: <TitlePillTitleInput
      initial={title}
      label="Canvas title"
      onCancel={cancelRename}
      onSave={saveTitle}
      pending={renamePending}
    />,
    label: 'Canvas title',
  } : {
    key: `canvas:${id}`,
    icon: mark,
    title: naming ? <TitleSkeleton className="title-skeleton-header" /> : title,
    label: naming ? 'Canvas menu: Rally is choosing a name' : `Canvas menu: ${title}`,
    menu: menuItems(panelOpen, openPanel),
    iconAction: appearancePicker,
  };
  const header = (presentUserIds: readonly string[], panelOpen: boolean, openPanel?: ConversationHeaderContext['openPanel']): React.JSX.Element => {
    const present = presentUserIds.filter((userId) => userId !== session?.user.id).flatMap((userId) => {
      const member = membersById.get(userId);
      return member ? [member] : [];
    });
    return <TitlePillHeader
      current={level(panelOpen, openPanel)}
      trailing={<span className="canvas-header-trailing">
        {present.length > 0 && <span aria-label={`${present.length} ${present.length === 1 ? 'person' : 'people'} here`} className="canvas-header-present" role="group">
          <AvatarStack currentUserId={session?.user.id ?? null} members={present} presentUserIds={presentUserIds} />
        </span>}
        <Button className="canvas-share-button" disabled={!canvas.data} onClick={() => setSharing(true)}>Share</Button>
      </span>}
    />;
  };
  const madeSidekicksCopy = madeSidekicksArchiveCopy(sidekicks);
  return <>
    {pinError && <ErrorNotice occurrence={pinError}>The Canvas could not be pinned. Try again.</ErrorNotice>}
    {linkError && <ErrorNotice occurrence={linkError}>The link couldn’t be copied.</ErrorNotice>}
    {renameError && <ErrorNotice occurrence={renameError} title="The Canvas could not be renamed">{canvasRenameRefusal(renameError)}</ErrorNotice>}
    <ConversationSurface
      parentId={id}
      parentKind="canvas"
      composerActivity={<ComposerAgentActivity activity={workspaceSocket?.state === 'connected' && workspaceSocket.sidebarReady
        ? (row?.runningActivity ?? (!canvas.isError ? canvas.data?.runningActivity : undefined)) : undefined} />}
      renderHeader={(context) => header(context.presentUserIds, context.panelOpen, context.openPanel)}
      // Offline, the Canvas is still named in the list: the pane keeps its
      // pill and Share over the state rather than a bare Back and Forward.
      stateHeader={header([], false)}
      substreamId="0"
    />
    {canvas.data && <CanvasShareDialog canvas={canvas.data} onOpenChange={(open) => {
      setSharing(open);
      if (!open) void queryClient.invalidateQueries({ queryKey: canvasDetailQueryKey(id) });
    }} open={sharing} />}
    <Modal
      footer={<>
        <Button disabled={archiving} onClick={() => setConfirmingArchive(false)}>Cancel</Button>
        <Button className="button-danger" disabled={archiving} onClick={() => void archiveCanvas()}>{archiving ? 'Archiving…' : 'Archive Canvas'}</Button>
      </>}
      onOpenChange={(open) => { if (!archiving) setConfirmingArchive(open); }}
      open={confirmingArchive}
      title="Archive Canvas"
    >
      <p className="modal-copy"><strong>{title}</strong> will be removed from everyone’s Canvases. Its conversation and artifacts will remain stored but will no longer be viewable in Rally.{madeSidekicksCopy && <> {madeSidekicksCopy}</>}</p>
      {archiveError && <ErrorNotice occurrence={archiveError}>The Canvas could not be archived. Try again.</ErrorNotice>}
    </Modal>
  </>;
}

/**
 * Open the Canvas's newest artifact once its detail says it has one, unless
 * this conversation already restores a panel or the navigation asked for an
 * artifact. Once per opening; later live attachments are handled separately
 * by ConversationSurface's useOpenAttachedArtifact.
 */
function useOpenNewestArtifact(
  canvasId: string,
  canvas: CanvasDetail | undefined,
  workspaceId: string | undefined,
  userId: string | undefined,
  routeState: unknown,
  open: (resourceId: string) => void,
): void {
  const decided = useRef(false);
  const newest = canvas?.artifacts[0]?.resourceId;
  useEffect(() => {
    if (decided.current || !canvas) return;
    decided.current = true;
    if (!newest || openResourceRequest(routeState)) return;
    const saved = readArtifactPanel(layoutKey(workspaceId ?? 'unbound', userId ?? 'unbound', `artifact-panel:${canvasId}:0`));
    if (!saved) open(newest);
  });
}
