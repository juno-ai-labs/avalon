import {
  Archive,
  ArrowLeft,
  Check,
  ChevronRight,
  CircleAlert,
  Copy,
  ExternalLink,
  Eye,
  History,
  LoaderCircle,
  Plus,
  RefreshCcw,
  UserPlus,
  X,
} from 'lucide-react';
import { classifyAttachmentKind } from '@rally/contracts';
import { useEffect, useState } from 'react';
import { formatDateTime, formatRelative, formatSparseRelativeDate } from '../lib/format';
import { MAX_RESOURCE_PREVIEW_WAIT_MS, readResourcePreviewText } from '../lib/resource-preview';
import { desktopBridge } from '../lib/platform';
import { reportTelemetryProductIntent } from '../lib/telemetry';
import type {
  AutomationRunSummary,
  ResourceVersion,
  WorkstreamDetail,
  WorkstreamResource,
} from '../lib/types';
import { type RailInspector, type RailVariant, useUiStore } from '../lib/ui-store';
import { useDebugEnabled } from '../lib/use-debug-enabled';
import { ResourceIcon } from './markdown-citations';
import { Avatar, Badge, Button, EmptyState, IconButton, InlineError, Modal, StatusDot } from './primitives';
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
 * The rail's detail used to be metadata only — type, direction, version, remove —
 * and a citation that opened onto it landed on a card describing a document
 * without showing any of it. The body is the reason a citation is worth
 * clicking: last-updated and the rendered markdown share one scroll, with no
 * inner box, so the panel reads as the document itself.
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
        // reader can act on — last-updated above is still true, and saying so
        // beats an empty panel. A preview still being prepared is not one of
        // these, and no longer arrives here until the retries are spent.
        if (!controller.signal.aborted) setState({ failed: true });
      });
    return () => controller.abort();
    // `currentVersion` as well as the id: a watched source re-ingested in place
    // keeps its id, and last-updated above this body shows the new revision.
    // Without it the panel put a new timestamp over version 2's text, which is
    // a citation substantiating a claim with the wrong revision.
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
    <article className="inspector-detail-document">
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

function groupVersionsBySparseDate(
  versions: ResourceVersion[],
  now = new Date(),
): Array<{ label: string; versions: ResourceVersion[] }> {
  const groups: Array<{ label: string; versions: ResourceVersion[] }> = [];
  for (const version of versions) {
    const label = formatSparseRelativeDate(version.capturedAt, now);
    const current = groups.at(-1);
    if (current?.label === label) current.versions.push(version);
    else groups.push({ label, versions: [version] });
  }
  return groups;
}

function ResourceVersions({ resource, versions, error, onOpenResourceVersion, participants }: {
  resource: WorkstreamResource;
  versions: ResourceVersion[] | undefined;
  error?: string | undefined;
  onOpenResourceVersion?: InspectorRailProps['onOpenResourceVersion'];
  participants: WorkstreamDetail['participants'];
}): React.JSX.Element {
  const currentVersion = versions?.[0]?.version;

  return (
    <div aria-label="Versions" className="inspector-versions" role="region">
      <h3 className="sr-only">Versions</h3>
      {error
        ? <p className="inspector-detail-preview-status">{error}</p>
        : versions === undefined
          ? (
            <p className="inspector-detail-preview-status" role="status">
              <LoaderCircle aria-hidden="true" className="spin" size={14} /> Loading versions…
            </p>
          )
          : versions.length === 0
            ? <p className="inspector-detail-preview-status">No versions yet.</p>
            : groupVersionsBySparseDate(versions).map((group) => (
              <section key={group.label}>
                <h4 className="inspector-version-group-label">
                  <time dateTime={group.versions[0]?.capturedAt}>{group.label}</time>
                </h4>
                <ul>
                  {group.versions.map((version) => (
                    <li key={version.version}>
                      <span className="inspector-version-label">V{version.version}</span>
                      <span className="inspector-version-meta">
                        <span className="inspector-version-author">{versionAuthorLabel(version, resource, participants)}</span>
                      </span>
                      {/* Newest-first and authoritative about itself. The detail's
                          version number comes from another cache, and the two
                          disagree exactly while a swap is settling — which is when
                          putting "Current" on a superseded row does most harm. */}
                      {version.version === currentVersion
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
              </section>
            ))}
    </div>
  );
}

function InspectorDetail({
  loadResourceContent,
  workstream,
  onOpenResourceVersion,
  onRefreshResource,
  refreshingResourceId,
  resourceVersions,
  resourceVersionsError,
  versionsOpen,
}: Pick<
  InspectorRailProps,
  'loadResourceContent' | 'workstream' | 'onOpenResourceVersion'
  | 'onRefreshResource' | 'refreshingResourceId' | 'resourceVersions' | 'resourceVersionsError'
> & { versionsOpen: boolean }): React.JSX.Element | null {
  const inspector = useUiStore((state) => state.inspector);
  if (!inspector || !workstream) return null;
  const resource = inspector.type === 'resource' ? workstream.resources.find((item) => item.id === inspector.id) : undefined;

  if (resource) {
    if (versionsOpen) {
      return (
        <ResourceVersions
          error={resourceVersionsError}
          onOpenResourceVersion={onOpenResourceVersion}
          participants={workstream.participants}
          resource={resource}
          versions={resourceVersions}
        />
      );
    }

    // Direction says whether this work stream consumed or produced the
    // resource; the server-computed adapter capability says whether its
    // connector can actually fulfill a re-fetch.
    const refreshable = resource.direction === 'source' && resource.refreshSupported;
    const sourceActions = Boolean(resource.canonicalUrl || (refreshable && onRefreshResource));
    return (
      <div className="inspector-detail">
        {resource.updatedAt && (
          <p className="inspector-detail-updated">
            Last updated <time dateTime={resource.updatedAt}>{formatDateTime(resource.updatedAt)}</time>
          </p>
        )}
        {sourceActions && (
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
          </div>
        )}
        {loadResourceContent && readableAsText(resource) && (
          <ResourceContentPreview loadResourceContent={loadResourceContent} resource={resource} />
        )}
      </div>
    );
  }
  return <EmptyState title="Item unavailable" description="It may have been removed or changed in another session." />;
}

function inspectedResource(
  inspector: RailInspector | null,
  workstream: WorkstreamDetail | undefined,
): WorkstreamResource | undefined {
  if (!inspector || inspector.type !== 'resource' || !workstream) return undefined;
  return workstream.resources.find((item) => item.id === inspector.id);
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
  const resource = inspectedResource(inspector, props.workstream);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [archiveConfirmOpen, setArchiveConfirmOpen] = useState(false);

  useEffect(() => {
    setVersionsOpen(false);
    setArchiveConfirmOpen(false);
  }, [inspector?.id]);

  // The rail is already closed while it fades out under HyperSight, so the
  // hand-off keeps it on screen for exactly as long as that fade lasts.
  if (!railOpen && !props.leaving) return null;

  const headerTitle = resource?.title ?? (inspector ? 'Details' : railTitle[railVariant]);

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
          {inspector && (
            <IconButton
              label={versionsOpen ? 'Back to document' : 'Back to context'}
              onClick={() => {
                if (versionsOpen) setVersionsOpen(false);
                else inspect(null);
              }}
            >
              <ArrowLeft size={15} />
            </IconButton>
          )}
          <h2 title={headerTitle}>{headerTitle}</h2>
        </div>
        <div className="rail-header-actions window-no-drag">
          {resource && (
            <>
              <IconButton
                aria-pressed={versionsOpen}
                label="Versions"
                onClick={() => setVersionsOpen((open) => !open)}
              >
                <History size={15} />
              </IconButton>
              <IconButton label="Archive" onClick={() => setArchiveConfirmOpen(true)}>
                <Archive size={15} />
              </IconButton>
            </>
          )}
          <IconButton label="Close inspector" onClick={closeRail}><X size={15} /></IconButton>
        </div>
      </header>
      <div className="rail-scroll">
        {props.error && <div className="rail-inline-error"><InlineError>{props.error}</InlineError></div>}
        {inspector ? (
          <InspectorDetail
            {...(props.loadResourceContent ? { loadResourceContent: props.loadResourceContent } : {})}
            onOpenResourceVersion={props.onOpenResourceVersion}
            onRefreshResource={props.onRefreshResource}
            refreshingResourceId={props.refreshingResourceId}
            resourceVersions={props.resourceVersions}
            resourceVersionsError={props.resourceVersionsError}
            versionsOpen={versionsOpen}
            workstream={props.workstream}
          />
        ) : railVariant === 'context' ? (
          <ContextContent {...props} />
        ) : (
          <RunsContent onOpenRun={props.onOpenRun} runs={runs} />
        )}
      </div>
      {resource && (
        <Modal
          footer={(
            <>
              <Button onClick={() => setArchiveConfirmOpen(false)}>Cancel</Button>
              <Button
                className="button-danger"
                onClick={() => {
                  props.onDetachResource?.(resource);
                  setArchiveConfirmOpen(false);
                  inspect(null);
                }}
              >
                Continue
              </Button>
            </>
          )}
          onOpenChange={setArchiveConfirmOpen}
          open={archiveConfirmOpen}
          title="Archive this resource?"
        >
          <p className="modal-copy">
            <strong>{resource.title}</strong> will leave this work stream. Rally has no way to
            bring it back yet.
          </p>
        </Modal>
      )}
    </RailSurface>
  );
}
