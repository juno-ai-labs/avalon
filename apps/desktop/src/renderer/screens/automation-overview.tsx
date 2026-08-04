import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import {
  CalendarClock,
  Check,
  ChevronRight,
  CircleAlert,
  CirclePause,
  Clock3,
  Copy,
  Edit3,
  Ellipsis,
  LoaderCircle,
  Mail,
  Menu,
  PanelRight,
  Play,
  RefreshCcw,
  Share2,
  ShieldCheck,
  Sparkles,
  Trash2,
  Users,
  Zap,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useAppSession } from '../lib/app-session';
import { formatDuration, formatRelative } from '../lib/format';
import { desktopBridge } from '../lib/platform';
import type { AutomationRunSummary } from '../lib/types';
import { useUiStore } from '../lib/ui-store';
import { InspectorRail } from '../components/inspector-rail';
import { AvatarStack, Badge, Button, EmptyState, IconButton, InlineError, LoadingState, Modal, StatusDot } from '../components/primitives';

type RunFilter = 'all' | 'scheduled' | 'manual' | 'activity' | 'webhook';

function RunRow({ run, onOpen }: { run: AutomationRunSummary; onOpen: () => void }): React.JSX.Element {
  return (
    <button className="automation-run-row" onClick={onOpen} type="button">
      <StatusDot compact status={run.status} />
      <span className="automation-run-main">
        <strong>{run.title}</strong>
        <small>{run.resultSummary ?? (run.status === 'running' ? 'Avalon is working…' : 'No result summary')}</small>
      </span>
      {run.participants?.length ? <AvatarStack limit={3} members={run.participants} /> : <span />}
      {run.durationMs !== undefined && <span className="run-duration">{formatDuration(run.durationMs)}</span>}
      <Badge>{run.triggerType.toUpperCase()}</Badge>
      <time dateTime={run.triggerTime}>{formatRelative(run.triggerTime)}</time>
      <ChevronRight aria-hidden="true" size={14} />
    </button>
  );
}

export function AutomationOverviewScreen(): React.JSX.Element {
  const { id = '' } = useParams();
  const { api } = useAppSession();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const openRail = useUiStore((state) => state.openRail);
  const closeRail = useUiStore((state) => state.closeRail);
  const setSidebarOpen = useUiStore((state) => state.setSidebarOpen);
  const [filter, setFilter] = useState<RunFilter>('all');
  const [editOpen, setEditOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [updateOpen, setUpdateOpen] = useState(false);
  const [instructions, setInstructions] = useState('');
  const [automationEmailCopyState, setAutomationEmailCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');

  useEffect(() => () => closeRail(), [closeRail, id]);

  useEffect(() => {
    setAutomationEmailCopyState('idle');
  }, [id]);

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

  useEffect(() => {
    if (automation.data) setInstructions(automation.data.instructions);
  }, [automation.data]);

  const statusMutation = useMutation({
    mutationFn: (action: 'pause' | 'resume') => api!.setAutomationStatus(id, action),
    onSuccess: (updated) => {
      queryClient.setQueryData(['automation', id], updated);
      void queryClient.invalidateQueries({ queryKey: ['automations'] });
    },
  });
  const runNow = useMutation({
    mutationFn: () => api!.runAutomation(id),
    onSuccess: (workstream) => {
      void queryClient.invalidateQueries({ queryKey: ['workstreams'] });
      void navigate(`/workstreams/${workstream.id}`);
    },
  });
  const update = useMutation({
    mutationFn: () => api!.updateAutomation(id, { instructions: instructions.trim() }),
    onSuccess: (updated) => {
      queryClient.setQueryData(['automation', id], updated);
      setEditOpen(false);
    },
  });
  const share = useMutation({
    mutationFn: () => api!.shareAutomation(id),
  });
  const adoptUpdate = useMutation({
    mutationFn: (versionId: string) => api!.adoptAutomationUpdate(id, versionId),
    onSuccess: (updated) => {
      queryClient.setQueryData(['automation', id], updated);
      void queryClient.invalidateQueries({ queryKey: ['automations'] });
      setUpdateOpen(false);
    },
  });

  if (automation.isLoading) return <LoadingState label="Opening automation…" />;
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
  const automationEmailAddress = detail.emailAddress;
  const filteredRuns = detail.runs.filter((run) => filter === 'all' || run.triggerType === filter);
  const copyAutomationEmail = async (): Promise<void> => {
    if (!automationEmailAddress) return;
    try {
      await desktopBridge().copyText(automationEmailAddress);
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
          <span className={clsx('automation-state', detail.status)}><span />{detail.status[0]!.toUpperCase() + detail.status.slice(1)}</span>
        </div>
        <div className="automation-overview-actions window-no-drag">
          <IconButton label="Open runs inspector" onClick={() => openRail('runs')}><PanelRight size={15} /></IconButton>
          <Button onClick={() => setEditOpen(true)}><Edit3 size={14} /> Edit</Button>
          <Button onClick={() => setShareOpen(true)}><Share2 size={14} /> Share</Button>
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
                <DropdownMenu.Item className="menu-item" disabled><Trash2 size={14} /> Delete automation</DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        </div>
      </header>

      {(statusMutation.error || runNow.error) && <div className="overview-error"><InlineError>{statusMutation.error?.message ?? runNow.error?.message}</InlineError></div>}

      <div className="automation-overview-scroll">
        <div className="automation-overview-layout">
          <aside className="automation-facts" aria-label="Automation details">
            <section><h2>Status</h2><p className="fact-status"><span className={clsx('switch-visual', detail.status === 'active' && 'is-on')} /><strong>{detail.status[0]!.toUpperCase() + detail.status.slice(1)}</strong></p></section>
            <section><h2>Repeats</h2><p><CalendarClock size={14} />{detail.scheduleSummary ?? detail.triggerSummary}</p></section>
            {automationEmailAddress && (
              <section className="automation-email-fact">
                <h2>Email address</h2>
                <div className="automation-email-address">
                  <Mail aria-hidden="true" size={13} />
                  <span title={automationEmailAddress}>{automationEmailAddress}</span>
                  <IconButton
                    className="automation-email-copy"
                    label={automationEmailCopyState === 'copied'
                      ? `Automation email address copied ${automationEmailAddress}`
                      : automationEmailCopyState === 'failed'
                        ? `Copy failed; retry automation email address ${automationEmailAddress}`
                        : `Copy automation email address ${automationEmailAddress}`}
                    onClick={() => void copyAutomationEmail()}
                    title={automationEmailCopyState === 'copied'
                      ? 'Copied'
                      : automationEmailCopyState === 'failed'
                        ? 'Copy failed — click to retry'
                        : 'Copy automation email address'}
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
                    ? 'Email this address from your Avalon account email to start a new work stream.'
                    : 'Email this address from a workspace member email to start a new work stream.'}
                </small>
              </section>
            )}
            <section><h2>Execution</h2><p><Users size={14} />{detail.executionScope}</p><small>{detail.scope === 'you' ? 'Uses your authorized connections' : 'Uses explicitly bound workspace connections'}</small></section>
            <section>
              <h2>Connected capabilities</h2>
              <div className="capability-list">{detail.capabilities.length ? detail.capabilities.map((capability) => <Badge key={capability}>{capability}</Badge>) : <span className="muted-notice">No capabilities bound</span>}</div>
            </section>
            {detail.nextRun && <section><h2>Next run</h2><p><Clock3 size={14} />{formatRelative(detail.nextRun.triggerTime)}</p><Button className="button-quiet" onClick={() => void navigate(`/workstreams/${detail.nextRun!.workstreamId}`)}>Open planned work stream <ChevronRight size={13} /></Button></section>}
          </aside>

          <div className="automation-main-column">
            {detail.templateUpdate && (
              <section className="automation-update-banner" aria-label="Template update available">
                <span className="automation-update-icon"><Sparkles aria-hidden="true" size={15} /></span>
                <span className="automation-update-copy">
                  <strong>Version {detail.templateUpdate.versionNumber} is available</strong>
                  <small>Your automation stays on version {detail.versionNumber} until you choose to update.</small>
                </span>
                <Button className="button-quiet" onClick={() => setUpdateOpen(true)}>Review update <ChevronRight size={13} /></Button>
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
              <header><div><h2>Runs</h2><span>{detail.runs.length} total</span></div></header>
              <div className="run-filter" role="group" aria-label="Filter automation runs">
                {(['all', 'scheduled', 'manual', 'activity', 'webhook'] as const).map((value) => (
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

      <Modal
        description="Review the workspace template changes. Nothing changes for this automation until you adopt the new version."
        footer={detail.templateUpdate ? (
          <>
            <Button onClick={() => setUpdateOpen(false)}>Keep version {detail.versionNumber}</Button>
            <Button
              className="button-primary"
              disabled={adoptUpdate.isPending}
              onClick={() => adoptUpdate.mutate(detail.templateUpdate!.versionId)}
            >
              {adoptUpdate.isPending ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}
              Adopt version {detail.templateUpdate.versionNumber}
            </Button>
          </>
        ) : undefined}
        onOpenChange={setUpdateOpen}
        open={updateOpen && Boolean(detail.templateUpdate)}
        title="Review template update"
      >
        {detail.templateUpdate && (
          <div className="automation-update-review">
            <div className="automation-update-comparison">
              <section>
                <header><span>Current</span><Badge>Version {detail.versionNumber}</Badge></header>
                <pre>{detail.instructions}</pre>
              </section>
              <span className="automation-update-arrow" aria-hidden="true"><ChevronRight size={16} /></span>
              <section className="is-new">
                <header><span>Available</span><Badge>Version {detail.templateUpdate.versionNumber}</Badge></header>
                <pre>{detail.templateUpdate.instructions}</pre>
              </section>
            </div>
            <dl className="automation-update-details">
              <div>
                <dt>Trigger</dt>
                <dd><span>{detail.triggerSummary}</span><ChevronRight aria-hidden="true" size={12} /><strong>{detail.templateUpdate.triggerSummary}</strong></dd>
              </div>
              <div>
                <dt>Required capabilities</dt>
                <dd className="automation-update-change">
                  <span className="automation-update-value automation-update-badges">
                    {detail.capabilities.length
                      ? detail.capabilities.map((capability) => <Badge key={capability}>{capability}</Badge>)
                      : <span>None</span>}
                  </span>
                  <ChevronRight aria-hidden="true" size={12} />
                  <span className="automation-update-value is-new automation-update-badges">
                    {detail.templateUpdate.capabilities.length
                      ? detail.templateUpdate.capabilities.map((capability) => <Badge key={capability}>{capability}</Badge>)
                      : <span>None</span>}
                  </span>
                </dd>
              </div>
              {(detail.expectedOutputs.length > 0 || detail.templateUpdate.expectedOutputs.length > 0) && (
                <div>
                  <dt>Expected output</dt>
                  <dd className="automation-update-change">
                    <span className="automation-update-value">{detail.expectedOutputs.join(' · ') || 'Not specified'}</span>
                    <ChevronRight aria-hidden="true" size={12} />
                    <span className="automation-update-value is-new">{detail.templateUpdate.expectedOutputs.join(' · ') || 'Not specified'}</span>
                  </dd>
                </div>
              )}
            </dl>
            {detail.instructions === detail.templateUpdate.instructions && (
              <p className="automation-update-note">Instructions are unchanged; this version updates the trigger or output settings.</p>
            )}
            {adoptUpdate.error && <InlineError>{adoptUpdate.error.message}</InlineError>}
          </div>
        )}
      </Modal>

      <Modal
        description="Update the natural-language instructions used to assemble each run’s context."
        footer={
          <>
            <Button onClick={() => setEditOpen(false)}>Cancel</Button>
            <Button className="button-primary" disabled={!instructions.trim() || update.isPending} onClick={() => update.mutate()}>
              {update.isPending ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />} Save changes
            </Button>
          </>
        }
        onOpenChange={setEditOpen}
        open={editOpen}
        title={`Edit ${detail.name}`}
      >
        <label className="form-field"><span>Instructions</span><textarea onChange={(event) => setInstructions(event.target.value)} rows={12} value={instructions} /></label>
        {update.error && <InlineError>{update.error.message}</InlineError>}
      </Modal>

      <Modal
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
      </Modal>
    </div>
  );
}
