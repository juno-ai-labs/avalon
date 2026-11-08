import type { CanvasDetail } from '@rally/contracts';
import { TitleMenuItem, TitlePillHeader, TitlePillTitleInput, type TitlePillLevel } from '@rally/ui/components/title-pill';
import { IconLink, IconPencil, IconPin, IconPinnedOff, IconUsers } from '@tabler/icons-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';

import { CanvasMark } from '../components/canvas-mark';
import { CanvasShareDialog } from '../components/canvas-share-dialog';
import { AvatarStack, Button, EmptyState, ErrorNotice, OpeningState } from '../components/primitives';
import { canvasDetailQueryKey, canvasRenameRefusal, canvasRenameRequested, useCanvasList, useCanvasNameSources } from '../lib/canvases';
import { copyLink } from '../lib/copy-link';
import { sidebarListApplied } from '../lib/sidebar-list-store';
import { useDocumentTitle } from '../lib/document-title';
import { isNotFoundError, useRestoredRouteFallback } from '../lib/landing';
import { useCollaborationSession } from '../lib/collaboration-session';
import { layoutKey, readArtifactPanel } from '../lib/desktop-layout';
import { openResourceRequest, openResourceState } from '../lib/navigation-routes';
import { ConversationOpeningSkeleton, ConversationSurface } from './conversation-surface';

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
  const leaving = useRestoredRouteFallback(canvas.error, '/canvases');
  const { membersById } = useCanvasNameSources(api);
  const [sharing, setSharing] = useState(false);
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
  // A link that opens the Canvas onto one artifact arrives here as
  // `?artifact=` (the browser host's form of the link's `/a/` segment); it
  // becomes the route state the rail opens from, as a desktop deep link's does.
  const linkedArtifact = new URLSearchParams(location.search).get('artifact');
  useEffect(() => {
    if (linkedArtifact) void navigate(location.pathname, { replace: true, state: openResourceState(id, linkedArtifact) });
  }, [id, linkedArtifact, location.pathname, navigate]);
  useOpenNewestArtifact(id, canvas.data, session?.workspace?.id, session?.user.id, linkedArtifact ? openResourceState(id, linkedArtifact) : location.state, (resourceId) => {
    void navigate(`${location.pathname}${location.search}`, { replace: true, state: openResourceState(id, resourceId) });
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
  const rowTitle = row?.title;
  const seenRowTitle = useRef(rowTitle);
  useEffect(() => {
    if (seenRowTitle.current === rowTitle) return;
    seenRowTitle.current = rowTitle;
    if (rowTitle === undefined || !sidebarListApplied(queryClient, 'canvases')) return;
    queryClient.setQueryData<CanvasDetail>(canvasDetailQueryKey(id), (cached) => cached && cached.title !== rowTitle ? { ...cached, title: rowTitle } : cached);
  }, [id, queryClient, rowTitle]);
  const title = canvas.data?.title ?? row?.title ?? '';
  useDocumentTitle(title || undefined);
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
  const pinned = row ? row.pinnedPosition !== null : false;
  const togglePin = (): void => {
    if (!api) return;
    setPinError(null);
    api.setCanvasPinned(id, !pinned).catch((cause: unknown) => setPinError(cause instanceof Error ? cause : new Error('The Canvas could not be pinned.')));
  };
  if (leaving) return <OpeningState label="Opening Canvases…" />;
  if (canvas.error && !row) {
    return <div className="screen-error-state screen-with-titlebar">
      <div className="screen-drag-strip window-drag" />
      {/* A malformed id names nothing that could exist, so it reads as a missing one does. */}
      <ErrorNotice title="Canvas could not be opened">{isNotFoundError(canvas.error) ? 'This Canvas does not exist.' : canvas.error.message}</ErrorNotice>
      <EmptyState action={<Button onClick={() => void canvas.refetch()}>Try again</Button>} description="It may have been removed, or you may no longer have access." title="Canvas" />
    </div>;
  }
  // A Canvas this window has not seen in its list is opened once its detail
  // answers, so a link to one that does not exist draws the state above rather
  // than a conversation whose socket then fails as well. One in the list opens
  // at once, beside the detail read.
  if (!row && !canvas.data) return <ConversationOpeningSkeleton label="Opening Canvas…" parentKind="canvas" />;
  const mark = <CanvasMark kind={canvas.data?.artifacts[0]?.kind ?? row?.artifactKind ?? null} size={24} />;
  // Edited from the title the pill shows, so not before there is one to show.
  const level = (): TitlePillLevel => renaming && (canvas.data || row) ? {
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
    title,
    label: `Canvas menu: ${title}`,
    menu: <>
      <TitleMenuItem icon={pinned ? <IconPinnedOff aria-hidden="true" size={16} stroke={1.8} /> : <IconPin aria-hidden="true" size={16} stroke={1.8} />} onSelect={togglePin}>
        {pinned ? 'Unpin' : 'Pin'}
      </TitleMenuItem>
      <TitleMenuItem disabled={!api} icon={<IconPencil aria-hidden="true" size={16} stroke={1.8} />} onSelect={() => { setRenameError(null); setRenaming(true); }}>
        Rename…
      </TitleMenuItem>
      <TitleMenuItem disabled={!canvas.data} icon={<IconUsers aria-hidden="true" size={16} stroke={1.8} />} onSelect={() => setSharing(true)}>
        Share…
      </TitleMenuItem>
      <TitleMenuItem disabled={!workspace} icon={<IconLink aria-hidden="true" size={16} stroke={1.8} />} onSelect={copyCanvasLink}>
        Copy link
      </TitleMenuItem>
    </>,
  };
  return <>
    {pinError && <ErrorNotice occurrence={pinError}>The Canvas could not be pinned. Try again.</ErrorNotice>}
    {linkError && <ErrorNotice occurrence={linkError}>The link couldn’t be copied.</ErrorNotice>}
    {renameError && <ErrorNotice occurrence={renameError} title="The Canvas could not be renamed">{canvasRenameRefusal(renameError)}</ErrorNotice>}
    <ConversationSurface
      parentId={id}
      parentKind="canvas"
      renderHeader={(context) => {
        const present = context.presentUserIds.filter((userId) => userId !== session?.user.id).flatMap((userId) => {
          const member = membersById.get(userId);
          return member ? [member] : [];
        });
        return <TitlePillHeader
          current={level()}
          trailing={<span className="canvas-header-trailing">
            {present.length > 0 && <span aria-label={`${present.length} ${present.length === 1 ? 'person' : 'people'} here`} className="canvas-header-present" role="group">
              <AvatarStack currentUserId={session?.user.id ?? null} members={present} presentUserIds={context.presentUserIds} />
            </span>}
            <Button className="canvas-share-button" disabled={!canvas.data} onClick={() => setSharing(true)}>Share</Button>
          </span>}
        />;
      }}
      substreamId="0"
    />
    {canvas.data && <CanvasShareDialog canvas={canvas.data} onOpenChange={(open) => {
      setSharing(open);
      if (!open) void queryClient.invalidateQueries({ queryKey: canvasDetailQueryKey(id) });
    }} open={sharing} />}
  </>;
}

/**
 * Open the Canvas's newest artifact once its detail says it has one, unless
 * this conversation already restores a panel or the navigation asked for an
 * artifact. Once per opening: closing the panel afterwards keeps it closed.
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
