import { ErrorNotice } from '../components/primitives';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { WorkstreamAppearancePatch } from '@rally/contracts';
import type { AutomationDetail } from '../lib/types';
import { SidekickDetailLayout } from '../components/sidekick-detail-layout';
import { AutomationHeader, type AutomationHeaderAction } from '../components/automation-header';
import { Button, EmptyState, OpeningState } from '../components/primitives';
import { useCollaborationSession, useShellCapabilities } from '../lib/collaboration-session';
import { useCloseWindowSurface } from '../lib/window-surface';
import { copySidekickLink } from '../lib/copy-workstream-link';
import { WORKSTREAMS_QUERY_KEY } from '../lib/use-workstreams-query';
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

/**
 * A failed Sidekick screen's way on. In a browser tab the screen fills the tab
 * with the sidebar hidden (`lib/window-surface.ts`), so it also offers the way
 * out the Mac app's window chrome gives there.
 */
function ErrorActions({ onRetry }: { onRetry: () => void }): React.JSX.Element {
  const { host } = useShellCapabilities();
  const close = useCloseWindowSurface();
  return (
    <div className="empty-state-actions">
      <Button onClick={onRetry}>Try again</Button>
      {host === 'browser' && <Button onClick={close}>Close</Button>}
    </div>
  );
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
        // Archiving stops open runs, including one provisioned ahead of its
        // planned time, so refresh the work-stream directory as well as the
        // Sidekick library.
        void queryClient.invalidateQueries({ queryKey: WORKSTREAMS_QUERY_KEY });
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
        await copySidekickLink({ region: session.workspace.region, workspaceId: session.workspace.id }, id);
      }}
      onPause={() => act.mutate('pause')}
      onResume={() => act.mutate('resume')}
      onRunNow={() => act.mutate('run')}
      pending={act.isPending ? act.variables : null}
      runs={runs.data}
      runsError={runs.error?.message}
    />}>
      <ConversationSurface
        parentId={id}
        parentKind="automation"
        renderHeader={() => <header className="sidekick-conversation-heading"><h2>Conversation</h2></header>}
        substreamId="0"
      />
    </SidekickDetailLayout>
  );
}
