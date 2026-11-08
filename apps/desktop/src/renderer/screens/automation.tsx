import { ErrorNotice } from '../components/primitives';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { PanelRight, Pencil, X } from 'lucide-react';
import { IconHistory, IconLink, IconPin, IconPinnedOff, IconPlayerPlay } from '@tabler/icons-react';
import { TitleMenuItem, TitlePillHeader, type TitlePillLevel } from '@rally/ui/components/title-pill';
import { CanvasMark } from '../components/canvas-mark';
import type { WorkstreamAppearancePatch } from '@rally/contracts';
import type { AutomationDetail } from '../lib/types';
import { SidekickDetailLayout, type SidekickDetailHeaderContext } from '../components/sidekick-detail-layout';
import { useSidekickList } from '../components/sidekick-sidebar-section';
import { AutomationGlyph } from '../components/workstream-glyph';
import { canvasRoute, useCanvasNameSources } from '../lib/canvases';
import { useOptionalWorkspaceSocket } from '../lib/workspace-socket';
import { AutomationHeader, type AutomationHeaderAction } from '../components/automation-header';
import { AvatarStack, Button, EmptyState, IconButton, OpeningState } from '../components/primitives';
import { useCollaborationSession } from '../lib/collaboration-session';
import { copyLink } from '../lib/copy-link';
import { useDocumentTitle } from '../lib/document-title';
import { useRestoredRouteFallback } from '../lib/landing';
import { ConversationSurface } from './conversation-surface';
import { SidekickDelegation, useSidekickDelegates } from '../components/sidekick-delegation';

/**
 * One route host for automations.
 *
 * `/automations/new` creates one and replaces itself with the automation's own
 * route, so Back never lands on a screen that would create another.
 * `/automations/:id` is the automation's conversation, where the draft is
 * written and later edited, under a header that carries its lifecycle.
 */
export function AutomationScreen(): React.JSX.Element {
  const { id } = useParams();
  if (id === undefined || id === 'new') return <NewAutomationScreen />;
  return <AutomationDetailScreen id={id} />;
}

/** A failed Sidekick screen's way on; the sidebar beside it is the way out. */
function ErrorActions({ onRetry }: { onRetry: () => void }): React.JSX.Element {
  return (
    <div className="empty-state-actions">
      <Button onClick={onRetry}>Try again</Button>
    </div>
  );
}

/**
 * Whether the viewer manages this Sidekick, as `HostedSidekick.managerAllows`
 * decides it for the scopes a client can see: its author, the person it runs
 * as, or an owner or admin of the Organization for an Organization Sidekick.
 * Only what the composer marks follows from it; the server decides again.
 */
function viewerManagesSidekick(
  detail: AutomationDetail,
  session: ReturnType<typeof useCollaborationSession>['session'],
): boolean {
  const userId = session?.user.id;
  if (!userId) return false;
  if (detail.authorUserId === userId || detail.runAsUserId === userId) return true;
  const role = session?.workspace?.role;
  return detail.scope === 'workspace' && (role === 'owner' || role === 'admin');
}

function NewAutomationScreen(): React.JSX.Element {
  const { api } = useCollaborationSession();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  // A draft already in this person's list is the one New Sidekick reopens:
  // drafts are theirs alone ("Only you") until saved, and a second one,
  // named "New Sidekick" like the first, was indistinguishable from it. The
  // list is the workspace socket's; without a socket there is no list to ask.
  const socket = useOptionalWorkspaceSocket();
  const rows = useSidekickList();
  const listKnown = !socket || rows !== undefined;
  const draft = rows?.find((row) => row.status === 'draft');
  // One request per visit, held in a ref rather than started by the effect
  // directly: React mounts an effect twice in development, and a request
  // started by the first run and abandoned by its cleanup would create an
  // automation nobody is then taken to. The promise survives the re-run, and
  // the re-run simply waits on it.
  const creation = useRef<Promise<{ automationId: string }> | null>(null);
  useEffect(() => {
    if (!api || !listKnown) return;
    let mounted = true;
    creation.current ??= draft ? Promise.resolve({ automationId: draft.id }) : api.createAutomation();
    creation.current
      .then(({ automationId }) => {
        if (mounted) void navigate(`/sidekicks/${automationId}`, { replace: true });
      })
      .catch((cause: unknown) => {
        if (!mounted) return;
        setError(cause instanceof Error ? cause.message : 'The Sidekick could not be created.');
      });
    return () => {
      mounted = false;
    };
  }, [api, draft, error, listKnown, navigate]);
  if (error) {
    return (
      <div className="screen-error-state screen-with-titlebar">
        <div className="screen-drag-strip window-drag" />
        <ErrorNotice title="Sidekick could not be created">{error}</ErrorNotice>
        <EmptyState
          action={<ErrorActions onRetry={() => { creation.current = null; setError(null); }} />}
          description="Try creating your Sidekick again."
          title="Sidekick"
        />
      </div>
    );
  }
  return <OpeningState label="Creating Sidekick…" />;
}

function AutomationDetailScreen({ id }: { id: string }): React.JSX.Element {
  const { api, session } = useCollaborationSession();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const delegates = useSidekickDelegates(id);
  const automation = useQuery({
    queryKey: ['automation', id],
    queryFn: ({ signal }) => api!.getAutomation(id, signal),
    enabled: Boolean(api),
    staleTime: 5_000,
  });
  const leaving = useRestoredRouteFallback(automation.error, '/sidekicks');
  useDocumentTitle(automation.data ? automation.data.currentDefinition?.name ?? automation.data.name : undefined);
  const runs = useQuery({
    queryKey: ['automation-runs', id],
    queryFn: ({ signal }) => api!.getAutomationRuns(id, signal),
    enabled: Boolean(api && automation.data && automation.data.lifecycle !== 'draft'),
    staleTime: 5_000,
  });
  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['automation', id] });
    void queryClient.invalidateQueries({ queryKey: ['automation-runs', id] });
  };
  const act = useMutation({
    mutationFn: async (action: AutomationHeaderAction) => {
      switch (action) {
        case 'pause': return queryClient.setQueryData(['automation', id], await api!.setAutomationStatus(id, 'pause'));
        case 'resume': return queryClient.setQueryData(['automation', id], await api!.setAutomationStatus(id, 'resume'));
        case 'run': return api!.runAutomation(id);
        case 'archive': return api!.archiveAutomation(id);
      }
    },
    onSuccess: (_result, action) => {
      void queryClient.invalidateQueries({ queryKey: ['sidekicks-library'] });
      if (action === 'archive') {
        // Replacing rather than pushing, so Back cannot return to an
        // automation that is no longer served.
        queryClient.removeQueries({ queryKey: ['automation', id] });
        void navigate('/sidekicks', { replace: true });
        return;
      }
      refresh();
    },
  });
  // Not part of `act`: that mutation is one-at-a-time and drives the header's
  // busy state, while a person picking a colour and then an icon fires twice in
  // a second and must not disable Pause between them. The picker owns its own
  // pending state; what it needs from here is the committed Sidekick, which the
  // response carries — so the detail cache is written directly rather than
  // invalidated, and everyone else's window is updated by the directory row the
  // write enqueues.
  //
  // One at a time all the same, because each response is a whole Sidekick and
  // the cache takes the last one to arrive. Two picks in flight together can
  // land in either order, and the loser would put the earlier Sidekick — the
  // one without the second choice — back on the screen, with nothing to correct
  // it until the directory push seconds later. The object merges them correctly
  // whatever order it sees; this is about which answer the screen keeps. The
  // chain is a ref so it survives a re-render, and a rejected link is caught
  // out of it so one refusal does not strand every later pick.
  //
  // The chain orders these requests against each other and nothing else, which
  // is why the write below is also guarded. A pause, a resume, or the workspace
  // socket's `automations` push all refresh this same entry while a pick is in
  // flight, and an older full response landing afterwards would put that whole
  // Sidekick back — a stale lifecycle, not just a stale icon — with the
  // notification that would have corrected it already spent. `updatedAt` is the
  // object's own clock and every mutation there bumps it, so a response older
  // than what is cached is a response with nothing left to say: whatever wrote
  // that newer entry read this appearance too.
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const setAppearance = (patch: WorkstreamAppearancePatch): Promise<void> => {
    const result = queue.current.then(async () => {
      const updated = await api!.setAutomationAppearance(id, patch);
      queryClient.setQueryData<AutomationDetail>(['automation', id], (cached) =>
        cached && cached.updatedAt > updated.updatedAt ? cached : updated);
      void queryClient.invalidateQueries({ queryKey: ['sidekicks-library'] });
    });
    queue.current = result.catch(() => undefined);
    return result;
  };
  if (leaving) return <OpeningState label="Opening Sidekicks…" />;
  if (automation.error) {
    return (
      <div className="screen-error-state screen-with-titlebar">
        <div className="screen-drag-strip window-drag" />
        <ErrorNotice title="Sidekick could not be opened">{automation.error.message}</ErrorNotice>
        <EmptyState
          action={<ErrorActions onRetry={() => void automation.refetch()} />}
          description="Try opening your Sidekick again."
          title="Sidekick"
        />
      </div>
    );
  }
  if (!automation.data) return <OpeningState label="Opening Sidekick…" />;
  const detail = automation.data;
  const copySidekickLink = async (): Promise<void> => {
    if (!session?.workspace) throw new Error('No active organization');
    await copyLink({ kind: 'sidekick', region: session.workspace.region, workspaceId: session.workspace.id, sidekickId: id });
  };
  return (
    <SidekickDetailLayout key={id} details={<AutomationHeader
      automation={detail}
      delegateNames={new Map([...(delegates.data?.delegates ?? []), ...(delegates.data?.creator ? [delegates.data.creator] : [])].map((person) => [person.userId, person.displayName]))}
      delegation={<SidekickDelegation id={id} />}
      error={act.error?.message}
      onAppearanceChange={setAppearance}
      onArchive={() => act.mutateAsync('archive').then(() => undefined)}
      onCopyLink={copySidekickLink}
      onPause={() => act.mutate('pause')}
      onResume={() => act.mutate('resume')}
      onRunNow={() => act.mutate('run')}
      pending={act.isPending ? act.variables : null}
      runs={runs.data}
      runsError={runs.error?.message}
    />} header={(context) => <SidekickHeader
      context={context}
      detail={detail}
      onCopyLink={copySidekickLink}
      onRunNow={detail.lifecycle === 'active' && !act.isPending ? () => act.mutate('run') : undefined}
    />}>
      <SidekickConversation detail={detail} manages={viewerManagesSidekick(detail, session)} />
    </SidekickDetailLayout>
  );
}

/**
 * The Sidekick's one header, at every width: its pill (its glyph and name,
 * opening the menu a Canvas's pill opens) after Back and Forward, and who is
 * here. While a run is open the pill is the run's, with the Sidekick's as the
 * crumb before it that leads back to the shared conversation. Where the
 * details do not fit beside the conversation, a Details button switches to
 * them under this same header.
 */
function SidekickHeader({ context, detail, onCopyLink, onRunNow }: {
  context: SidekickDetailHeaderContext;
  detail: AutomationDetail;
  onCopyLink: () => Promise<void>;
  /** Absent while the Sidekick cannot start a run; the details say why. */
  onRunNow: (() => void) | undefined;
}): React.JSX.Element {
  const { api, session } = useCollaborationSession();
  const [search, setSearch] = useSearchParams();
  const runId = search.get('run');
  const name = detail.currentDefinition?.name ?? detail.name;
  const row = useSidekickList()?.find((candidate) => candidate.id === detail.id);
  const pinned = row?.pinnedPosition != null;
  const [menuError, setMenuError] = useState<string | null>(null);
  const { membersById } = useCanvasNameSources(api);
  const presentUserIds = useOptionalWorkspaceSocket()?.presenceUserIdsByWorkstream[detail.id] ?? NO_PRESENCE;
  const present = presentUserIds.filter((userId) => userId !== session?.user.id).flatMap((userId) => {
    const member = membersById.get(userId);
    return member ? [member] : [];
  });
  const mark = <span className="sidekick-pill-mark"><AutomationGlyph {...(detail.appearance ? { appearance: detail.appearance } : {})} id={detail.id} /></span>;
  const sidekickLevel: TitlePillLevel = {
    key: `sidekick:${detail.id}`,
    icon: mark,
    title: name,
    label: `Sidekick menu: ${name}`,
    menu: <>
      {api && row && <TitleMenuItem icon={pinned ? <IconPinnedOff aria-hidden="true" size={16} stroke={1.8} /> : <IconPin aria-hidden="true" size={16} stroke={1.8} />} onSelect={() => {
        setMenuError(null);
        api.setSidekickPinned(detail.id, !pinned).catch(() => setMenuError('The Sidekick could not be pinned. Try again.'));
      }}>{pinned ? 'Unpin' : 'Pin'}</TitleMenuItem>}
      <TitleMenuItem disabled={!onRunNow} icon={<IconPlayerPlay aria-hidden="true" size={16} stroke={1.8} />} onSelect={() => onRunNow?.()}>Run now</TitleMenuItem>
      <TitleMenuItem icon={<IconLink aria-hidden="true" size={16} stroke={1.8} />} onSelect={() => {
        setMenuError(null);
        void onCopyLink().catch(() => setMenuError('The Sidekick link could not be copied.'));
      }}>Copy link</TitleMenuItem>
    </>,
  };
  const current: TitlePillLevel = runId
    ? { key: `run:${runId}`, icon: <IconHistory aria-hidden="true" size={16} stroke={1.8} />, title: 'Run', label: 'Run' }
    : sidekickLevel;
  // Back to the shared conversation replaces the history entry, so Back
  // leaves the Sidekick rather than reopening the run.
  const ancestors: TitlePillLevel[] = runId
    ? [{ ...sidekickLevel, menu: undefined, label: `Back to ${name}`, onSelect: () => setSearch({}, { replace: true }) }]
    : [];
  return <>
    {menuError && <ErrorNotice>{menuError}</ErrorNotice>}
    <TitlePillHeader
      ancestors={ancestors}
      current={current}
      trailing={<span className="canvas-header-trailing">
        {present.length > 0 && <span aria-label={`${present.length} ${present.length === 1 ? 'person' : 'people'} here`} className="canvas-header-present" role="group">
          <AvatarStack currentUserId={session?.user.id ?? null} members={present} presentUserIds={presentUserIds} />
        </span>}
        {context.compact && <IconButton aria-pressed={context.detailsOpen} className="title-pill-action" label="Sidekick details" onClick={context.toggleDetails}>
          <PanelRight aria-hidden="true" size={16} />
        </IconButton>}
      </span>}
    />
  </>;
}

const NO_PRESENCE: readonly string[] = [];

/**
 * The Sidekick's shared conversation (substream `"0"`), or one run's own
 * conversation while `?run=` names it. Everyone the Sidekick is shared with
 * talks here; a message addressed to the Sidekick starts a run, whose row the
 * server writes into this feed. A manager edits the Sidekick from the same
 * composer by switching on Edit Sidekick, which marks each message
 * `intent: "edit_sidekick"` for the wizard; nobody else is offered it, and
 * the server refuses the mark from anyone else. A draft has nothing to run
 * yet, so a manager opens one already editing.
 */
function SidekickConversation({ detail, manages }: { detail: AutomationDetail; manages: boolean }): React.JSX.Element {
  const [search] = useSearchParams();
  const runId = search.get('run');
  const [editing, setEditing] = useState(detail.lifecycle === 'draft');
  const name = detail.currentDefinition?.name ?? detail.name;
  if (runId) {
    return <ConversationSurface
      key={`run:${runId}`}
      parentId={detail.id}
      parentKind="automation"
      // No composer: a message to the Sidekick goes in the shared
      // conversation, where it starts the next run. A question the run asked
      // keeps its answer form here, as it does on the run's row there.
      withoutComposer
      renderHeader={() => <header className="sidekick-conversation-heading" />}
      substreamId={runId}
    />;
  }
  const edit = manages && editing;
  const canvases = detail.canvases ?? [];
  return <ConversationSurface
    {...(manages ? { composerMenuActions: [{
      checked: editing,
      icon: <Pencil aria-hidden="true" />,
      label: 'Edit Sidekick',
      onSelect: () => setEditing((current) => !current),
    }] } : {})}
    composerPlaceholder={edit ? 'Describe a change to this Sidekick…' : `Message ${name} and the team…`}
    conversationName={name}
    // At the composer, where the mode applies, with the way out beside it;
    // Escape leaves it too.
    {...(edit ? {
      composerNotice: <span className="sidekick-editing-badge" role="status">
        <Pencil aria-hidden="true" size={13} />Editing this Sidekick
        <button aria-label="Stop editing this Sidekick" className="sidekick-editing-close" onClick={() => setEditing(false)} type="button"><X aria-hidden="true" size={13} /></button>
      </span>,
      onComposerCancel: () => setEditing(false),
    } : {})}
    key="shared"
    messageIntent={edit ? 'edit_sidekick' : undefined}
    parentId={detail.id}
    parentKind="automation"
    // Always an element: the surface's grid gives its first row to the header,
    // and an empty one keeps the feed in the row that scrolls.
    renderHeader={() => <header className="sidekick-conversation-heading">
      {canvases.length > 0 && <ul aria-label="Canvases it made" className="sidekick-canvas-cards">
        {canvases.map((canvas) => <li key={canvas.id}><Link className="sidekick-canvas-card" to={canvasRoute(canvas.id)}>
          <CanvasMark kind={null} size={28} />
          <span><strong>{canvas.title}</strong><small>Canvas</small></span>
        </Link></li>)}
      </ul>}
    </header>}
    substreamId="0"
  />;
}
