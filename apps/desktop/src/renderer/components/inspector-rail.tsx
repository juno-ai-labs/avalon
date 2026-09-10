import { SidekickSection, type SidekickRow } from './sidekick-section';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import * as Dialog from '@radix-ui/react-dialog';
import {
  Archive,
  ArrowLeft,
  Check,
  ChevronRight,
  ChevronsRight,
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
import { DetailHeaderActionsHost } from './detail-header-actions';
import { useEffect, useRef, useState, type RefObject } from 'react';
import { formatDateTime, formatSparseRelativeDate } from '../lib/format';
import { MAX_RESOURCE_PREVIEW_WAIT_MS, readResourcePreviewText } from '../lib/resource-preview';
import { desktopBridge } from '../lib/platform';
import { reportTelemetryProductIntent } from '../lib/telemetry';
import type {
  ResourceVersion,
  WorkstreamDetail,
  WorkstreamResource,
} from '../lib/types';
import { type RailInspector, type RailVariant, useUiStore } from '../lib/ui-store';
import { useDebugEnabled } from '../lib/use-debug-enabled';
import { ResourceIcon } from './markdown-citations';
import { Avatar, AvatarStack, Badge, Button, EmptyState, IconButton, InlineError, Modal } from './primitives';
import { SiteResourceDetail, type SiteResourceDetailProps } from './site-resource-detail';
import { MarkdownBody } from './workstream-blocks';
import { RailSurface } from './rail-surface';
import { RelativeTime } from './relative-time';

interface InspectorRailProps {
  /** Explicit modal host; never reads or opens the parked shell rail. */
  lightbox?: {
    resourceId: string;
    returnFocus: HTMLElement;
    onClose: () => void;
  };
  error?: string;
  /**
   * Reads a resource's readable preview, so the detail can show what the thing
   * actually says. This is the authorized preview route — the same one the
   * attachment lightbox uses — not the raw object: it is what turns a Word
   * file or a PDF into prose. Absent on a surface that has no API session,
   * where the detail stays the metadata card it has always been.
   */
  loadResourceContent?: (id: string, signal?: AbortSignal) => Promise<Blob>;
  /**
   * Everything the live-artifact detail needs, or absent.
   *
   * Absent is how the feature is off: a surface with no API session cannot mint
   * access, and the `live-artifacts-enabled` flag decides whether the caller
   * passes this at all. A site then falls back to the ordinary resource card,
   * which is a working outcome rather than a hidden one.
   */
  siteArtifacts?: {
    openArtifact: SiteResourceDetailProps['openArtifact'];
    describeData: SiteResourceDetailProps['describeData'];
    loadTable: SiteResourceDetailProps['loadTable'];
    surface: SiteResourceDetailProps['surface'];
  };
  workstream?: WorkstreamDetail;
  /**
   * This work stream's Sidekicks, or `undefined` while the answer is on its
   * way. Neither state leaves a heading behind: a room with none simply has no
   * such section, as it has no artifact section until it has produced one.
   */
  sidekicks?: SidekickRow[] | undefined;
  sidekicksError?: string | undefined;
  onAddParticipant?: () => void;
  onAddResource?: () => void;
  onDetachResource?: (resource: WorkstreamResource) => void | Promise<void>;
  onToggleWatch?: (resource: WorkstreamResource, enabled: boolean) => void;
  /**
   * History for whichever resource the detail is showing, newest first.
   * `undefined` is still loading; `[]` is genuinely none. Do not coerce a
   * pending fetch to `[]`, or opening Versions says there is no history.
   */
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
  /** True while the inspector is fading out. */
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

/** The resources attached to this conversation, sources before artifacts. */
function ResourceCards({
  resources,
  onToggleWatch,
  onSelect,
}: {
  resources: WorkstreamResource[];
  onToggleWatch?: (resource: WorkstreamResource, enabled: boolean) => void;
  onSelect?: (resourceId: string) => void;
}): React.JSX.Element {
  const inspect = useUiStore((state) => state.inspect);
  return (
    <ul className="rail-card-list">
      {resources.map((resource) => {
        const watch = watchLabel(resource);
        return (
          <li className="rail-card resource-row" key={resource.id}>
            <button className="rail-card-main" onClick={() => onSelect ? onSelect(resource.id) : inspect({ type: 'resource', id: resource.id })} type="button">
              <span className="rail-card-icon"><ResourceIcon resource={resource} /></span>
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
  sidekicks,
  sidekicksError,
  onAddParticipant,
  onAddResource,
  onToggleWatch,
}: Pick<InspectorRailProps,
  | 'workstream'
  | 'sidekicks'
  | 'sidekicksError'
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
        title="Participants"
      >
        {workstream.participants.length === 0 ? (
          <p className="rail-empty-line">No human participants</p>
        ) : (
          <AvatarStack members={workstream.participants} />
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
        {sources.length === 0 && artifacts.length === 0 ? (
          <p className="rail-empty-line">No resources attached</p>
        ) : (
          <ResourceCards onToggleWatch={onToggleWatch} resources={[...sources, ...artifacts]} />
        )}
      </Section>

      <SidekickSection items={sidekicks} error={sidekicksError} />

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
          <div><dt>Last activity</dt><dd><RelativeTime value={workstream.lastActivityAt} /></dd></div>
          {/* Everything past this point describes how the work stream is wired
              rather than what it is, so it belongs to Application → Developer →
              Debug enabled. */}
          {debugEnabled && (
            <>
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
 * not prose. It still belongs in this host — as an `img` sized to the rail —
 * because the detail *is* the document now, and leaving it on last-updated
 * alone is an empty panel. The lightbox remains the full-size reader.
 */
function readableAsText(resource: WorkstreamResource): boolean {
  if (!resource.contentAvailable) return false;
  const kind = classifyAttachmentKind({ fileName: resource.title, mimeType: resource.mimeType });
  // A site has no single body to read — its stored content is a manifest, not a
  // page — so the text preview would render the index rather than the site.
  // Its own detail renders the page itself instead.
  return kind !== 'image' && kind !== 'site';
}

/** Whether this resource is a live artifact Rally serves rather than a file. */
function isSiteResource(resource: WorkstreamResource): boolean {
  return classifyAttachmentKind({ fileName: resource.title, mimeType: resource.mimeType }) === 'site';
}

function isImageResource(resource: WorkstreamResource): boolean {
  if (!resource.contentAvailable) return false;
  return classifyAttachmentKind({ fileName: resource.title, mimeType: resource.mimeType }) === 'image';
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
  const [state, setState] = useState<{ text?: string; src?: string; media?: 'audio' | 'image'; failed?: boolean }>({});
  const attachmentKind = classifyAttachmentKind({ fileName: resource.title, mimeType: resource.mimeType });
  const media = resource.contentAvailable && (attachmentKind === 'image' || attachmentKind === 'audio')
    ? attachmentKind
    : null;

  useEffect(() => {
    const controller = new AbortController();
    let objectUrl: string | undefined;
    setState({});
    const load = media
      ? Promise.resolve(loadResourceContent(resource.id, controller.signal)).then((blob) => {
          const url = URL.createObjectURL(blob);
          if (controller.signal.aborted) {
            URL.revokeObjectURL(url);
            return;
          }
          objectUrl = url;
          setState({ src: url, media });
        })
      : readResourcePreviewText(loadResourceContent, resource.id, controller.signal, MAX_RESOURCE_PREVIEW_WAIT_MS)
        .then((text) => {
          if (!controller.signal.aborted) setState({ text });
        });
    void load.catch(() => {
      // A resource whose content was never hydrated, whose object has since
      // gone, or whose format the server will not convert is not an error the
      // reader can act on — last-updated above is still true, and saying so
      // beats an empty panel. A preview still being prepared is not one of
      // these, and no longer arrives here until the retries are spent.
      if (!controller.signal.aborted) setState({ failed: true });
    });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
    // `currentVersion` as well as the id: a watched source re-ingested in place
    // keeps its id, and last-updated above this body shows the new revision.
    // Without it the panel put a new timestamp over version 2's text, which is
    // a citation substantiating a claim with the wrong revision.
  }, [loadResourceContent, media, resource.currentVersion, resource.id]);

  if (state.failed) {
    return <p className="inspector-detail-preview-status">This preview is not available.</p>;
  }
  if (state.src) {
    return (
      <article className="inspector-detail-document">
        {state.media === 'audio'
          ? <audio aria-label={`Audio: ${resource.title}`} className="inspector-detail-audio" controls src={state.src} />
          : <img alt={resource.title} className="inspector-detail-image" src={state.src} />}
      </article>
    );
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
  return kind === 'audio' || kind === 'image' || kind === 'markdown' || kind === 'text';
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

function ResourceVersionsMenu({
  resource,
  versions,
  error,
  onOpenResourceVersion,
  participants,
  returnFocus,
}: {
  resource: WorkstreamResource;
  versions: ResourceVersion[] | undefined;
  error?: string | undefined;
  onOpenResourceVersion?: InspectorRailProps['onOpenResourceVersion'];
  participants: WorkstreamDetail['participants'];
  returnFocus: RefObject<HTMLButtonElement | null>;
}): React.JSX.Element {
  const currentVersion = versions?.[0]?.version;

  let body: React.ReactNode;
  if (error) {
    body = <DropdownMenu.Item className="menu-item" disabled>{error}</DropdownMenu.Item>;
  } else if (versions === undefined) {
    body = (
      <DropdownMenu.Item className="menu-item" disabled>
        <LoaderCircle aria-hidden="true" className="spin" size={14} /> Loading versions…
      </DropdownMenu.Item>
    );
  } else if (versions.length === 0) {
    body = <DropdownMenu.Item className="menu-item" disabled>No versions yet.</DropdownMenu.Item>;
  } else {
    body = groupVersionsBySparseDate(versions).map((group) => (
      <DropdownMenu.Group key={`${group.label}-${group.versions[0]?.version}`}>
        <DropdownMenu.Label className="menu-label inspector-version-group-label">
          <time dateTime={group.versions[0]?.capturedAt}>{group.label}</time>
        </DropdownMenu.Label>
        {group.versions.map((version) => {
          const isCurrent = version.version === currentVersion;
          return (
            <DropdownMenu.Item
              className="menu-item inspector-version-item"
              disabled={isCurrent || !versionIsOpenable(version)}
              key={version.version}
              onSelect={() => {
                const trigger = returnFocus.current;
                if (trigger) onOpenResourceVersion?.(resource, version, trigger);
              }}
            >
              <span className="inspector-version-label">V{version.version}</span>
              <span className="inspector-version-author">{versionAuthorLabel(version, resource, participants)}</span>
              {/* Newest-first and authoritative about itself. The detail's
                  version number comes from another cache, and the two
                  disagree exactly while a swap is settling — which is when
                  putting "Current" on a superseded row does most harm. */}
              {isCurrent ? <Badge>Current</Badge> : null}
            </DropdownMenu.Item>
          );
        })}
      </DropdownMenu.Group>
    ));
  }

  return (
    <DropdownMenu.Content
      align="end"
      aria-label="Versions"
      className="menu-content inspector-versions-menu"
      sideOffset={8}
    >
      {body}
    </DropdownMenu.Content>
  );
}

function InspectorDetail({
  inspector,
  loadResourceContent,
  workstream,
  onRefreshResource,
  refreshingResourceId,
  siteArtifacts,
}: Pick<
  InspectorRailProps,
  'loadResourceContent' | 'workstream' | 'onRefreshResource' | 'refreshingResourceId'
  | 'siteArtifacts'
> & { inspector: RailInspector | null }): React.JSX.Element | null {
  if (!inspector || !workstream) return null;
  const resource = inspector.type === 'resource' ? workstream.resources.find((item) => item.id === inspector.id) : undefined;

  if (resource) {
    // A live artifact is a page people open, not a record to describe. Behind
    // the flag, because this is presentation: with it off a site falls back to
    // the ordinary resource card, which still lists it, versions it, and lets
    // it be removed. Nothing that protects the artifact is scoped by this.
    if (siteArtifacts && isSiteResource(resource)) {
      return (
        <SiteResourceDetail
          describeData={siteArtifacts.describeData}
          loadTable={siteArtifacts.loadTable}
          openArtifact={siteArtifacts.openArtifact}
          resourceId={resource.id}
          surface={siteArtifacts.surface}
          title={resource.title}
        />
      );
    }
    // Direction says whether this work stream consumed or produced the
    // resource; the server-computed adapter capability says whether its
    // connector can actually fulfill a re-fetch.
    const refreshable = resource.direction === 'source' && resource.refreshSupported;
    const sourceActions = Boolean(resource.canonicalUrl || (refreshable && onRefreshResource));
    const showDocument = Boolean(
      loadResourceContent && (readableAsText(resource) || isImageResource(resource)),
    );
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
        {showDocument && resource.updatedAt && <hr className="inspector-detail-rule" />}
        {showDocument && loadResourceContent && (
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
};

export function InspectorRail(props: InspectorRailProps): React.JSX.Element | null {
  const railOpen = useUiStore((state) => state.railOpen);
  const railVariant = useUiStore((state) => state.railVariant);
  const railWidth = useUiStore((state) => state.railWidth);
  const storeInspector = useUiStore((state) => state.inspector);
  const storeCloseRail = useUiStore((state) => state.closeRail);
  const setRailWidth = useUiStore((state) => state.setRailWidth);
  const storeInspect = useUiStore((state) => state.inspect);
  const inspector: RailInspector | null = props.lightbox
    ? (props.lightbox.resourceId ? { type: 'resource', id: props.lightbox.resourceId } : null)
    : storeInspector;
  const closeRail = props.lightbox?.onClose ?? storeCloseRail;
  const inspect = (selection: RailInspector | null): void => {
    if (props.lightbox) props.lightbox.onClose();
    else storeInspect(selection);
  };
  const resource = inspectedResource(inspector, props.workstream);
  const [archiveTarget, setArchiveTarget] = useState<WorkstreamResource | null>(null);
  const [archiving, setArchiving] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const versionsTriggerRef = useRef<HTMLButtonElement>(null);
  const closeInspectorRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setArchiveTarget(null);
    setArchiveError(null);
    setArchiving(false);
  }, [inspector?.id]);

  const closeArchive = (): void => {
    if (archiving) return;
    setArchiveTarget(null);
    setArchiveError(null);
  };

  const submitArchive = async (): Promise<void> => {
    if (!archiveTarget || !props.onDetachResource) return;
    setArchiving(true);
    setArchiveError(null);
    try {
      await props.onDetachResource(archiveTarget);
      setArchiveTarget(null);
      inspect(null);
      closeInspectorRef.current?.focus();
    } catch (error) {
      setArchiveError(error instanceof Error ? error.message : 'The resource could not be archived.');
    } finally {
      setArchiving(false);
    }
  };

  // Keep a closed rail on screen for exactly as long as its fade lasts.
  if (!props.lightbox && !railOpen && !props.leaving) return null;

  const headerTitle = resource?.title ?? (inspector ? 'Details' : props.lightbox ? 'Resources' : railTitle[railVariant]);
  // State rather than a ref, because a detail's actions are portalled into this
  // element and a ref's assignment does not re-render the detail that is
  // waiting for it: with a ref the slot stays empty until something else
  // happens to re-render.
  const [detailActionsTarget, setDetailActionsTarget] = useState<HTMLDivElement | null>(null);

  const content = (
    <>
      <header className="rail-header window-drag">
        <div className="rail-title window-no-drag">
          {inspector && !props.lightbox && (
            <IconButton
              label="Back to context"
              onClick={() => inspect(null)}
            >
              <ArrowLeft size={15} />
            </IconButton>
          )}
          <h2 title={headerTitle}>{headerTitle}</h2>
        </div>
        <div className="rail-header-actions window-no-drag">
          {/*
            The detail's own actions, ahead of the rail's: what this resource
            can do belongs beside the resource, and Close stays at the edge.
          */}
          <div className="rail-header-detail-actions" ref={setDetailActionsTarget} />
          {resource && (
            <>
              <DropdownMenu.Root>
                <DropdownMenu.Trigger asChild>
                  <IconButton label="Versions" ref={versionsTriggerRef}>
                    <History size={15} />
                  </IconButton>
                </DropdownMenu.Trigger>
                <DropdownMenu.Portal>
                  <ResourceVersionsMenu
                    error={props.resourceVersionsError}
                    onOpenResourceVersion={props.onOpenResourceVersion}
                    participants={props.workstream?.participants ?? []}
                    resource={resource}
                    returnFocus={versionsTriggerRef}
                    versions={props.resourceVersions}
                  />
                </DropdownMenu.Portal>
              </DropdownMenu.Root>
              {props.onDetachResource && (
                <IconButton
                  className="icon-button-danger"
                  label="Archive"
                  onClick={() => {
                    setArchiveError(null);
                    setArchiveTarget(resource);
                  }}
                >
                  <Archive size={15} />
                </IconButton>
              )}
            </>
          )}
          <IconButton label={props.lightbox ? 'Close resource preview' : 'Close inspector'} onClick={closeRail} ref={closeInspectorRef}>{props.lightbox ? <X size={20} /> : <ChevronsRight size={16} />}</IconButton>
        </div>
      </header>
      <DetailHeaderActionsHost target={detailActionsTarget}>
      <div className="rail-scroll">
        {props.error && <div className="rail-inline-error"><InlineError>{props.error}</InlineError></div>}
        {inspector ? (
          <InspectorDetail
            inspector={inspector}
            {...(props.loadResourceContent ? { loadResourceContent: props.loadResourceContent } : {})}
            onRefreshResource={props.onRefreshResource}
            refreshingResourceId={props.refreshingResourceId}
            {...(props.siteArtifacts ? { siteArtifacts: props.siteArtifacts } : {})}
            workstream={props.workstream}
          />
        ) : (
          <ContextContent {...props} />
        )}
      </div>
      </DetailHeaderActionsHost>
      <Modal
        description={`${archiveTarget?.title ?? 'This resource'} will leave this work stream. Rally has no way to bring it back yet.`}
        footer={(
          <>
            <Button disabled={archiving} onClick={closeArchive}>Cancel</Button>
            <Button
              className="button-danger"
              disabled={archiving}
              onClick={() => void submitArchive()}
            >
              Continue
            </Button>
          </>
        )}
        onOpenChange={(open) => {
          if (!open) closeArchive();
        }}
        open={Boolean(archiveTarget)}
        title="Archive this resource?"
      >
        {archiveError ? <InlineError>{archiveError}</InlineError> : null}
      </Modal>
    </>
  );
  if (props.lightbox) {
    const lightbox = props.lightbox;
    return (
      <Dialog.Root open onOpenChange={(open) => { if (!open) lightbox.onClose(); }}>
        <Dialog.Portal>
          <Dialog.Overlay className="attachment-lightbox-overlay" />
          <Dialog.Content aria-describedby={undefined} className="attachment-lightbox is-document-viewer resource-lightbox" onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (lightbox.returnFocus.isConnected) lightbox.returnFocus.focus();
          }}>
            <Dialog.Title className="attachment-lightbox-a11y-title">{headerTitle}</Dialog.Title>
            {content}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    );
  }
  return <RailSurface className="inspector-rail" dropTarget={props.dropTarget} label={inspector ? 'Inspector detail' : railTitle[railVariant]} leaving={props.leaving} onClose={closeRail} onResize={setRailWidth} resizeLabel="Resize inspector" scrimLabel="Close inspector" width={railWidth}>{content}</RailSurface>;
}
