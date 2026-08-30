import {
  ArrowLeft,
  Check,
  ChevronRight,
  CircleAlert,
  Copy,
  ExternalLink,
  Eye,
  LoaderCircle,
  Plus,
  RefreshCcw,
  Trash2,
  UserPlus,
  X,
} from 'lucide-react';
import { classifyAttachmentKind } from '@rally/contracts';
import { useEffect, useState } from 'react';
import { formatDateTime, formatRelative } from '../lib/format';
import { MAX_RESOURCE_PREVIEW_WAIT_MS, readResourcePreviewText } from '../lib/resource-preview';
import { desktopBridge } from '../lib/platform';
import { reportTelemetryProductIntent } from '../lib/telemetry';
import type {
  AutomationRunSummary,
  ResourceVersion,
  WorkstreamDetail,
  WorkstreamResource,
} from '../lib/types';
import { type RailVariant, useUiStore } from '../lib/ui-store';
import { useDebugEnabled } from '../lib/use-debug-enabled';
import { ResourceIcon } from './markdown-citations';
import { Avatar, Badge, Button, EmptyState, IconButton, InlineError, StatusDot } from './primitives';
import { MarkdownBody } from './workstream-blocks';
import { RailSurface } from './rail-surface';

interface InspectorRailProps {
  error?: string;
  /**
   * Reads a resource's readable preview, so the detail can show what the thing
   * actually says. This is the authorized preview route — the same one the
   * attachment lightbox uses — not the raw object: it is what turns a Word
   * file or a PDF into prose. Absent on a surface that has no API session,
   * where the detail stays the metadata card it has always been.
   */
  loadResourceContent?: (id: string, signal?: AbortSignal) => Promise<Blob>;
  workstream?: WorkstreamDetail;
  runs?: AutomationRunSummary[];
  onAddParticipant?: () => void;
  onAddResource?: () => void;
  onDetachResource?: (resource: WorkstreamResource) => void;
  onToggleWatch?: (resource: WorkstreamResource, enabled: boolean) => void;
  /** History for whichever resource the detail is showing, newest first. */
  resourceVersions?: ResourceVersion[];
  /** Set when the history could not be loaded, so absence is not read as none. */
  resourceVersionsError?: string | undefined;
  /**
   * Opens a prior version read-only. Carries the control that opened it so the
   * preview can hand focus back, the way every other opener on this surface
   * does — closing to `<body>` loses a keyboard reader's place in the rail.
   */
  onOpenResourceVersion?: (
    resource: WorkstreamResource,
    version: ResourceVersion,
    returnFocus: HTMLElement,
  ) => void;
  onRefreshResource?: (resource: WorkstreamResource) => void;
  refreshingResourceId?: string | null;
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
 * Whether to ask for a readable preview at all.
 *
 * Deliberately almost nothing: the *server* owns what is previewable. The
 * preview route returns the bytes for text and markdown and a materialized
 * text derivative for everything else — a Word file's prose, a PDF's OCR — and
 * answers 422 when it genuinely cannot. Deciding here instead is how a second
 * opinion about the same file gets two answers on two surfaces, and it already
 * had: reading `classifyAttachmentKind` locally called a `.docx` a "document"
 * and rendered the raw bytes of a zip, while calling a PDF unreadable and
 * showing nothing for the most commonly attached document there is.
 *
 * What stays local is the one thing the rail decides for itself: an image is
 * not prose. The rail is 360 pixels wide and this is the readable half of a
 * detail card, not a lightbox.
 */
function readableAsText(resource: WorkstreamResource): boolean {
  if (!resource.contentAvailable) return false;
  return classifyAttachmentKind({ fileName: resource.title, mimeType: resource.mimeType }) !== 'image';
}

/**
 * What the resource says, under what the record says about it.
 *
 * The rail's detail was metadata only — type, direction, version, remove — and
 * a citation that opened onto it landed on a card describing a document without
 * showing any of it. This is the missing half, and it is the reason a citation
 * is worth clicking.
 *
 * It renders `verbatim`, which is the one thing here that is not a preference:
 * the model-text repair exists to fix what a *model* wrote on its way to a
 * reader, and a stored document is a file. Rewriting its bytes would show
 * somebody something their document does not say.
 */
function ResourceContentPreview({ loadResourceContent, resource }: {
  loadResourceContent: NonNullable<InspectorRailProps['loadResourceContent']>;
  resource: WorkstreamResource;
}): React.JSX.Element | null {
  const [state, setState] = useState<{ text?: string; failed?: boolean }>({});

  useEffect(() => {
    const controller = new AbortController();
    setState({});
    void readResourcePreviewText(loadResourceContent, resource.id, controller.signal, MAX_RESOURCE_PREVIEW_WAIT_MS)
      .then((text) => {
        if (!controller.signal.aborted) setState({ text });
      })
      .catch(() => {
        // A resource whose content was never hydrated, whose object has since
        // gone, or whose format the server will not convert is not an error the
        // reader can act on — the metadata above is still true, and saying so
        // beats an empty panel. A preview still being prepared is not one of
        // these, and no longer arrives here until the retries are spent.
        if (!controller.signal.aborted) setState({ failed: true });
      });
    return () => controller.abort();
    // `currentVersion` as well as the id: a watched source re-ingested in place
    // keeps its id, and the metadata above this preview shows the new version
    // number. Without it the panel put version 3's number over version 2's
    // text, which is a citation substantiating a claim with the wrong revision.
  }, [loadResourceContent, resource.currentVersion, resource.id]);

  if (state.failed) {
    return <p className="inspector-detail-preview-status">This preview is not available.</p>;
  }
  if (state.text === undefined) {
    return (
      <p className="inspector-detail-preview-status" role="status">
        <LoaderCircle aria-hidden="true" className="spin" size={14} /> Loading preview…
      </p>
    );
  }
  return (
    <article className="inspector-detail-preview">
      <MarkdownBody verbatim>{state.text}</MarkdownBody>
    </article>
  );
}

/**
 * Who a version row names, in the words the rail can actually show.
 *
 * A run and a connection are ids nothing in the rail resolves to a name, so
 * the agent reads as Rally and a connector as the provider the resource came
 * from. A version nothing attributed says so rather than picking someone.
 */
function versionAuthorLabel(
  version: ResourceVersion,
  resource: WorkstreamResource,
  participants: WorkstreamDetail['participants'],
): string {
  const author = version.author;
  switch (author?.kind) {
    case 'agent':
    case 'system':
      return 'Rally';
    case 'member':
      return participants.find((person) => person.id === author.userId)?.name ?? 'A teammate';
    case 'connector':
      return resource.provider ?? 'Connector';
    default:
      return 'Unattributed';
  }
}

/**
 * Whether the preview surface can show this version from its stored bytes.
 *
 * The version routes serve the object as written, with none of the conversion
 * the current-content preview route performs — so a PDF or a Word file has no
 * readable prior version to open, and offering one would render binary noise
 * under a title that says it is the document.
 */
function versionIsOpenable(version: ResourceVersion): boolean {
  if (!version.contentAvailable) return false;
  const kind = classifyAttachmentKind({ fileName: version.title, mimeType: version.mimeType });
  return kind === 'image' || kind === 'markdown' || kind === 'text';
}

function ResourceVersions({ resource, versions, error, onOpenResourceVersion, participants }: {
  resource: WorkstreamResource;
  versions: ResourceVersion[];
  error?: string | undefined;
  onOpenResourceVersion?: InspectorRailProps['onOpenResourceVersion'];
  participants: WorkstreamDetail['participants'];
}): React.JSX.Element | null {
  // One entry is not history — it is the resource, which the detail above
  // already describes. The section appears the moment something changes, and
  // whenever the history is owed but could not be read: a resource that never
  // changed and a resource whose history failed to load are different answers,
  // and collapsing them tells the reader the wrong one.
  if (!error && versions.length < 2) return null;
  return (
    <section className="rail-section inspector-versions">
      <header className="rail-section-header"><h3>Versions</h3></header>
      {error
        ? <p className="inspector-detail-preview-status">{error}</p>
        : (
          <ul>
            {versions.map((version, index) => (
              <li key={version.version}>
                <span className="inspector-version-label">V{version.version}</span>
                <span className="inspector-version-meta">
                  <span className="inspector-version-author">{versionAuthorLabel(version, resource, participants)}</span>
                  <time dateTime={version.capturedAt}>{formatDateTime(version.capturedAt)}</time>
                </span>
                {/* The list is newest-first and authoritative about itself. The
                    detail's version number comes from another cache, and the
                    two disagree exactly while a swap is settling — which is
                    when putting "Current" on a superseded row does most harm. */}
                {index === 0
                  ? <Badge>Current</Badge>
                  : versionIsOpenable(version) && (
                    <IconButton
                      label={`Open version ${version.version}`}
                      onClick={(event) => onOpenResourceVersion?.(resource, version, event.currentTarget)}
                      tooltipSide="left"
                    >
                      <Eye size={14} />
                    </IconButton>
                  )}
              </li>
            ))}
          </ul>
        )}
    </section>
  );
}

function InspectorDetail({
  loadResourceContent,
  workstream,
  onDetachResource,
  onOpenResourceVersion,
  onRefreshResource,
  refreshingResourceId,
  resourceVersions,
  resourceVersionsError,
}: Pick<
  InspectorRailProps,
  'loadResourceContent' | 'workstream' | 'onDetachResource' | 'onOpenResourceVersion'
  | 'onRefreshResource' | 'refreshingResourceId' | 'resourceVersions' | 'resourceVersionsError'
>): React.JSX.Element | null {
  const inspector = useUiStore((state) => state.inspector);
  if (!inspector || !workstream) return null;
  const resource = inspector.type === 'resource' ? workstream.resources.find((item) => item.id === inspector.id) : undefined;

  if (resource) {
    // Direction says whether this work stream consumed or produced the
    // resource; the server-computed adapter capability says whether its
    // connector can actually fulfill a re-fetch.
    const refreshable = resource.direction === 'source' && resource.refreshSupported;
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
        {loadResourceContent && readableAsText(resource) && (
          <ResourceContentPreview loadResourceContent={loadResourceContent} resource={resource} />
        )}
        <div className="inspector-detail-actions">
          {resource.canonicalUrl && <Button onClick={() => void window.rally?.openExternal(resource.canonicalUrl!)}><ExternalLink size={14} /> Open source</Button>}
          {refreshable && onRefreshResource && (
            <Button
              disabled={refreshingResourceId === resource.id}
              onClick={() => onRefreshResource(resource)}
            >
              <RefreshCcw size={14} /> Refresh from source
            </Button>
          )}
          {onDetachResource && <Button onClick={() => onDetachResource(resource)}><Trash2 size={14} /> Remove</Button>}
        </div>
        <ResourceVersions
          error={resourceVersionsError}
          onOpenResourceVersion={onOpenResourceVersion}
          participants={workstream.participants}
          resource={resource}
          versions={resourceVersions ?? []}
        />
      </div>
    );
  }
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
            {...(props.loadResourceContent ? { loadResourceContent: props.loadResourceContent } : {})}
            onDetachResource={props.onDetachResource}
            onOpenResourceVersion={props.onOpenResourceVersion}
            onRefreshResource={props.onRefreshResource}
            refreshingResourceId={props.refreshingResourceId}
            resourceVersions={props.resourceVersions}
            resourceVersionsError={props.resourceVersionsError}
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
