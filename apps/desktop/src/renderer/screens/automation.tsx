import { ErrorNotice } from '../components/primitives';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ChevronLeft, Pencil } from 'lucide-react';
import { CanvasMark } from '../components/canvas-mark';
import { canvasRoute } from '../lib/canvases';
import type { WorkstreamAppearancePatch } from '@rally/contracts';
import type { AutomationDetail } from '../lib/types';
import { SidekickDetailLayout } from '../components/sidekick-detail-layout';
import { AutomationHeader, type AutomationHeaderAction } from '../components/automation-header';
import { Button, EmptyState, OpeningState } from '../components/primitives';
import { useCollaborationSession } from '../lib/collaboration-session';
import { copyLink } from '../lib/copy-link';
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
  // One request per visit, held in a ref rather than started by the effect
  // directly: React mounts an effect twice in development, and a request
  // started by the first run and abandoned by its cleanup would create an
  // automation nobody is then taken to. The promise survives the re-run, and
  // the re-run simply waits on it.
  const creation = useRef<Promise<{ automationId: string }> | null>(null);
  useEffect(() => {
    if (!api) return;
    let mounted = true;
    creation.current ??= api.createAutomation();
    creation.current
      .then(({ automationId }) => {
        if (mounted) void navigate(`/sidekicks/${automationId}`, { replace: true });
      })
      .catch((cause: unknown) => {
        if (!mounted) return;
        setError(cause instanceof Error ? cause.message : 'The automation could not be created.');
      });
    return () => {
      mounted = false;
    };
  }, [api, error, navigate]);
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
  return (
    <SidekickDetailLayout key={id} overview={<AutomationHeader
      automation={detail}
      delegateNames={new Map([...(delegates.data?.delegates ?? []), ...(delegates.data?.creator ? [delegates.data.creator] : [])].map((person) => [person.userId, person.displayName]))}
      delegation={<SidekickDelegation id={id} />}
      error={act.error?.message}
      onAppearanceChange={setAppearance}
      onArchive={() => act.mutateAsync('archive').then(() => undefined)}
      onCopyLink={async () => {
        if (!session?.workspace) throw new Error('No active organization');
        await copyLink({ kind: 'sidekick', region: session.workspace.region, workspaceId: session.workspace.id, sidekickId: id });
      }}
      onPause={() => act.mutate('pause')}
      onResume={() => act.mutate('resume')}
      onRunNow={() => act.mutate('run')}
      pending={act.isPending ? act.variables : null}
      runs={runs.data}
      runsError={runs.error?.message}
    />}>
      <SidekickConversation detail={detail} manages={viewerManagesSidekick(detail, session)} />
    </SidekickDetailLayout>
  );
}

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
  const [search, setSearch] = useSearchParams();
  const runId = search.get('run');
  const [editing, setEditing] = useState(detail.lifecycle === 'draft');
  const name = detail.currentDefinition?.name ?? detail.name;
  if (runId) {
    return <ConversationSurface
      key={`run:${runId}`}
      parentId={detail.id}
      parentKind="automation"
      // A run is read here, not answered: replies to the Sidekick go in the
      // shared conversation, where they start the next run.
      readOnly
      renderHeader={() => <header className="sidekick-conversation-heading">
        <button className="sidekick-run-back" onClick={() => setSearch({}, { replace: true })} type="button"><ChevronLeft aria-hidden="true" size={16} />Conversation</button>
        <h2>Run</h2>
      </header>}
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
    key="shared"
    messageIntent={edit ? 'edit_sidekick' : undefined}
    parentId={detail.id}
    parentKind="automation"
    renderHeader={() => <header className="sidekick-conversation-heading">
      <h2>Conversation</h2>
      {edit && <span className="sidekick-editing-badge" role="status">Editing this Sidekick</span>}
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
