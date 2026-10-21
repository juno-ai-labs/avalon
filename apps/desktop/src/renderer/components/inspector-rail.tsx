import { useAnnotationDraft } from './artifact-annotations';
import { AnnotationSurface } from './annotation-surface';
import { openLink } from '../lib/browser-rail-links';
import { desktopBridge } from '../lib/platform';
import { downloadPreview } from './attachment-lightbox';
import { SidekickSection, type SidekickRow, type SidekickSectionFailure } from './sidekick-section';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { IconArchive, IconArrowLeft, IconChevronRight, IconChevronsRight, IconDownload, IconExternalLink, IconEye, IconFileText, IconHistory, IconLink, IconLoader2, IconPencil, IconPin, IconDots, IconPlus, IconRefresh, IconUserPlus, IconWindowMaximize, IconX } from '@tabler/icons-react';
import { ActionTile, ActionTiles, LevelRow, TitleMenuHeader, TitleMenuItem, TitlePillClose, TitlePillHeader, openLevel, useTitleMenuNav, type TitlePillLevel } from '@rally/ui/components/title-pill';
import { classifyAttachmentKind } from '@rally/contracts';
import { DetailActionMenu, DetailHeaderActionsHost, type DetailHeaderAction } from './detail-header-actions';
import type { IconGroupAction } from '@rally/ui/components/icon-group';
import { useEffect, useRef, useState } from 'react';
import { formatDateTime, formatSparseRelativeDate } from '../lib/format';
import { MAX_RESOURCE_PREVIEW_WAIT_MS, readResourcePreview, readResourcePreviewText } from '../lib/resource-preview';
import { reportTelemetryProductIntent } from '../lib/telemetry';
import type {
  ResourceVersion,
  WorkstreamDetail,
  WorkstreamResource,
} from '../lib/types';
import { type RailInspector, type RailVariant, useUiStore } from '../lib/ui-store';
import { useDebugEnabled } from '../lib/use-debug-enabled';
import { ResourceIcon } from './markdown-citations';
import { CopyButton, CopyStatus, copyStateLabel } from './copy-button';
import { useCopy } from '../lib/use-copy';
import { Avatar, AvatarStack, Badge, Button, EmptyState, IconButton, ErrorNotice, Modal } from './primitives';
import { SiteResourceDetail, type SiteResourceDetailProps } from './site-resource-detail';
import { RailSurface } from './rail-surface';
import { RelativeTime } from './relative-time';

interface InspectorRailProps {
  /**
   * One resource in the conversation's right panel. Its caller owns the panel's
   * open state; this never reads or opens the parked shell rail.
   */
  children?: React.ReactNode;
  panel?: {
    detached?: boolean;
    commentDisabledReason?: string;
    resourceId: string;
    onClose: () => void;
    /** Expand the panel over its conversation, or put it back: the stack's own control. */
    expandAction?: readonly IconGroupAction[] | undefined;
    /** What the panel sits in, as breadcrumbs, while it stands alone. */
    ancestors?: readonly TitlePillLevel[] | undefined;
  };
  failure?: 'watch' | 'detach' | 'refresh' | 'attach';
  /**
   * Reads a resource's readable preview, so the detail can show what the thing
   * actually says. This is the authorized preview route — the same one the
   * attachment preview uses — not the raw object: it is what turns a Word
   * file or a PDF into prose. Absent on a surface that has no API session,
   * where the detail stays the metadata card it has always been.
   */
  loadResourceContent?: (id: string, signal?: AbortSignal) => Promise<Blob>;
  /** Original file bytes for downloads, independent of readable derivatives. */
  loadOriginalResourceContent?: (id: string, signal?: AbortSignal) => Promise<Blob>;
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
   * way. Both pending and empty states retain the shared Sidekicks heading;
   * only actual Sidekicks and a failed-read recovery action add rows beneath it.
   */
  sidekicks?: SidekickRow[] | undefined;
  sidekickFailure?: SidekickSectionFailure | undefined;
  onRefreshSidekicks?: (() => void) | undefined;
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
  resourceVersionsFailed?: boolean | undefined;
  /** Opens a prior version read-only, in the same right panel. */
  onOpenResourceVersion?: (resource: WorkstreamResource, version: ResourceVersion) => void;
  onRefreshResource?: (resource: WorkstreamResource) => void;
  refreshingResourceId?: string | null;
  /** Renames an artifact; absent where the viewer may not. */
  onRenameResource?: ((resource: WorkstreamResource, title: string) => Promise<void>) | undefined;
  /** Copies a link that opens the thread onto this artifact; undefined where none can be minted. */
  resourceLink?: ((resource: WorkstreamResource) => (() => Promise<void>) | undefined) | undefined;
  /** Whether this artifact is pinned, and the switch; undefined where it cannot be pinned. */
  resourcePin?: ((resource: WorkstreamResource) => { on: boolean; onChange: (next: boolean) => void } | undefined) | undefined;
  /**
   * The resource itself, for a host with no conversation to look it up in: a
   * Channel opening an artifact a merge shared with it. `null` once that host
   * knows it cannot be read. Absent, the panel finds it in `workstream`.
   */
  resource?: WorkstreamResource | null | undefined;
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

type InspectorRailFailure = NonNullable<InspectorRailProps['failure']>;

const inspectorRailFailureCopy: Record<InspectorRailFailure, string> = {
  watch: 'The resource watch couldn’t be updated.',
  detach: 'The resource couldn’t be archived.',
  refresh: 'The resource couldn’t be refreshed.',
  attach: 'The resource couldn’t be added.',
};

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
            <IconChevronRight aria-hidden="true" className="resource-row-chevron" size={14} stroke={1.9} />
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
  sidekickFailure,
  onRefreshSidekicks,
  onAddParticipant,
  onAddResource,
  onToggleWatch,
}: Pick<InspectorRailProps,
  | 'workstream'
  | 'sidekicks'
  | 'sidekickFailure'
  | 'onRefreshSidekicks'
  | 'onAddParticipant'
  | 'onAddResource'
  | 'onToggleWatch'
>): React.JSX.Element {
  const debugEnabled = useDebugEnabled();

  if (!workstream) return <EmptyState title="No thread selected" description="Open a thread to inspect its context." />;
  const sources = workstream.resources.filter((resource) => resource.direction === 'source');
  const artifacts = workstream.resources.filter((resource) => resource.direction === 'artifact');

  return (
    <div className="rail-sections">
      <Section
        action={<IconButton label="Add participant" onClick={onAddParticipant}><IconUserPlus size={14} stroke={1.9} /></IconButton>}
        title="Participants"
      >
        {workstream.participants.length === 0 ? (
          <p className="rail-empty-line">No human participants</p>
        ) : (
          <AvatarStack members={workstream.participants} />
        )}
        {workstream.viewers.length > 0 && (
          <div className="viewing-group">
            <div className="viewing-label"><IconEye aria-hidden="true" size={12} stroke={1.9} /> Viewing now</div>
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
        action={<IconButton label="Add resource" onClick={onAddResource}><IconPlus size={14} stroke={1.9} /></IconButton>}
        title="Resources"
      >
        {sources.length === 0 && artifacts.length === 0 ? (
          <p className="rail-empty-line">No resources attached</p>
        ) : (
          <ResourceCards onToggleWatch={onToggleWatch} resources={[...sources, ...artifacts]} />
        )}
      </Section>

      <SidekickSection items={sidekicks} failure={sidekickFailure} onRefresh={onRefreshSidekicks} />

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
                {/* Keyed on the stream: a check earned by one stream's address
                    must not still be showing over the next stream's. */}
                <CopyButton
                  key={workstream.id}
                  label="Copy thread email address"
                  onCopied={() => reportTelemetryProductIntent({
                    kind: 'content_copied', contentType: 'workstream_email', resourceType: 'workstream',
                    resourceId: workstream.id,
                  })}
                  size={12}
                  value={workstream.emailAddress}
                />
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
                <dt>Thread ID</dt>
                <dd className="copy-detail">
                  <span className="mono">{workstream.id}</span>
                  <CopyButton
                    key={workstream.id}
                    label="Copy thread ID"
                    onCopied={() => reportTelemetryProductIntent({
                      kind: 'content_copied', contentType: 'workstream_id', resourceType: 'workstream',
                      resourceId: workstream.id,
                    })}
                    size={12}
                    value={workstream.id}
                  />
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
 * alone is an empty panel.
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

/** Whether the preview route has a representation this artifact surface can render. */
function hasGeneratedArtifactPreview(resource: WorkstreamResource): boolean {
  if (!resource.contentAvailable) return false;
  const kind = classifyAttachmentKind({ fileName: resource.title, mimeType: resource.mimeType });
  return kind !== 'other' && kind !== 'site';
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

  if (state.failed && attachmentKind === 'other') return <AnnotationSurface resourceId={resource.id} version={resource.currentVersion} name={resource.title} mimeType={resource.mimeType} sizeBytes={resource.sizeBytes} />;
  if (state.failed) {
    return <p className="inspector-detail-preview-status">This preview is not available.</p>;
  }
  if (state.src && state.media === 'audio') return <audio aria-label={`Audio: ${resource.title}`} controls src={state.src} />;
  if (state.text === undefined && !state.src) return <p className="inspector-detail-preview-status" role="status">Loading preview…</p>;
  return <article className="inspector-detail-document"><AnnotationSurface resourceId={resource.id} version={resource.currentVersion} name={resource.title} mimeType={resource.mimeType} sizeBytes={resource.sizeBytes} text={state.text} src={state.src} /></article>;

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

type ResourceVersionsProps = {
  resource: WorkstreamResource;
  versions: ResourceVersion[] | undefined;
  failed?: boolean | undefined;
  onOpenResourceVersion?: InspectorRailProps['onOpenResourceVersion'];
  participants: WorkstreamDetail['participants'];
};

/** A resource's versions as menu rows, newest first, grouped by date. */
function ResourceVersionItems({
  resource,
  versions,
  failed,
  onOpenResourceVersion,
  participants,
}: ResourceVersionsProps): React.JSX.Element {
  const currentVersion = versions?.[0]?.version;

  let body: React.ReactNode;
  if (failed) {
    body = <ErrorNotice automatic={false} detailsLabel="History details">Resource history couldn’t be loaded.</ErrorNotice>;
  } else if (versions === undefined) {
    body = (
      <DropdownMenu.Item className="menu-item" disabled>
        <IconLoader2 aria-hidden="true" className="spin" size={14} stroke={1.9} /> Loading versions…
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
              onSelect={() => onOpenResourceVersion?.(resource, version)}
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

  return <>{body}</>;
}

function ResourceVersionsMenu(props: ResourceVersionsProps): React.JSX.Element {
  return (
    <DropdownMenu.Content
      align="end"
      aria-label="Versions"
      className="menu-content inspector-versions-menu"
      sideOffset={8}
    >
      <ResourceVersionItems {...props} />
    </DropdownMenu.Content>
  );
}

const VERSIONS_VIEW = { key: 'versions', label: 'Versions' };
const MORE_VIEW = { key: 'more', label: 'More' };

/**
 * The resource panel's title-pill menu: what the resource is, then what can be
 * done to it, in the same tiles and levels a thread's menu uses.
 */
function ResourcePanelMenu({ detailActions = [], downloading, onDownload, onArchive, onCopyLink, copyLinkLabel = 'Copy link', onOpenSource, onPopOut, onRefresh, onRename, pinned, popOutDisabled, refreshing, resource, versions }: {
  detailActions?: readonly DetailHeaderAction[];
  downloading: boolean;
  onDownload?: (() => void) | undefined;
  onArchive?: (() => void) | undefined;
  onCopyLink?: (() => void) | undefined;
  copyLinkLabel?: string;
  onOpenSource?: (() => void) | undefined;
  onPopOut?: (() => void) | undefined;
  onRefresh?: (() => void) | undefined;
  onRename?: (() => void) | undefined;
  pinned?: { on: boolean; onChange: (next: boolean) => void } | undefined;
  popOutDisabled: boolean;
  refreshing: boolean;
  resource: WorkstreamResource;
  versions: ResourceVersionsProps;
}): React.JSX.Element {
  const nav = useTitleMenuNav();
  if (nav.view?.key === VERSIONS_VIEW.key) return <ResourceVersionItems {...versions} />;
  if (nav.view?.key === MORE_VIEW.key) return <>
    {onArchive && <TitleMenuItem danger icon={<IconArchive aria-hidden="true" size={16} />} onSelect={onArchive}>Archive</TitleMenuItem>}
  </>;
  const copyPublicLink = detailActions.find((action) => action.key === 'copy-link');
  const openBrowser = detailActions.find((action) => action.key === 'open-browser');
  const openingActions = detailActions.filter((action) => action.key === 'new-window');
  return <DetailActionMenu actions={detailActions}>
    <TitleMenuHeader
      eyebrow={resource.direction === 'artifact' ? null : 'Resource'}
      icon={<ResourceIcon resource={resource} />}
      title={resource.title}
    />
    <ActionTiles className="artifact-menu-tiles">
      {onDownload && <ActionTile disabled={downloading} icon={<IconDownload aria-hidden="true" size={20} stroke={1.6} />} label="Download" onSelect={onDownload} />}
      {onRename && <ActionTile icon={<IconPencil aria-hidden="true" size={20} stroke={1.6} />} label="Rename" onSelect={onRename} />}
      {copyPublicLink ? <ActionTile disabled={copyPublicLink.disabled} icon={copyPublicLink.icon} label={copyPublicLink.label} onSelect={copyPublicLink.onSelect} />
        : onCopyLink && <ActionTile icon={<IconLink aria-hidden="true" size={20} stroke={1.6} />} label={copyLinkLabel} onSelect={onCopyLink} />}
      {openBrowser && <ActionTile disabled={openBrowser.disabled} icon={openBrowser.icon} label={openBrowser.label} onSelect={openBrowser.onSelect} />}
      {onArchive && <ActionTile icon={<IconDots aria-hidden="true" size={20} stroke={1.6} />} label="More" onSelect={openLevel(nav, MORE_VIEW)} />}
    </ActionTiles>

    {pinned && <DropdownMenu.CheckboxItem checked={pinned.on} className="menu-item title-menu-switch-row" onCheckedChange={pinned.onChange} onSelect={(event) => event.preventDefault()}>
      <IconPin aria-hidden="true" size={16} stroke={1.8} />
      <span className="title-menu-item-copy">Pinned in my sidebar</span>
      <span aria-hidden="true" className="title-menu-switch" data-checked={pinned.on ? '' : undefined} />
    </DropdownMenu.CheckboxItem>}
    {openingActions.map((action) => <TitleMenuItem disabled={action.disabled} icon={action.icon} key={action.key} onSelect={action.onSelect}>{action.label}</TitleMenuItem>)}
    {onPopOut && <TitleMenuItem disabled={popOutDisabled} icon={<IconWindowMaximize aria-hidden="true" size={16} />} onSelect={onPopOut}>Open in a new window</TitleMenuItem>}
    {onOpenSource && <TitleMenuItem icon={<IconExternalLink aria-hidden="true" size={16} />} onSelect={onOpenSource}>Open source</TitleMenuItem>}
    {onRefresh && <TitleMenuItem disabled={refreshing} icon={<IconRefresh aria-hidden="true" size={16} />} onSelect={onRefresh}>Refresh</TitleMenuItem>}

    <DetailActionMenu actions={detailActions} rowsOnly />
    <LevelRow icon={<IconHistory aria-hidden="true" size={17} stroke={1.7} />} label="Versions" view={VERSIONS_VIEW} />
  </DetailActionMenu>;
}

function InspectorDetail({
  loadResourceContent,
  resource,
  settled,
  onRefreshResource,
  refreshingResourceId,
  siteArtifacts,
  artifactEditable,
}: Pick<
  InspectorRailProps,
  'loadResourceContent' | 'onRefreshResource' | 'refreshingResourceId' | 'siteArtifacts'
> & { resource: WorkstreamResource | undefined; settled: boolean; artifactEditable: boolean }): React.JSX.Element | null {
  if (!resource && !settled) return null;

  if (resource) {
    // A live artifact is a page people open, not a record to describe. Behind
    // the flag, because this is presentation: with it off a site falls back to
    // the ordinary resource card, which still lists it, versions it, and lets
    // it be removed. Nothing that protects the artifact is scoped by this.
    if (siteArtifacts && isSiteResource(resource)) {
      return (
        <SiteResourceDetail
          editable={artifactEditable}
          describeData={siteArtifacts.describeData}
          loadTable={siteArtifacts.loadTable}
          openArtifact={siteArtifacts.openArtifact}
          resourceId={resource.id}
          version={resource.currentVersion}
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
            {resource.canonicalUrl && <Button onClick={() => void openLink(resource.canonicalUrl!)}><IconExternalLink size={14} stroke={1.9} /> Open source</Button>}
            {refreshable && onRefreshResource && (
              <Button
                disabled={refreshingResourceId === resource.id}
                onClick={() => onRefreshResource(resource)}
              >
                <IconRefresh size={14} stroke={1.9} /> Refresh from source
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
  context: 'Thread',
  browser: 'Browser',
};

export function InspectorRail(props: InspectorRailProps): React.JSX.Element | null {
  const railOpen = useUiStore((state) => state.railOpen);
  const railVariant = useUiStore((state) => state.railVariant);
  const railWidth = useUiStore((state) => state.railWidth);
  const storeInspector = useUiStore((state) => state.inspector);
  const storeCloseRail = useUiStore((state) => state.closeRail);
  const setRailWidth = useUiStore((state) => state.setRailWidth);
  const storeInspect = useUiStore((state) => state.inspect);
  const inspector: RailInspector | null = props.panel
    ? { type: 'resource', id: props.panel.resourceId }
    : storeInspector;
  const closeRail = props.panel?.onClose ?? storeCloseRail;
  const inspect = (selection: RailInspector | null): void => {
    if (props.panel) props.panel.onClose();
    else storeInspect(selection);
  };
  const resource = props.resource === undefined ? inspectedResource(inspector, props.workstream) : props.resource ?? undefined;
  // Whether a missing resource is gone, rather than still on its way.
  const settled = props.resource === null || (props.resource === undefined && props.workstream !== undefined);
  const [archiveTarget, setArchiveTarget] = useState<WorkstreamResource | null>(null);
  const [archiving, setArchiving] = useState(false);
  const [archiveFailed, setArchiveFailed] = useState(false);
  const annotationDraft = useAnnotationDraft();
  const [popOutFailed, setPopOutFailed] = useState(false);
  const [poppingOut, setPoppingOut] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [downloadFailed, setDownloadFailed] = useState(false);
  const resourceCopy = resource && props.resourceLink?.(resource);
  const { copy: copyResourceLink, state: copyLinkState } = useCopy({ value: '', copyText: async () => {
    if (!resourceCopy) throw new Error('This artifact has no link');
    await resourceCopy();
  } });
  const [renameTarget, setRenameTarget] = useState<WorkstreamResource | null>(null);
  const [renameTitle, setRenameTitle] = useState('');
  const [renaming, setRenaming] = useState(false);
  const [renameFailed, setRenameFailed] = useState(false);
  const closeInspectorRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setArchiveTarget(null);
    setArchiveFailed(false);
    setArchiving(false);
    setPopOutFailed(false);
    setPoppingOut(false);
    setDownloadFailed(false);
    setRenameTarget(null);
    setRenameFailed(false);
    setRenaming(false);
  }, [inspector?.id]);

  const closeRename = (): void => {
    if (renaming) return;
    setRenameTarget(null);
    setRenameFailed(false);
  };

  const submitRename = async (): Promise<void> => {
    const title = renameTitle.trim();
    if (!renameTarget || !props.onRenameResource || !title || renaming) return;
    if (title === renameTarget.title) { setRenameTarget(null); return; }
    setRenaming(true);
    setRenameFailed(false);
    try {
      await props.onRenameResource(renameTarget, title);
      setRenameTarget(null);
    } catch {
      setRenameFailed(true);
    } finally {
      setRenaming(false);
    }
  };

  const popOutGeneratedArtifact = async (): Promise<void> => {
    if (!resource || resource.direction !== 'artifact' || isSiteResource(resource)
      || !hasGeneratedArtifactPreview(resource) || !props.loadResourceContent || poppingOut) return;
    setPoppingOut(true);
    setPopOutFailed(false);
    try {
      const content = await readResourcePreview(
        props.loadResourceContent,
        resource.id,
        new AbortController().signal,
        MAX_RESOURCE_PREVIEW_WAIT_MS,
      );
      const opened = await desktopBridge().popOutArtifact({
        kind: 'generated',
        editable: Boolean(props.onRenameResource),
        ...(annotationDraft?.scopeKey ? { annotationScope: annotationDraft.scopeKey } : {}),
        sourceMimeType:resource.mimeType ?? 'application/octet-stream',
        resourceId: resource.id,
        version: resource.currentVersion,
        content: new Uint8Array(await content.arrayBuffer()),
        mimeType: content.type || resource.mimeType || 'text/plain',
        title: resource.title,
      });
      if (!opened) throw new Error('The artifact window was blocked.');
    } catch {
      setPopOutFailed(true);
    } finally {
      setPoppingOut(false);
    }
  };

  const downloadResource = async (): Promise<void> => {
    const loadOriginal = props.loadOriginalResourceContent;
    if (!resource?.contentAvailable || !loadOriginal || isSiteResource(resource) || downloading) return;
    setDownloading(true);
    setDownloadFailed(false);
    try {
      await downloadPreview({ name: resource.title, loadContent: () => loadOriginal(resource.id) });
    } catch {
      setDownloadFailed(true);
    } finally {
      setDownloading(false);
    }
  };

  const closeArchive = (): void => {
    if (archiving) return;
    setArchiveTarget(null);
    setArchiveFailed(false);
  };

  const submitArchive = async (): Promise<void> => {
    if (!archiveTarget || !props.onDetachResource) return;
    setArchiving(true);
    setArchiveFailed(false);
    try {
      await props.onDetachResource(archiveTarget);
      setArchiveTarget(null);
      inspect(null);
      closeInspectorRef.current?.focus();
    } catch {
      setArchiveFailed(true);
    } finally {
      setArchiving(false);
    }
  };

  // The actions the open detail declares for this header (a live artifact's).
  //
  // Declared above the early return with the other unconditional hooks: a rail
  // that closes renders fewer hooks than the render before it, and React throws
  // rather than closing. Only the resource panel reaches this component today, so the
  // return is never taken, which is exactly how a hook-order defect waits.
  const [detailActions, setDetailActions] = useState<readonly DetailHeaderAction[]>([]);

  // Keep a closed rail on screen for exactly as long as its fade lasts.
  if (!props.panel && !railOpen && !props.leaving) return null;

  const headerTitle = resource?.title ?? (inspector ? 'Details' : railTitle[railVariant]);

  const refreshable = Boolean(resource && resource.direction === 'source' && resource.refreshSupported && props.onRefreshResource);
  const liveSite = Boolean(resource && isSiteResource(resource) && (props.siteArtifacts || props.panel?.detached));
  const copyLink = resourceCopy;
  const panelHeader = props.panel && (
    <TitlePillHeader
      className="panel-title-header"
      current={{
        key: props.panel.resourceId,
        icon: resource ? <ResourceIcon resource={resource} /> : <IconFileText aria-hidden="true" size={15} stroke={1.9} />,
        title: headerTitle,
        label: `${resource?.direction === 'artifact' ? 'Artifact' : 'Resource'} menu: ${headerTitle}`,
        ...(resource ? { menu: <ResourcePanelMenu
          detailActions={props.panel?.detached ? detailActions.filter((action) => action.key !== 'new-window') : detailActions}
          downloading={downloading}
          {...(resource.contentAvailable && props.loadOriginalResourceContent && !isSiteResource(resource)
            ? { onDownload: () => void downloadResource() } : {})}
          {...(props.onDetachResource ? { onArchive: () => { setArchiveFailed(false); setArchiveTarget(resource); } } : {})}
          {...(resource.canonicalUrl && !liveSite ? { onOpenSource: () => void openLink(resource.canonicalUrl!) } : {})}
          {...(resource.direction === 'artifact' && props.onRenameResource
            ? { onRename: () => { setRenameFailed(false); setRenameTitle(resource.title); setRenameTarget(resource); } } : {})}
          {...(!liveSite && copyLink ? { onCopyLink: () => void copyResourceLink(), copyLinkLabel: copyStateLabel(copyLinkState, 'Copy link') } : {})}
          pinned={props.resourcePin?.(resource)}
          {...(resource.direction === 'artifact' && !isSiteResource(resource) && !props.panel?.detached ? { onPopOut: () => void popOutGeneratedArtifact() } : {})}
          {...(refreshable ? { onRefresh: () => props.onRefreshResource?.(resource) } : {})}
          popOutDisabled={!hasGeneratedArtifactPreview(resource) || !props.loadResourceContent || poppingOut}
          refreshing={props.refreshingResourceId === resource.id}
          resource={resource}
          versions={{
            failed: props.resourceVersionsFailed,
            onOpenResourceVersion: props.onOpenResourceVersion,
            participants: props.workstream?.participants ?? [],
            resource,
            versions: props.resourceVersions,
          }}
        /> } : {}),
      }}
      // The detail's own actions, such as a live artifact's, join Expand in
      // the header's group. Comment mode and Expand stay directly accessible. A live site expands
      // like any other artifact: the panel takes the pane, not a lightbox.
      actions={[...detailActions.filter((action) => !['comment-mode', 'copy-link', 'new-window', 'open-browser', 'stored-data'].includes(action.key)), ...detailActions.filter((action) => action.key === 'comment-mode').map((action) => ({...action,alwaysVisible:true,...(props.panel?.commentDisabledReason ? {disabledReason:props.panel.commentDisabledReason} : {})})), ...(props.panel.expandAction ?? []).map((action) => ({...action,alwaysVisible:true}))]}
      ancestors={props.panel.ancestors ? [...props.panel.ancestors] : []}
      // A live site composites a native view under this header that paints
      // above all renderer DOM, so a label hanging down lands behind the page.
      // Upward does not fit: the header sits at the window's top and Radix
      // flips it back down. Beside the button stays inside the header.
      tooltipSide={liveSite ? 'left' : undefined}
      trailing={<TitlePillClose label="Close panel" onClose={closeRail} tooltipSide={liveSite ? 'left' : undefined} />}
    />
  );

  const content = (
    <>
      {panelHeader || <>
      <header className="rail-header window-drag">
          <div className="rail-title window-no-drag">
            {inspector && !props.panel && (
              <IconButton
                label="Back to context"
                onClick={() => inspect(null)}
              >
                <IconArrowLeft size={15} stroke={1.9} />
              </IconButton>
            )}
            <h2 title={headerTitle}>{headerTitle}</h2>
          </div>
          <div className="rail-header-actions window-no-drag">
            {/*
              The detail's own actions, ahead of the rail's: what this resource
              can do belongs beside the resource, and Close stays at the edge.
  
              Every control in this header opens its tooltip upward. A live
              artifact composites a native view directly under this strip, and
              that view paints above all renderer DOM, so a label hanging
              downward is behind the page with no `z-index` able to reach it.
            */}
            {detailActions.map((action) => (
              <IconButton
                aria-pressed={action.pressed}
                className={action.pressed === undefined ? undefined : 'icon-button-toggle'}
                disabled={action.disabled}
                disabledReason={action.disabledReason}
                key={action.key}
                label={action.label}
                onClick={action.onSelect}
                tooltipSide="top"
              >
                {action.icon}
              </IconButton>
            ))}
            {resource && (
              <>
                {resource.direction === 'artifact' && !isSiteResource(resource) && (
                  <IconButton
                    disabled={!hasGeneratedArtifactPreview(resource) || !props.loadResourceContent || poppingOut}
                    label="Open in a new window"
                    onClick={() => void popOutGeneratedArtifact()}
                    tooltipSide="top"
                  >
                    <IconWindowMaximize size={15} />
                  </IconButton>
                )}
                <DropdownMenu.Root>
                  <DropdownMenu.Trigger asChild>
                    <IconButton label="Versions" tooltipSide="top">
                      <IconHistory size={15} stroke={1.9} />
                    </IconButton>
                  </DropdownMenu.Trigger>
                  <DropdownMenu.Portal>
                    <ResourceVersionsMenu
                      failed={props.resourceVersionsFailed}
                      onOpenResourceVersion={props.onOpenResourceVersion}
                      participants={props.workstream?.participants ?? []}
                      resource={resource}
                      versions={props.resourceVersions}
                    />
                  </DropdownMenu.Portal>
                </DropdownMenu.Root>
                {props.onDetachResource && (
                  <IconButton
                    className="icon-button-danger"
                    label="Archive"
                    tooltipSide="top"
                    onClick={() => {
                      setArchiveFailed(false);
                      setArchiveTarget(resource);
                    }}
                  >
                    <IconArchive size={15} stroke={1.9} />
                  </IconButton>
                )}
              </>
            )}
            <IconButton label={props.panel ? 'Close panel' : 'Close inspector'} onClick={closeRail} ref={closeInspectorRef} tooltipSide="top">{props.panel ? <IconX size={18} stroke={1.9} /> : <IconChevronsRight size={16} stroke={1.9} />}</IconButton>
          </div>
        </header>
      </>}
      <DetailHeaderActionsHost onActions={setDetailActions}>
      <div className="rail-scroll">
        {downloadFailed && <ErrorNotice>
          Download failed. Please try again.
        </ErrorNotice>}
        {popOutFailed && <ErrorNotice>
          The artifact couldn’t be opened in a new window.
        </ErrorNotice>}
        <CopyStatus state={copyLinkState} visible={copyLinkState !== 'failed'} />
        {copyLinkState === 'failed' && <ErrorNotice>The link couldn’t be copied.</ErrorNotice>}
        {props.failure && <ErrorNotice>
          {inspectorRailFailureCopy[props.failure]}
        </ErrorNotice>}
        {inspector ? (
          props.children ?? <InspectorDetail
            artifactEditable={Boolean(props.onRenameResource)}
            {...(props.loadResourceContent ? { loadResourceContent: props.loadResourceContent } : {})}
            onRefreshResource={props.onRefreshResource}
            refreshingResourceId={props.refreshingResourceId}
            resource={resource}
            settled={settled}
            {...(props.siteArtifacts ? { siteArtifacts: props.siteArtifacts } : {})}
          />
        ) : (
          <ContextContent {...props} />
        )}
      </div>
      </DetailHeaderActionsHost>
      <Modal
        description={`${archiveTarget?.title ?? 'This resource'} will leave this thread. Rally has no way to bring it back yet.`}
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
        {archiveFailed ? <ErrorNotice>The resource couldn’t be archived.</ErrorNotice> : null}
      </Modal>
      <Modal
        footer={(
          <>
            <Button disabled={renaming} onClick={closeRename}>Cancel</Button>
            <Button
              className="button-primary"
              disabled={renaming || !renameTitle.trim() || renameTitle.trim() === renameTarget?.title}
              onClick={() => void submitRename()}
            >
              Rename
            </Button>
          </>
        )}
        onOpenChange={(open) => {
          if (!open) closeRename();
        }}
        open={Boolean(renameTarget)}
        title="Rename artifact"
      >
        {renameFailed ? <ErrorNotice>The artifact couldn’t be renamed.</ErrorNotice> : null}
        <form onSubmit={(event) => { event.preventDefault(); void submitRename(); }}>
          <label className="form-field">
            <span>Title</span>
            <input autoFocus disabled={renaming} maxLength={300} onChange={(event) => setRenameTitle(event.target.value)} value={renameTitle} />
          </label>
        </form>
      </Modal>
    </>
  );
  if (props.panel?.detached) return <section className="resource-panel artifact-window-panel">{content}</section>;
  return <RailSurface className={props.panel ? 'inspector-rail resource-panel' : 'inspector-rail'} dropTarget={props.dropTarget} label={props.panel ? `Resource: ${headerTitle}` : inspector ? 'Inspector detail' : railTitle[railVariant]} leaving={props.leaving} onClose={closeRail} onResize={setRailWidth} resizeLabel="Resize inspector" width={railWidth}>{content}</RailSurface>;
}
