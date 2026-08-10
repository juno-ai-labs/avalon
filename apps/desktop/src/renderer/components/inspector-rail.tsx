import clsx from 'clsx';
import {
  ArrowLeft,
  Bot,
  Check,
  ChevronRight,
  CircleAlert,
  Copy,
  Download,
  ExternalLink,
  Eye,
  File,
  FileText,
  Link2,
  Maximize2,
  Minimize2,
  Plus,
  Trash2,
  UserPlus,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { formatCompactNumber, formatDateTime, formatDuration, formatRelative } from '../lib/format';
import { desktopBridge } from '../lib/platform';
import type {
  ArtifactData,
  AutomationRunSummary,
  BackgroundTask,
  Message,
  WorkstreamDetail,
  WorkstreamResource,
} from '../lib/types';
import { type RailVariant, useUiStore } from '../lib/ui-store';
import { useDebugEnabled } from '../lib/use-debug-enabled';
import { Avatar, Badge, Button, EmptyState, IconButton, InlineError, StatusDot } from './primitives';
import '../styles/inspector-rail.css';

interface InspectorRailProps {
  error?: string;
  workstream?: WorkstreamDetail;
  runs?: AutomationRunSummary[];
  tasks?: BackgroundTask[];
  messages?: Message[];
  onAddParticipant?: () => void;
  onAddResource?: () => void;
  onDetachResource?: (resource: WorkstreamResource) => void;
  onToggleWatch?: (resource: WorkstreamResource, enabled: boolean) => void;
  onOpenRun?: (run: AutomationRunSummary) => void;
  onJumpToMessage?: (messageId: string) => void;
  onDownloadArtifact?: (artifact: ArtifactData) => void;
  dropTarget?: {
    dragging: boolean;
    onDragEnter: React.DragEventHandler<HTMLElement>;
    onDragLeave: React.DragEventHandler<HTMLElement>;
    onDragOver: React.DragEventHandler<HTMLElement>;
    onDrop: React.DragEventHandler<HTMLElement>;
  };
}

function Section({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }): React.JSX.Element {
  return (
    <section className="rail-section">
      <header className="rail-section-header">
        <h3>{title}</h3>
        {action}
      </header>
      {children}
    </section>
  );
}

function ResourceIcon({ type }: { type: string }): React.JSX.Element {
  const normalized = type.toLowerCase();
  if (normalized.includes('doc') || normalized.includes('text')) return <FileText size={15} />;
  if (normalized.includes('url') || normalized.includes('web')) return <Link2 size={15} />;
  return <File size={15} />;
}

function ContextContent({
  workstream,
  onAddParticipant,
  onAddResource,
  onToggleWatch,
}: Pick<InspectorRailProps, 'workstream' | 'onAddParticipant' | 'onAddResource' | 'onToggleWatch'>): React.JSX.Element {
  const inspect = useUiStore((state) => state.inspect);
  const debugEnabled = useDebugEnabled();
  const [emailCopyState, setEmailCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');

  useEffect(() => {
    setEmailCopyState('idle');
  }, [workstream?.id]);

  useEffect(() => {
    if (emailCopyState === 'idle') return;
    const reset = window.setTimeout(() => setEmailCopyState('idle'), 2_000);
    return () => window.clearTimeout(reset);
  }, [emailCopyState]);

  if (!workstream) return <EmptyState title="No work stream selected" description="Open a work stream to inspect its context." />;

  const copyEmailAddress = async (): Promise<void> => {
    if (!workstream.emailAddress) return;
    try {
      await desktopBridge().copyText(workstream.emailAddress);
      setEmailCopyState('copied');
    } catch {
      setEmailCopyState('failed');
    }
  };

  return (
    <div className="rail-sections">
      <Section
        action={<IconButton label="Add participant" onClick={onAddParticipant}><UserPlus size={14} /></IconButton>}
        title="People"
      >
        {workstream.participants.length === 0 ? (
          <p className="rail-empty-line">No human participants</p>
        ) : (
          <ul className="rail-list" aria-label="Participants">
            {workstream.participants.map((participant) => (
              <li className="person-row" key={participant.id}>
                <Avatar member={participant} size="small" />
                <span><strong>{participant.name}</strong><small>{participant.role ?? participant.email}</small></span>
                {participant.id === workstream.createdBy?.id && <Badge>Creator</Badge>}
              </li>
            ))}
          </ul>
        )}
        {workstream.viewers.length > 0 && (
          <div className="viewing-group">
            <div className="viewing-label"><Eye aria-hidden="true" size={12} /> Viewing now</div>
            <ul className="rail-list" aria-label="Viewing now">
              {workstream.viewers.map((viewer) => (
                <li className="person-row is-viewer" key={viewer.id}>
                  <Avatar member={viewer} size="small" />
                  <span><strong>{viewer.name}</strong><small>Viewing, not participating</small></span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Section>

      <Section
        action={<IconButton label="Add resource" onClick={onAddResource}><Plus size={14} /></IconButton>}
        title="Resources"
      >
        {workstream.resources.length === 0 ? (
          <p className="rail-empty-line">No resources attached</p>
        ) : (
          <ul className="rail-card-list">
            {workstream.resources.map((resource) => (
              <li className="rail-card resource-row" key={resource.id}>
                <button className="rail-card-main" onClick={() => inspect({ type: 'resource', id: resource.id })} type="button">
                  <span className="rail-card-icon"><ResourceIcon type={resource.resourceType} /></span>
                  <span><strong>{resource.title}</strong><small>{resource.provider ?? resource.resourceType}</small></span>
                  <ChevronRight aria-hidden="true" size={14} />
                </button>
                <label className="watch-toggle">
                  <input
                    checked={resource.watchEnabled}
                    disabled={resource.watchStatus === 'unsupported'}
                    onChange={(event) => onToggleWatch?.(resource, event.target.checked)}
                    type="checkbox"
                  />
                  <span aria-hidden="true" />
                  <small>{resource.watchStatus === 'unsupported' ? 'Watch unavailable' : resource.watchStatus === 'error' ? 'Watch needs attention' : resource.watchEnabled ? 'Watching' : 'Watch'}</small>
                </label>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Details">
        <dl className="detail-list">
          {workstream.emailAddress && (
            <div>
              <dt>Email</dt>
              {/* The address is a value people copy rather than read, so it
                  stays on one line and leaves the rail through the control
                  beside it; the title carries the rest. */}
              <dd className="copy-detail">
                <span title={workstream.emailAddress}>{workstream.emailAddress}</span>
                <IconButton
                  label={emailCopyState === 'copied'
                    ? 'Work-stream email address copied'
                    : emailCopyState === 'failed'
                      ? 'Copy failed; retry work-stream email address'
                      : 'Copy work-stream email address'}
                  onClick={() => void copyEmailAddress()}
                  title={emailCopyState === 'copied'
                    ? 'Copied'
                    : emailCopyState === 'failed'
                      ? 'Copy failed — click to retry'
                      : 'Copy work-stream email address'}
                >
                  {emailCopyState === 'copied'
                    ? <Check aria-hidden="true" size={12} />
                    : emailCopyState === 'failed'
                      ? <CircleAlert aria-hidden="true" size={12} />
                      : <Copy aria-hidden="true" size={12} />}
                </IconButton>
                <span aria-live="polite" className="sr-only" role="status">
                  {emailCopyState === 'copied'
                    ? 'Work-stream email address copied.'
                    : emailCopyState === 'failed'
                      ? 'The work-stream email address could not be copied.'
                      : ''}
                </span>
              </dd>
            </div>
          )}
          <div><dt>Created by</dt><dd>{workstream.createdBy?.name ?? 'Automation'}</dd></div>
          <div><dt>Created</dt><dd>{formatDateTime(workstream.createdAt)}</dd></div>
          <div><dt>Last activity</dt><dd>{formatRelative(workstream.lastActivityAt)}</dd></div>
          {/* Everything past this point describes how the work stream is wired
              rather than what it is, so it belongs to Application → Developer →
              Debug enabled. */}
          {debugEnabled && (
            <>
              <div><dt>Origin</dt><dd>{workstream.origin === 'automation' ? workstream.automationName ?? 'Automation' : 'Ad hoc'}</dd></div>
              {workstream.automationSubscription && (
                <>
                  <div><dt>Automation</dt><dd>{workstream.automationSubscription.name}</dd></div>
                  <div><dt>Subscription scope</dt><dd>{workstream.automationSubscription.scope === 'you' ? 'You' : 'Workspace'}</dd></div>
                  <div><dt>Subscription status</dt><dd>{workstream.automationSubscription.status}</dd></div>
                  <div><dt>Trigger</dt><dd>{workstream.automationSubscription.triggerSummary}</dd></div>
                  <div><dt>Execution</dt><dd>{workstream.automationSubscription.executionScope}</dd></div>
                  <div><dt>Subscription ID</dt><dd className="mono">{workstream.automationSubscription.id}</dd></div>
                </>
              )}
              {!workstream.automationSubscription && workstream.automationSubscriptionId && <div><dt>Automation subscription</dt><dd className="mono">{workstream.automationSubscriptionId}</dd></div>}
              {workstream.plannedFor && <div><dt>Planned for</dt><dd>{formatDateTime(workstream.plannedFor)}</dd></div>}
              {workstream.automationRunId && <div><dt>Automation run</dt><dd className="mono">{workstream.automationRunId}</dd></div>}
              {workstream.latestHarnessRun && (
                <>
                  <div><dt>Harness status</dt><dd>{workstream.latestHarnessRun.status.replace('_', ' ')}</dd></div>
                  <div><dt>Harness origin</dt><dd>{workstream.latestHarnessRun.origin.replaceAll('_', ' ')}</dd></div>
                  {workstream.latestHarnessRun.model && <div><dt>Model</dt><dd>{workstream.latestHarnessRun.model}</dd></div>}
                  <div><dt>Harness started</dt><dd>{formatDateTime(workstream.latestHarnessRun.startedAt ?? workstream.latestHarnessRun.createdAt)}</dd></div>
                  {workstream.latestHarnessRun.completedAt && <div><dt>Harness completed</dt><dd>{formatDateTime(workstream.latestHarnessRun.completedAt)}</dd></div>}
                  <div><dt>Harness run</dt><dd className="mono">{workstream.latestHarnessRun.id}</dd></div>
                </>
              )}
              {!workstream.latestHarnessRun && workstream.latestHarnessRunId && <div><dt>Harness run</dt><dd className="mono">{workstream.latestHarnessRunId}</dd></div>}
              <div>
                <dt>Work-stream ID</dt>
                <dd className="copy-detail">
                  <span className="mono">{workstream.id}</span>
                  <IconButton label="Copy work-stream ID" onClick={() => void desktopBridge().copyText(workstream.id)}><Copy size={12} /></IconButton>
                </dd>
              </div>
            </>
          )}
        </dl>
      </Section>
    </div>
  );
}

function CollectionCount({ count }: { count: number }): React.JSX.Element {
  return <span aria-label={`${count} ${count === 1 ? 'item' : 'items'}`} className="rail-collection-count">{count}</span>;
}

function taskStatusLabel(status: BackgroundTask['status']): string {
  if (status === 'running') return 'Running';
  if (status === 'needs_input') return 'Needs input';
  if (status === 'failed') return 'Failed';
  return 'Completed';
}

function BackgroundContent({
  tasks = [],
  messages = [],
  workstream,
  onJumpToMessage,
  onDownloadArtifact,
}: Pick<InspectorRailProps, 'tasks' | 'messages' | 'workstream' | 'onJumpToMessage' | 'onDownloadArtifact'>): React.JSX.Element {
  const [filter, setFilter] = useState<'all' | 'running' | 'finished'>('all');
  const inspect = useUiStore((state) => state.inspect);
  const filtered = tasks.filter((task) => filter === 'all' || (filter === 'running' ? task.status === 'running' : task.status !== 'running'));
  const finished = tasks.filter((task) => task.status !== 'running').length;
  const agentTasks = tasks.filter((task) => task.type === 'agent');
  const outputsById = new Map<string, { artifact: ArtifactData; messageId?: string; sortAt: string }>();
  for (const artifact of workstream?.artifacts ?? []) {
    outputsById.set(artifact.id, { artifact, sortAt: artifact.createdAt ?? '' });
  }
  for (const message of messages) {
    if (!message.artifact || outputsById.has(message.artifact.id)) continue;
    outputsById.set(message.artifact.id, { artifact: message.artifact, messageId: message.id, sortAt: message.createdAt });
  }
  const outputs = [...outputsById.values()].sort((left, right) => right.sortAt.localeCompare(left.sortAt));
  const sources = workstream?.resources ?? [];

  return (
    <div className="rail-variant-body background-rail-body">
      <section aria-label="Background task activity" className="background-task-primary">
        <div className="rail-toolbar" role="group" aria-label="Background task filter">
          <button aria-pressed={filter === 'all'} className={filter === 'all' ? 'is-selected' : ''} onClick={() => setFilter('all')} type="button">All {tasks.length}</button>
          <button aria-pressed={filter === 'running'} className={filter === 'running' ? 'is-selected' : ''} onClick={() => setFilter('running')} type="button">Running</button>
          <button aria-pressed={filter === 'finished'} className={filter === 'finished' ? 'is-selected' : ''} onClick={() => setFilter('finished')} type="button">Finished {finished}</button>
        </div>
        {filtered.length === 0 ? (
          <EmptyState title="No background tasks" description={filter === 'all' ? 'Tools and delegated work will appear here as Avalon works.' : `No ${filter} tasks.`} />
        ) : (
          <ul className="task-list">
            {filtered.map((task) => (
              <li className="task-card" key={task.id}>
                <div className="task-title-row">
                  <span className={clsx('task-status', task.status === 'needs_input' ? 'failed' : task.status)} aria-hidden="true" />
                  <strong>{task.title}</strong>
                </div>
                <div className="task-meta">
                  <span>{task.type === 'agent' ? 'Agent' : task.type === 'connector' ? 'Connector' : 'Tool'}</span>
                  <span>{taskStatusLabel(task.status)}</span>
                  {formatDuration(task.durationMs) && <span>{formatDuration(task.durationMs)}</span>}
                </div>
                {(task.tokenCount !== undefined || task.toolUses !== undefined || task.transcriptMessageId) && (
                  <div className="task-details">
                    {task.tokenCount !== undefined && <span>{formatCompactNumber(task.tokenCount)} tokens</span>}
                    {task.toolUses !== undefined && <span>{task.toolUses} tool uses</span>}
                    {task.transcriptMessageId && onJumpToMessage && <button onClick={() => onJumpToMessage(task.transcriptMessageId!)} type="button">View transcript</button>}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="rail-durable-sections">
        <section className="rail-durable-section">
          <header className="rail-collection-header">
            <h3>Outputs</h3>
            <CollectionCount count={outputs.length} />
          </header>
          {outputs.length === 0 ? (
            <p className="rail-collection-empty">Files and other deliverables created here will appear in this section.</p>
          ) : (
            <ul className="rail-compact-list" aria-label="Outputs">
              {outputs.map((output) => {
                const handleOutput = (): void => {
                  if (onDownloadArtifact) {
                    onDownloadArtifact(output.artifact);
                  } else if (output.messageId && onJumpToMessage) {
                    onJumpToMessage(output.messageId);
                  } else {
                    void desktopBridge().copyText(output.artifact.previewText ?? output.artifact.title);
                  }
                };
                const row = (
                  <>
                    <span className="rail-compact-icon"><FileText aria-hidden="true" size={15} /></span>
                    <span className="rail-compact-copy">
                      <strong>{output.artifact.title}</strong>
                      <small>{output.artifact.artifactType}{output.artifact.status ? ` · ${output.artifact.status}` : ''}</small>
                    </span>
                    {onDownloadArtifact ? <Download aria-hidden="true" size={14} /> : output.messageId && onJumpToMessage ? <ChevronRight aria-hidden="true" size={14} /> : <Copy aria-hidden="true" size={14} />}
                  </>
                );
                return (
                  <li key={output.artifact.id}>
                    <button
                      aria-label={`${onDownloadArtifact ? 'Download' : output.messageId && onJumpToMessage ? 'Show' : 'Copy'} ${output.artifact.title}`}
                      className="rail-compact-row"
                      onClick={handleOutput}
                      type="button"
                    >{row}</button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section className="rail-durable-section">
          <header className="rail-collection-header">
            <h3>Agent work</h3>
            <CollectionCount count={agentTasks.length} />
          </header>
          {agentTasks.length === 0 ? (
            <p className="rail-collection-empty">Delegated agent work will appear here when this work stream needs it.</p>
          ) : (
            <ul className="rail-compact-list" aria-label="Agent work">
              {agentTasks.map((task) => (
                <li key={task.id}>
                  {task.transcriptMessageId && onJumpToMessage ? (
                    <button className="rail-compact-row" onClick={() => onJumpToMessage(task.transcriptMessageId!)} type="button">
                      <span className="rail-compact-icon"><Bot aria-hidden="true" size={15} /></span>
                      <span className="rail-compact-copy"><strong>{task.title}</strong><small>{taskStatusLabel(task.status)}{formatDuration(task.durationMs) ? ` · ${formatDuration(task.durationMs)}` : ''}</small></span>
                      <ChevronRight aria-hidden="true" size={14} />
                    </button>
                  ) : (
                    <button aria-label={`Copy run ID for ${task.title}`} className="rail-compact-row" onClick={() => void desktopBridge().copyText(task.harnessRunId ?? task.id)} type="button">
                      <span className="rail-compact-icon"><Bot aria-hidden="true" size={15} /></span>
                      <span className="rail-compact-copy"><strong>{task.title}</strong><small>{taskStatusLabel(task.status)}{formatDuration(task.durationMs) ? ` · ${formatDuration(task.durationMs)}` : ''}</small></span>
                      <Copy aria-hidden="true" size={14} />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="rail-durable-section">
          <header className="rail-collection-header">
            <h3>Sources</h3>
            <CollectionCount count={sources.length} />
          </header>
          {sources.length === 0 ? (
            <p className="rail-collection-empty">Files and links used by this work stream will appear here.</p>
          ) : (
            <ul className="rail-compact-list" aria-label="Sources">
              {sources.map((resource) => (
                <li key={resource.id}>
                  <button className="rail-compact-row" onClick={() => inspect({ type: 'resource', id: resource.id })} type="button">
                    <span className="rail-compact-icon"><ResourceIcon type={resource.resourceType} /></span>
                    <span className="rail-compact-copy"><strong>{resource.title}</strong><small>{resource.provider ?? resource.resourceType}</small></span>
                    <ChevronRight aria-hidden="true" size={14} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

function RunsContent({ runs = [], onOpenRun }: Pick<InspectorRailProps, 'runs' | 'onOpenRun'>): React.JSX.Element {
  const [filter, setFilter] = useState<'all' | 'scheduled' | 'manual'>('all');
  const filtered = runs.filter((run) => filter === 'all' || (filter === 'scheduled' ? run.triggerType === 'scheduled' : run.triggerType === 'manual'));
  return (
    <div className="rail-variant-body">
      <div className="rail-toolbar" role="group" aria-label="Run filter">
        {(['all', 'scheduled', 'manual'] as const).map((value) => (
          <button aria-pressed={filter === value} className={filter === value ? 'is-selected' : ''} key={value} onClick={() => setFilter(value)} type="button">
            {value[0]!.toUpperCase() + value.slice(1)}
          </button>
        ))}
      </div>
      {filtered.length === 0 ? (
        <EmptyState title="No runs yet" description="Scheduled, manual, activity, and webhook runs appear here." />
      ) : (
        <ul className="run-rail-list">
          {filtered.map((run) => (
            <li key={run.id}>
              <button className="run-rail-row" onClick={() => onOpenRun?.(run)} type="button">
                <StatusDot compact status={run.status} />
                <span className="run-rail-copy">
                  <strong>{run.title}</strong>
                  <small>{run.resultSummary ?? (run.status === 'running' ? `Running ${formatRelative(run.triggerTime)}` : formatRelative(run.triggerTime))}</small>
                </span>
                <Badge>{run.triggerType.toUpperCase()}</Badge>
                <ChevronRight aria-hidden="true" size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function InspectorDetail({ workstream, onDetachResource }: Pick<InspectorRailProps, 'workstream' | 'onDetachResource'>): React.JSX.Element | null {
  const inspector = useUiStore((state) => state.inspector);
  if (!inspector || !workstream) return null;
  const resource = inspector.type === 'resource' ? workstream.resources.find((item) => item.id === inspector.id) : undefined;

  if (resource) {
    return (
      <div className="inspector-detail">
        <span className="inspector-hero-icon"><ResourceIcon type={resource.resourceType} /></span>
        <h3>{resource.title}</h3>
        <p>{resource.provider ?? resource.resourceType}</p>
        <dl className="detail-list">
          <div><dt>Type</dt><dd>{resource.resourceType}</dd></div>
          <div><dt>Watch status</dt><dd>{resource.watchStatus === 'unsupported' ? 'Not supported' : resource.watchStatus === 'error' ? 'Needs attention' : resource.watchEnabled ? 'Watching for changes' : 'Not watched'}</dd></div>
          {resource.updatedAt && <div><dt>Last updated</dt><dd>{formatDateTime(resource.updatedAt)}</dd></div>}
        </dl>
        <div className="inspector-detail-actions">
          {resource.canonicalUrl && <Button onClick={() => void window.avalon?.openExternal(resource.canonicalUrl!)}><ExternalLink size={14} /> Open source</Button>}
          {onDetachResource && <Button onClick={() => onDetachResource(resource)}><Trash2 size={14} /> Remove</Button>}
        </div>
      </div>
    );
  }
  return <EmptyState title="Item unavailable" description="It may have been removed or changed in another session." />;
}

const railTitle: Record<RailVariant, string> = {
  context: 'Work stream',
  background: 'Background tasks',
  runs: 'Runs',
};

export function InspectorRail(props: InspectorRailProps): React.JSX.Element | null {
  const railOpen = useUiStore((state) => state.railOpen);
  const railVariant = useUiStore((state) => state.railVariant);
  const railWidth = useUiStore((state) => state.railWidth);
  const railExpanded = useUiStore((state) => state.railExpanded);
  const inspector = useUiStore((state) => state.inspector);
  const closeRail = useUiStore((state) => state.closeRail);
  const setRailWidth = useUiStore((state) => state.setRailWidth);
  const toggleRailExpanded = useUiStore((state) => state.toggleRailExpanded);
  const inspect = useUiStore((state) => state.inspect);
  const railRef = useRef<HTMLElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const [resizing, setResizing] = useState(false);
  const tasks = props.tasks ?? props.workstream?.backgroundTasks ?? [];
  const runs = props.runs ?? props.workstream?.automationRuns ?? [];

  useEffect(() => {
    if (!railOpen) return;
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    requestAnimationFrame(() => railRef.current?.focus());
    return () => previousFocus.current?.focus();
  }, [railOpen]);

  useEffect(() => {
    if (!resizing) return;
    const move = (event: PointerEvent): void => setRailWidth(window.innerWidth - event.clientX - 8);
    const stop = (): void => setResizing(false);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop, { once: true });
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
    };
  }, [resizing, setRailWidth]);

  if (!railOpen) return null;
  const displayedWidth = railExpanded ? Math.max(520, railWidth) : railWidth;

  return (
    <>
      <button aria-label="Close inspector" className="rail-scrim" onClick={closeRail} type="button" />
      <aside
        aria-label={inspector ? 'Inspector detail' : railTitle[railVariant]}
        className={clsx('inspector-rail', resizing && 'is-resizing', props.dropTarget?.dragging && 'is-file-dragging')}
        onDragEnter={props.dropTarget?.onDragEnter}
        onDragLeave={props.dropTarget?.onDragLeave}
        onDragOver={props.dropTarget?.onDragOver}
        onDrop={props.dropTarget?.onDrop}
        onKeyDown={(event) => {
          if (event.key === 'Escape') closeRail();
        }}
        ref={railRef}
        style={{ width: displayedWidth }}
        tabIndex={-1}
      >
        <div
          aria-label="Resize inspector"
          aria-orientation="vertical"
          aria-valuemax={560}
          aria-valuemin={320}
          aria-valuenow={displayedWidth}
          className="rail-resizer"
          onKeyDown={(event) => {
            if (event.key === 'ArrowLeft') setRailWidth(railWidth + 16);
            if (event.key === 'ArrowRight') setRailWidth(railWidth - 16);
          }}
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId);
            setResizing(true);
          }}
          role="separator"
          tabIndex={0}
        />
        <header className="rail-header window-drag">
          <div className="rail-title window-no-drag">
            {inspector && <IconButton label="Back to context" onClick={() => inspect(null)}><ArrowLeft size={15} /></IconButton>}
            <h2>{inspector ? 'Details' : railTitle[railVariant]}</h2>
          </div>
          <div className="rail-header-actions window-no-drag">
            <IconButton label={railExpanded ? 'Restore inspector width' : 'Expand inspector'} onClick={toggleRailExpanded}>
              {railExpanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
            </IconButton>
            <IconButton label="Close inspector" onClick={closeRail}><X size={15} /></IconButton>
          </div>
        </header>
        <div className="rail-scroll">
          {props.error && <div className="rail-inline-error"><InlineError>{props.error}</InlineError></div>}
          {inspector ? (
            <InspectorDetail onDetachResource={props.onDetachResource} workstream={props.workstream} />
          ) : railVariant === 'context' ? (
            <ContextContent {...props} />
          ) : railVariant === 'background' ? (
            <BackgroundContent messages={props.messages} onDownloadArtifact={props.onDownloadArtifact} onJumpToMessage={props.onJumpToMessage} tasks={tasks} workstream={props.workstream} />
          ) : (
            <RunsContent onOpenRun={props.onOpenRun} runs={runs} />
          )}
        </div>
      </aside>
    </>
  );
}
