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
  MessageSquare,
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
import { RallyMark, AvatarStack, Badge, Button, EmptyState, IconButton, InlineError, Modal, OpeningState, StatusDot } from '../components/primitives';

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
  const { api, session } = useAppSession();
  const featureFlags = useClientFeatureFlags(api);
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
  const connections = useQuery({
    queryKey: ['connections'],
    queryFn: ({ signal }) => api!.getConnections(signal),
    enabled: Boolean(api),
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
  /**
   * Turning one destination on or off, without touching the others.
   *
   * The API replaces the whole set, so the current set is the starting point
   * rather than the one box that moved: sending only the toggled destination
   * would silently drop the other one.
   */
  const setDelivery = useMutation({
    mutationFn: (next: Array<{ type: 'email' } | { type: 'slack_agent_dm'; connectionId: string }>) =>
      api!.updateAutomation(id, { deliveryTargets: next }),
    onSuccess: (updated) => {
      queryClient.setQueryData(['automation', id], updated);
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
  const deliveryTargets = detail.deliveryTargets ?? [];
  const availableDeliveryConnections = (connections.data ?? []).filter((connection) =>
    connection.userDelivery);
  const ownerEmail = session?.user.email ?? '';
  // A destination frozen on the automation is offered whatever the connection
  // list says. Without this a connection that is unlinked or disabled — which
  // retains its delivery-target row rather than cascading it away — leaves a
  // destination that is still delivering, has no row on screen to untick, and
  // is replayed inside every set this screen sends, so the API rejects the lot
  // and no destination can be changed at all.
  const unmatchedDeliveryTargets = deliveryTargets.filter((target) =>
    target.type !== 'email'
    && !availableDeliveryConnections.some((connection) => connection.id === target.connectionId));
  // Whether a destination is *disconnected* is a different question from whether
  // it is missing from the list, and only the connection query can answer it.
  // This screen renders as soon as the *automation* resolves, so an absent
  // `connections.data` is indistinguishable from an empty one: while the list
  // was loading — and permanently if it failed, since nothing here retries —
  // every healthy connector destination was declared disconnected and the reader
  // was told to "turn off to stop trying", which destroys a working one. The row
  // still has to appear, or the sentence below claims nothing is being sent
  // while the destination is delivering.
  const deliveryConnectionsKnown = connections.isSuccess;
  const deliveryChoices = [
    ...(ownerEmail || deliveryTargets.some((target) => target.type === 'email')
      ? [{
        key: 'email',
        type: 'email' as const,
        label: deliveryTargets.find((target) => target.type === 'email')?.displayName ?? ownerEmail,
        checked: deliveryTargets.some((target) => target.type === 'email'),
        status: deliveryTargets.find((target) => target.type === 'email')?.status,
        available: true,
      }]
      : []),
    ...availableDeliveryConnections.map((connection) => ({
      key: connection.id,
      // The connector declares its own surface, so this list grows with the
      // connector catalog rather than with this file.
      type: connection.userDelivery!.targetType,
      label: `${connection.userDelivery!.label} · ${connection.displayName}`,
      checked: deliveryTargets.some((target) => target.connectionId === connection.id),
      status: deliveryTargets.find((target) => target.connectionId === connection.id)?.status,
      available: true,
    })),
    ...unmatchedDeliveryTargets.map((target) => ({
      key: target.connectionId!,
      type: target.type,
      label: target.displayName,
      checked: true,
      status: target.status,
      available: !deliveryConnectionsKnown,
    })),
  ].map((choice) => ({
    ...choice,
    // The whole set as it would be after this box moves: the API replaces the
    // set, so a payload carrying only the toggled destination drops the other.
    // Turning one on drops any other of the same type first — the table holds
    // one row per type, so two connections offering the same surface are one
    // destination, and appending the second would compose a set the API refuses.
    next: (choice.checked
      ? deliveryTargets.filter((target) => choice.type === 'email'
        ? target.type !== 'email'
        : target.connectionId !== choice.key)
      : [...deliveryTargets.filter((target) => target.type !== choice.type),
        choice.type === 'email'
          ? { type: 'email' as const, connectionId: null }
          : { type: choice.type, connectionId: choice.key }]
    ).map((target) => target.type === 'email'
      ? { type: 'email' as const }
      : { type: 'slack_agent_dm' as const, connectionId: target.connectionId! }),
  }));
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
            {detail.scope === 'you' && deliveryChoices.length > 0 && (
              <section aria-label="Delivered to" className="automation-delivery-fact">
                <h2>Delivered to</h2>
                <ul>
                  <li className="is-locked">
                    {/* Stands where the other rows' checkbox is, so every icon
                        below it lines up rather than stepping in. */}
                    <span aria-hidden="true" className="delivery-locked-spacer" />
                    <RallyMark /><span>Rally work stream</span>
                  </li>
                  {deliveryChoices.map((choice) => (
                    <li key={choice.key}>
                      <label>
                        <input
                          checked={choice.checked}
                          disabled={setDelivery.isPending}
                          onChange={() => setDelivery.mutate(choice.next)}
                          type="checkbox"
                        />
                        {choice.type === 'email' ? <Mail size={13} /> : <MessageSquare size={13} />}
                        <span title={choice.label}>{choice.label}</span>
                      </label>
                      {!choice.available
                        ? <small className="is-warning">Disconnected — turn off to stop trying</small>
                        : choice.status === 'needs_input' && <small className="is-warning">Last delivery failed</small>}
                    </li>
                  ))}
                </ul>
                {connections.error
                  && <small className="is-warning">Rally cannot check your connections right now, so a destination may be missing from this list.</small>}
                {setDelivery.error && <InlineError>{setDelivery.error.message}</InlineError>}
                {deliveryChoices.some((choice) => choice.checked)
                  ? <small>Every run is saved to its own work stream, whatever else is chosen.</small>
                  : <small className="is-warning">Results now only go to the work stream — nothing will be sent to you.</small>}
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
        {share.data ? <div className="success-message"><ShieldCheck size={17} /><span><strong>Template published</strong><small>Coworkers can now find it inside New automation.</small></span></div> : <p className="modal-copy">Credentials and personal overrides are never copied into a template.</p>}
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
