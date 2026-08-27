import {
  ArrowLeft,
  Check,
  ChevronRight,
  CircleAlert,
  Copy,
  ExternalLink,
  Eye,
  File,
  FileText,
  Link2,
  Plus,
  Trash2,
  UserPlus,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { formatDateTime, formatRelative } from '../lib/format';
import { desktopBridge } from '../lib/platform';
import { reportTelemetryProductIntent } from '../lib/telemetry';
import type {
  AutomationRunSummary,
  WorkstreamDetail,
  WorkstreamResource,
} from '../lib/types';
import { type RailVariant, useUiStore } from '../lib/ui-store';
import { useDebugEnabled } from '../lib/use-debug-enabled';
import { DocumentPreviewContent, useDocumentPreview } from './document-preview';
import { Avatar, Badge, Button, EmptyState, IconButton, InlineError, StatusDot } from './primitives';
import { RailSurface } from './rail-surface';

interface InspectorRailProps {
  error?: string;
  workstream?: WorkstreamDetail;
  runs?: AutomationRunSummary[];
  onAddParticipant?: () => void;
  onAddResource?: () => void;
  onDetachResource?: (resource: WorkstreamResource) => void;
  /**
   * Reads a resource's own bytes for the detail view's preview.
   *
   * A prop rather than a call to the API client from inside the rail, because
   * the two screens that mount this already hold one and the rail holds none.
   */
  loadResourceContent?: (resourceId: string, signal?: AbortSignal) => Promise<Blob>;
  onToggleWatch?: (resource: WorkstreamResource, enabled: boolean) => void;
  onOpenRun?: (run: AutomationRunSummary) => void;
  /** True while the inspector is fading out under HyperSight taking the slot. */
  leaving?: boolean;
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

function ResourceCards({
  resources,
  onToggleWatch,
}: {
  resources: WorkstreamResource[];
  onToggleWatch?: (resource: WorkstreamResource, enabled: boolean) => void;
}): React.JSX.Element {
  const inspect = useUiStore((state) => state.inspect);
  return (
    <ul className="rail-card-list">
      {resources.map((resource) => {
        const watch = watchLabel(resource);
        return (
          <li className="rail-card resource-row" key={resource.id}>
            <button className="rail-card-main" onClick={() => inspect({ type: 'resource', id: resource.id })} type="button">
              <span className="rail-card-icon"><ResourceIcon type={resource.resourceType} /></span>
              <span><strong>{resource.title}</strong><small>{resource.provider ?? resource.resourceType}</small></span>
            </button>
            {resource.direction === 'source' && (
              <label className="watch-toggle" title={watch.name}>
                <input
                  aria-label={watch.name}
                  checked={resource.watchEnabled}
                  disabled={resource.watchStatus === 'unsupported'}
                  onChange={(event) => onToggleWatch?.(resource, event.target.checked)}
                  type="checkbox"
                />
                <small>{watch.text}</small>
                <span aria-hidden="true" />
              </label>
            )}
            <ChevronRight aria-hidden="true" className="resource-row-chevron" size={14} />
          </li>
        );
      })}
    </ul>
  );
}

// The row is narrow enough that the status text competes with the resource
// title for width, so the visible label is kept short and the fuller phrasing
// is left to the accessible name.
function watchLabel(resource: WorkstreamResource): { text: string; name: string } {
  if (resource.watchStatus === 'unsupported') return { text: 'Unavailable', name: 'Watch unavailable' };
  if (resource.watchStatus === 'error') return { text: 'Needs attention', name: 'Watch needs attention' };
  if (resource.watchEnabled) return { text: 'Watching', name: 'Watching' };
  return { text: 'Watch', name: 'Watch' };
}

function ContextContent({
  workstream,
  onAddParticipant,
  onAddResource,
  onToggleWatch,
}: Pick<InspectorRailProps,
  | 'workstream'
  | 'onAddParticipant'
  | 'onAddResource'
  | 'onToggleWatch'
>): React.JSX.Element {
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
  const sources = workstream.resources.filter((resource) => resource.direction === 'source');
  const artifacts = workstream.resources.filter((resource) => resource.direction === 'artifact');

  const copyEmailAddress = async (): Promise<void> => {
    if (!workstream.emailAddress) return;
    try {
      await desktopBridge().copyText(workstream.emailAddress);
      reportTelemetryProductIntent({
        kind: 'content_copied', contentType: 'workstream_email', resourceType: 'workstream',
        resourceId: workstream.id,
      });
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
        title="Sources"
      >
        {sources.length === 0 ? (
          <p className="rail-empty-line">No sources attached</p>
        ) : (
          <ResourceCards onToggleWatch={onToggleWatch} resources={sources} />
        )}
      </Section>

      <Section title="Artifacts">
        {artifacts.length === 0 ? (
          <p className="rail-empty-line">No artifacts generated</p>
        ) : (
          <ResourceCards resources={artifacts} />
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
                  <IconButton label="Copy work-stream ID" onClick={() => {
                    void desktopBridge().copyText(workstream.id)
                      .then(() => reportTelemetryProductIntent({
                        kind: 'content_copied', contentType: 'workstream_id', resourceType: 'workstream',
                        resourceId: workstream.id,
                      }))
                      .catch(() => undefined);
                  }}><Copy size={12} /></IconButton>
                </dd>
              </div>
            </>
          )}
        </dl>
      </Section>
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

/**
 * The resource's own content, beneath its metadata.
 *
 * This half is what makes a citation worth clicking. The detail view showed
 * type, direction, version and a Remove button and nothing a person could
 * read — so a chip opened a card about a document rather than the document.
 * The bytes come through the authorized preview route, and the same component
 * the attachment lightbox uses renders them.
 */
function ResourceContentPreview({ loadContent, resource }: {
  loadContent?: (resourceId: string, signal?: AbortSignal) => Promise<Blob>;
  resource: WorkstreamResource;
}): React.JSX.Element | null {
  const source = useMemo(() => (
    resource.contentAvailable && loadContent
      ? {
        name: resource.title,
        ...(resource.mimeType ? { mimeType: resource.mimeType } : {}),
        loadContent: (signal?: AbortSignal) => loadContent(resource.id, signal),
      }
      : null
  ), [loadContent, resource.contentAvailable, resource.id, resource.mimeType, resource.title]);
  const state = useDocumentPreview(source);
  if (!state) return null;
  return (
    <div className={`inspector-detail-preview is-${state.mode}`}>
      <DocumentPreviewContent name={resource.title} state={state} />
    </div>
  );
}

function InspectorDetail({ workstream, onDetachResource, loadResourceContent }: Pick<InspectorRailProps, 'workstream' | 'onDetachResource' | 'loadResourceContent'>): React.JSX.Element | null {
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
          <div><dt>Direction</dt><dd>{resource.direction === 'artifact' ? 'Artifact' : 'Source'}</dd></div>
          <div><dt>Version</dt><dd>{resource.currentVersion}</dd></div>
          {resource.direction === 'source' && <div><dt>Watch status</dt><dd>{resource.watchStatus === 'unsupported' ? 'Not supported' : resource.watchStatus === 'error' ? 'Needs attention' : resource.watchEnabled ? 'Watching for changes' : 'Not watched'}</dd></div>}
          {resource.updatedAt && <div><dt>Last updated</dt><dd>{formatDateTime(resource.updatedAt)}</dd></div>}
        </dl>
        <div className="inspector-detail-actions">
          {resource.canonicalUrl && <Button onClick={() => void window.rally?.openExternal(resource.canonicalUrl!)}><ExternalLink size={14} /> Open source</Button>}
          {onDetachResource && <Button onClick={() => onDetachResource(resource)}><Trash2 size={14} /> Remove</Button>}
        </div>
        <ResourceContentPreview loadContent={loadResourceContent} resource={resource} />
      </div>
    );
  }
  // Where a citation for a resource outside the loaded work stream lands. The
  // rail resolves from the work stream's own resource set, so this is the
  // honest answer rather than a silent no-op; fetch-by-id detail for an
  // arbitrary cited resource is named follow-up work.
  return <EmptyState title="Item unavailable" description="It may have been removed or changed in another session." />;
}

const railTitle: Record<RailVariant, string> = {
  context: 'Work stream',
  runs: 'Runs',
};

export function InspectorRail(props: InspectorRailProps): React.JSX.Element | null {
  const railOpen = useUiStore((state) => state.railOpen);
  const railVariant = useUiStore((state) => state.railVariant);
  const railWidth = useUiStore((state) => state.railWidth);
  const inspector = useUiStore((state) => state.inspector);
  const closeRail = useUiStore((state) => state.closeRail);
  const setRailWidth = useUiStore((state) => state.setRailWidth);
  const inspect = useUiStore((state) => state.inspect);
  const runs = props.runs ?? props.workstream?.automationRuns ?? [];

  // The rail is already closed while it fades out under HyperSight, so the
  // hand-off keeps it on screen for exactly as long as that fade lasts.
  if (!railOpen && !props.leaving) return null;

  return (
    <RailSurface
      className="inspector-rail"
      dropTarget={props.dropTarget}
      label={inspector ? 'Inspector detail' : railTitle[railVariant]}
      leaving={props.leaving}
      onClose={closeRail}
      onResize={setRailWidth}
      resizeLabel="Resize inspector"
      scrimLabel="Close inspector"
      width={railWidth}
    >
      <header className="rail-header window-drag">
        <div className="rail-title window-no-drag">
          {inspector && <IconButton label="Back to context" onClick={() => inspect(null)}><ArrowLeft size={15} /></IconButton>}
          <h2>{inspector ? 'Details' : railTitle[railVariant]}</h2>
        </div>
        <div className="rail-header-actions window-no-drag">
          <IconButton label="Close inspector" onClick={closeRail}><X size={15} /></IconButton>
        </div>
      </header>
      <div className="rail-scroll">
        {props.error && <div className="rail-inline-error"><InlineError>{props.error}</InlineError></div>}
        {inspector ? (
          <InspectorDetail
            loadResourceContent={props.loadResourceContent}
            onDetachResource={props.onDetachResource}
            workstream={props.workstream}
          />
        ) : railVariant === 'context' ? (
          <ContextContent {...props} />
        ) : (
          <RunsContent onOpenRun={props.onOpenRun} runs={runs} />
        )}
      </div>
    </RailSurface>
  );
}
