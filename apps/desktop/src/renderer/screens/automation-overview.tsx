import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import {
  AlertTriangle,
  CalendarClock,
  Check,
  ChevronRight,
  CircleAlert,
  CirclePause,
  Clock3,
  Copy,
  Ellipsis,
  LoaderCircle,
  Mail,
  Menu,
  PanelRight,
  Play,
  RefreshCcw,
  Share2,
  ShieldCheck,
  Trash2,
  Users,
  Zap,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useAppSession } from '../lib/app-session';
import { automationAttentionNotice } from '../lib/automation-attention';
import { formatDuration, formatRelative } from '../lib/format';
import { desktopBridge } from '../lib/platform';
import {
  currentSurfaceEntrypoint,
  reportTelemetryProductIntent,
  telemetryCountBucket,
  telemetryVisibility,
} from '../lib/telemetry';
import type { AutomationRunSummary } from '../lib/types';
import { useUiStore } from '../lib/ui-store';
import { WORKSTREAMS_QUERY_KEY } from '../lib/use-workstreams-query';
import { useClientFeatureFlags } from '../lib/use-client-feature-flags';
import { InspectorRail } from '../components/inspector-rail';
import { AvatarStack, Badge, Button, EmptyState, IconButton, InlineError, Modal, OpeningState, StatusDot } from '../components/primitives';

type RunFilter = 'all' | 'scheduled' | 'manual';

/**
 * What separates one run from the next, since the title cannot.
 *
 * Every run of an automation is titled after the automation, so a
 * list of them is the same sentence repeated. What actually differs
 * is why each one started and when.
 */
function runTriggerLabel(triggerType: string): string {
  if (triggerType === 'manual') return 'Run now';
  if (triggerType === 'scheduled') return 'On schedule';
  if (triggerType === 'inbound_email') return 'By email';
  if (triggerType === 'external_event') return 'By activity';
  return triggerType.replaceAll('_', ' ');
}

function runResultSummary(run: AutomationRunSummary): string {
  if (run.resultSummary) return run.resultSummary;
  if (run.status === 'running') return 'Rally is working…';
  // "No result summary" is what a failed run said before, which
  // reads as an absence rather than as the thing that happened.
  if (run.status === 'failed') return 'Failed';
  if (run.status === 'stopped') return 'Stopped';
  return 'No result summary';
}

function RunRow({ run, onOpen }: { run: AutomationRunSummary; onOpen: () => void }): React.JSX.Element {
  return (
    <button className="automation-run-row" onClick={onOpen} type="button">
      {/* With a tooltip: a compact dot carries no visible label, so
          without one its colour is the only thing saying how the
          run ended — and colour alone is not a reading. */}
      <StatusDot compact status={run.status} tooltip />
      <span className="automation-run-main">
        <strong>{runTriggerLabel(run.triggerType)}</strong>
        <small>{runResultSummary(run)}</small>
      </span>
      {run.participants?.length ? <AvatarStack limit={3} members={run.participants} /> : <span />}
      {run.durationMs !== undefined && <span className="run-duration">{formatDuration(run.durationMs)}</span>}
      {/* The trigger badge is gone: the row's own title now names
          the trigger, and saying it twice per row is noise. */}
      <time dateTime={run.triggerTime}>{formatRelative(run.triggerTime)}</time>
      <ChevronRight aria-hidden="true" size={14} />
    </button>
  );
}

export function AutomationOverviewScreen(): React.JSX.Element {
  const { id = '' } = useParams();
  const { api } = useAppSession();
  const featureFlags = useClientFeatureFlags(api);
  // Publishing still stores a template and the API still serves it, but the
  // browser that installed one lived on the retired draft screen, so nothing
  // in the client can subscribe to what this publishes. The flag is what keeps
  // that out of everyone's way; the success copy no longer names a surface
  // that is gone. Turning the flag on again wants an install surface first.
  const workspaceTemplatesEnabled = featureFlags.data?.automationWorkspaceTemplatesEnabled === true;
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const openRail = useUiStore((state) => state.openRail);
  const closeRail = useUiStore((state) => state.closeRail);
  const setSidebarOpen = useUiStore((state) => state.setSidebarOpen);
  const [filter, setFilter] = useState<RunFilter>('all');
  const [shareOpen, setShareOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [automationEmailCopyState, setAutomationEmailCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');

  useEffect(() => () => closeRail(), [closeRail, id]);

  // Evicting the deleted automation's detail query has to happen after this
  // screen is gone. Removing a query that still has a mounted observer makes
  // React Query rebuild and refetch it on the next render, which would put the
  // automation straight back in the cache — the opposite of the intent.
  const deletedRef = useRef(false);
  useEffect(() => () => {
    if (deletedRef.current) queryClient.removeQueries({ queryKey: ['automation', id] });
  }, [id, queryClient]);

  useEffect(() => {
    setAutomationEmailCopyState('idle');
  }, [id]);

  useEffect(() => {
    if (workspaceTemplatesEnabled) return;
    setShareOpen(false);
  }, [workspaceTemplatesEnabled]);

  useEffect(() => {
    if (automationEmailCopyState === 'idle') return;
    const reset = window.setTimeout(() => setAutomationEmailCopyState('idle'), 2_000);
    return () => window.clearTimeout(reset);
  }, [automationEmailCopyState]);

  const automation = useQuery({
    queryKey: ['automation', id],
    queryFn: ({ signal }) => api!.getAutomation(id, signal),
    enabled: Boolean(api && id),
    staleTime: 10_000,
  });
  const reportedAutomationId = useRef<string | null>(null);
  useEffect(() => {
    const detail = automation.data;
    if (!detail || reportedAutomationId.current === detail.id) return;
    reportedAutomationId.current = detail.id;
    reportTelemetryProductIntent({
      kind: 'automation_opened',
      automationId: detail.id,
      visibility: telemetryVisibility(detail.scope),
      status: detail.status,
      entrypoint: currentSurfaceEntrypoint(),
      runCount: telemetryCountBucket(detail.runs.length),
    });
  }, [automation.data]);

  const statusMutation = useMutation({
    mutationFn: (action: 'pause' | 'resume') => api!.setAutomationStatus(id, action),
    onSuccess: (updated) => {
      queryClient.setQueryData(['automation', id], updated);
    },
  });
  const runNow = useMutation({
    mutationFn: () => api!.runAutomation(id),
    onSuccess: (workstream) => {
      void queryClient.invalidateQueries({ queryKey: WORKSTREAMS_QUERY_KEY });
      void navigate(`/workstreams/${workstream.id}`);
    },
  });
  const share = useMutation({
    mutationFn: () => api!.shareAutomation(id),
  });
  const remove = useMutation({
    mutationFn: () => api!.deleteAutomation(id),
    onSuccess: async () => {
      // Deleting closes any run that was opened ahead of its planned time, so
      // the work-stream list is stale too. The automation list is not
      // invalidated here: AutomationAgent deletes its authority and WorkspaceDO
      // pushes the resulting directory projection to the sidebar.
      await queryClient.invalidateQueries({ queryKey: WORKSTREAMS_QUERY_KEY });
      setDeleteOpen(false);
      // Replace rather than push: this screen is showing the automation that
      // was just deleted, so leaving its route in history means Back lands on a
      // resource that is gone. The detail query has to go too — its 10s
      // staleTime would otherwise let a remount render the deleted automation
      // from cache without ever asking the server — but that eviction waits for
      // unmount, below, rather than happening here.
      deletedRef.current = true;
      void navigate('/workstreams/new', { replace: true });
    },
  });
  if (automation.isLoading) return <OpeningState label="Opening automation…" />;
  if (automation.error || !automation.data) {
    return (
      <div className="screen-error-state screen-with-titlebar">
        <div className="screen-drag-strip window-drag" />
        <EmptyState
          action={<Button onClick={() => void automation.refetch()}><RefreshCcw size={14} /> Try again</Button>}
          description={automation.error?.message ?? 'This automation is unavailable.'}
          title="Automation could not be opened"
        />
      </div>
    );
  }

  const detail = automation.data;
  const attention = detail.attention ? automationAttentionNotice(detail.attention) : null;
  const automationEmailAddress = detail.emailAddress;
  // A dialog reopened after a failed delete must not greet the user with the
  // last attempt's error before they have tried anything.
  const openDelete = (): void => {
    remove.reset();
    setDeleteOpen(true);
  };
  const filteredRuns = detail.runs.filter((run) => filter === 'all' || run.triggerType === filter);
  const copyAutomationEmail = async (): Promise<void> => {
    if (!automationEmailAddress) return;
    try {
      await desktopBridge().copyText(automationEmailAddress);
      reportTelemetryProductIntent({
        kind: 'content_copied', contentType: 'automation_email', resourceType: 'automation', resourceId: detail.id,
      });
      setAutomationEmailCopyState('copied');
    } catch {
      setAutomationEmailCopyState('failed');
    }
  };

  return (
    <div className="automation-overview-screen">
      <header className="automation-overview-header window-drag">
        <div className="automation-overview-title window-no-drag">
          <IconButton className="header-menu-button" label="Open navigation" onClick={() => setSidebarOpen(true)}><Menu size={16} /></IconButton>
          <span className="header-origin-icon"><Zap size={15} /></span>
          <div><span>Automations</span><h1>{detail.name}</h1></div>
          <Badge>{detail.scope === 'you' ? 'You' : 'Workspace'}</Badge>
        </div>
        <div className="automation-overview-actions window-no-drag">
          <IconButton label="Open runs inspector" onClick={() => openRail('runs')}><PanelRight size={15} /></IconButton>
          {workspaceTemplatesEnabled && <Button onClick={() => setShareOpen(true)}><Share2 size={14} /> Share</Button>}
          <Button
            disabled={statusMutation.isPending}
            onClick={() => statusMutation.mutate(detail.status === 'paused' ? 'resume' : 'pause')}
          >
            {detail.status === 'paused' ? <Play size={14} /> : <CirclePause size={14} />}
            {detail.status === 'paused' ? 'Resume' : 'Pause'}
          </Button>
          <Button className="button-primary run-now-button" disabled={runNow.isPending || detail.status === 'draft'} onClick={() => runNow.mutate()}>
            {runNow.isPending ? <LoaderCircle className="spin" size={14} /> : <Play fill="currentColor" size={12} />} Run now
          </Button>
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild><IconButton label="More automation actions"><Ellipsis size={16} /></IconButton></DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content align="end" className="menu-content" sideOffset={8}>
                <DropdownMenu.Item className="menu-item menu-item-danger" onSelect={openDelete}>
                  <Trash2 size={14} /> Delete automation
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        </div>
      </header>

      {(statusMutation.error || runNow.error) && <div className="overview-error"><InlineError>{statusMutation.error?.message ?? runNow.error?.message}</InlineError></div>}

      <div className="automation-overview-scroll">
        <div className="automation-overview-layout">
          <aside className="automation-facts" aria-label="Automation details">
            <section><h2>Status</h2><p className="fact-status"><span aria-hidden="true" className={clsx('automation-status-dot', detail.status)} /><strong>{detail.status[0]!.toUpperCase() + detail.status.slice(1)}</strong></p></section>
            <section><h2>Repeats</h2><p><CalendarClock size={14} />{detail.scheduleSummary ?? detail.triggerSummary}</p></section>
            {automationEmailAddress && (
              <section className="automation-email-fact">
                <h2>Email address</h2>
                <div className="automation-email-address">
                  <Mail aria-hidden="true" size={13} />
                  <span className="automation-email-value" title={automationEmailAddress}>{automationEmailAddress}</span>
                  <IconButton
                    className="automation-email-copy"
                    label="Copy automation email"
                    onClick={() => void copyAutomationEmail()}
                    title="Copy automation email"
                    tooltipSide="right"
                  >
                    {automationEmailCopyState === 'copied'
                      ? <Check aria-hidden="true" size={12} />
                      : automationEmailCopyState === 'failed'
                        ? <CircleAlert aria-hidden="true" size={12} />
                        : <Copy aria-hidden="true" size={12} />}
                  </IconButton>
                  <span aria-live="polite" className="sr-only" role="status">
                    {automationEmailCopyState === 'copied'
                      ? 'Automation email address copied.'
                      : automationEmailCopyState === 'failed'
                        ? 'The automation email address could not be copied.'
                        : ''}
                  </span>
                </div>
                <small>
                  {detail.scope === 'you'
                    ? 'Email this address from your Rally account email to start a new work stream.'
                    : 'Email this address from a workspace member email to start a new work stream.'}
                </small>
              </section>
            )}
            <section><h2>Execution</h2><p><Users size={14} />{detail.executionScope}</p><small>{detail.scope === 'you' ? 'Uses your authorized connections' : 'Uses explicitly bound workspace connections'}</small></section>
            {detail.nextRun && <section><h2>Next run</h2><p><Clock3 size={14} />{formatRelative(detail.nextRun.triggerTime)}</p><Button className="button-quiet" onClick={() => void navigate(`/workstreams/${detail.nextRun!.workstreamId}`)}>Open planned work stream <ChevronRight size={13} /></Button></section>}
          </aside>

          <div className="automation-main-column">
            {/* Beside the Status fact rather than under it: the facts column is
                250px, and the sentence that matters most here — an automation
                that will never start again — is not one to set in a column that
                becomes a half-width cell on a narrow window. It reads as the
                first thing on the automation, level with the status it
                explains. */}
            {attention && (
              <section
                aria-label="Automation needs attention"
                className={clsx('automation-attention-notice', attention.blocking && 'is-blocking')}
                role="status"
              >
                <span aria-hidden="true" className="automation-attention-icon"><AlertTriangle size={16} /></span>
                <div className="automation-attention-copy">
                  <strong>{attention.heading}</strong>
                  <p>{attention.body}</p>
                </div>
              </section>
            )}
            <section className="automation-description">
              <p>{detail.description}</p>
            </section>
            <section className="instructions-section">
              <header><h2>Instructions</h2><span>Used for every run</span></header>
              <div className="instructions-card"><pre>{detail.instructions}</pre></div>
            </section>
            <section className="run-history-section">
              {/* "Recent", not a total: the API returns the newest
                  page of runs rather than all of them, so a count
                  of what arrived is not how many there have been. */}
              <header><div><h2>Recent runs</h2><span>Last {detail.runs.length}</span></div></header>
              <div className="run-filter" role="group" aria-label="Filter automation runs">
                {(['all', 'scheduled', 'manual'] as const).map((value) => (
                  <button className={filter === value ? 'is-selected' : ''} key={value} onClick={() => setFilter(value)} type="button">
                    {value[0]!.toUpperCase() + value.slice(1)}
                  </button>
                ))}
              </div>
              {filteredRuns.length ? (
                <div className="automation-run-list">{filteredRuns.map((run) => <RunRow key={run.id} onOpen={() => void navigate(`/workstreams/${run.workstreamId}`)} run={run} />)}</div>
              ) : (
                <EmptyState title="No matching runs" description="Runs appear here after a trigger fires or you choose Run now." />
              )}
            </section>
          </div>
        </div>
      </div>

      <InspectorRail onOpenRun={(run) => void navigate(`/workstreams/${run.workstreamId}`)} runs={detail.runs} />

      {workspaceTemplatesEnabled && <Modal
        description="Publishing creates a versioned workspace template. Coworkers bind their own connections when they subscribe."
        footer={
          <>
            <Button onClick={() => setShareOpen(false)}>Close</Button>
            {!share.data && <Button className="button-primary" disabled={share.isPending} onClick={() => share.mutate()}>{share.isPending ? <LoaderCircle className="spin" size={14} /> : <Share2 size={14} />} Publish template</Button>}
          </>
        }
        onOpenChange={setShareOpen}
        open={shareOpen}
        title="Share with your workspace"
      >
        {share.data ? <div className="success-message"><ShieldCheck size={17} /><span><strong>Template published</strong><small>It is saved to your workspace. There is no browser for installing one yet.</small></span></div> : <p className="modal-copy">Credentials and personal overrides are never copied into a template.</p>}
        {share.error && <InlineError>{share.error.message}</InlineError>}
      </Modal>}

      <Modal
        footer={
          <>
            <Button disabled={remove.isPending} onClick={() => setDeleteOpen(false)}>Cancel</Button>
            <Button className="button-danger" disabled={remove.isPending} onClick={() => remove.mutate()}>
              {remove.isPending ? <LoaderCircle className="spin" size={14} /> : <Trash2 size={14} />} Delete
            </Button>
          </>
        }
        onOpenChange={(open) => {
          if (remove.isPending) return;
          setDeleteOpen(open);
        }}
        open={deleteOpen}
        title="Delete automation"
      >
        {/* What deleting actually does. The reassurance this
            said before — that the runs and their work streams
            stay where they are — was the opposite of the
            truth: the delete enqueues an archive for every work
            stream the runs created, and the runs leave the
            product with the automation. */}
        <p className="modal-copy">
          <strong>{detail.name}</strong> stops running and leaves the sidebar for good.
          Every past run — and the work stream each one created — is archived with it,
          and Rally has no way to bring them back.
        </p>
        {remove.error && <InlineError>{remove.error.message}</InlineError>}
      </Modal>
    </div>
  );
}
