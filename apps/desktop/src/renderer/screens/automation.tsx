import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { AutomationHeader, type AutomationHeaderAction } from '../components/automation-header';
import { Button, EmptyState, OpeningState } from '../components/primitives';
import { useAppSession } from '../lib/app-session';
import { ConversationSurface } from './conversation-surface';

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

function NewAutomationScreen(): React.JSX.Element {
  const { api } = useAppSession();
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
        if (mounted) void navigate(`/automations/${automationId}`, { replace: true });
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
        <EmptyState
          action={<Button onClick={() => { creation.current = null; setError(null); }}>Try again</Button>}
          description={error}
          title="Automation could not be created"
        />
      </div>
    );
  }
  return <OpeningState label="Creating automation…" />;
}

function AutomationDetailScreen({ id }: { id: string }): React.JSX.Element {
  const { api } = useAppSession();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
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
        case 'apply': return queryClient.setQueryData(['automation', id], await api!.acceptAutomation(id));
        case 'pause': return queryClient.setQueryData(['automation', id], await api!.setAutomationStatus(id, 'pause'));
        case 'resume': return queryClient.setQueryData(['automation', id], await api!.setAutomationStatus(id, 'resume'));
        case 'run': return api!.runAutomation(id);
        case 'delete': return api!.deleteAutomation(id);
      }
    },
    onSuccess: (_result, action) => {
      if (action === 'delete') {
        // Replacing rather than pushing, so Back cannot return to an
        // automation that is no longer served.
        queryClient.removeQueries({ queryKey: ['automation', id] });
        void navigate('/workstreams/new', { replace: true });
        return;
      }
      refresh();
    },
  });
  if (automation.error) {
    return (
      <div className="screen-error-state screen-with-titlebar">
        <div className="screen-drag-strip window-drag" />
        <EmptyState
          action={<Button onClick={() => void automation.refetch()}>Try again</Button>}
          description={automation.error.message}
          title="Automation could not be opened"
        />
      </div>
    );
  }
  if (!automation.data) return <OpeningState label="Opening automation…" />;
  const detail = automation.data;
  return (
    <ConversationSurface
      parentId={id}
      parentKind="automation"
      renderHeader={() => (
        <AutomationHeader
          automation={detail}
          error={act.error?.message}
          onApply={() => act.mutate('apply')}
          onDelete={() => act.mutate('delete')}
          onPause={() => act.mutate('pause')}
          onResume={() => act.mutate('resume')}
          onRunNow={() => act.mutate('run')}
          pending={act.isPending ? act.variables : null}
          runs={runs.data}
          runsError={runs.error?.message}
        />
      )}
      substreamId="0"
    />
  );
}
