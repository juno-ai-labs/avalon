import { type AttachmentKind, classifyAttachmentKind } from '@rally/contracts';
import { type CitationScheme, type CitationTarget, type FootnoteCitation, citationScheme, isConnectorHref, isSidekickHref, parseCitationHref } from '@rally/contracts/citations';
import * as Tooltip from '@radix-ui/react-tooltip';
import { IconPin } from '@tabler/icons-react';

import { createContext, useContext, useEffect, useMemo, useState } from 'react';

import { httpHostname, useHostFavicon } from '../lib/host-favicon';

import { AttachmentMediaTile } from './attachments';
import { type ResourceAction, ResourceActionMenu, ResourceMoreMenu } from './resource-action-menu';
import { isVideoAttachment } from '../lib/attachment-media';

/**
 * Citations, as the desktop draws them.
 *
 * The protocol itself is in `@rally/contracts/citations`, shared with the two
 * delivery surfaces that have to rewrite it. This module is the rendering half:
 * the matrix that says what every scheme looks like in every position, and the
 * three presentations behind it — an inline chip, a block embed card, and a
 * footnote pill.
 *
 * The matrix is a table rather than an if-chain on purpose. Its type is
 * `Record<CitationScheme, …>` for each of the three positions, so a scheme added
 * to the protocol is a type error in three places until somebody has decided
 * what it looks like as a link, as an embed, and as a source. The alternative —
 * a chain of `if (scheme === …)` with a trailing `else` — makes every
 * undecided cell silently fall through to whatever the last branch happened to
 * be, which is how a `resource://` target ends up in the DOM as an `href`.
 *
 * Two rules run through every cell:
 *
 * - **Navigation is a property of the protocol.** `resource://` and `http(s)`
 *   name openable content and navigate; `person:` / `person://` names an
 *   identity and never does, in any position. Connector mention chips
 *   (`connector://`) share that non-navigating identity path but are not a
 *   citation scheme — they are handled before the matrix, as is a Sidekick
 *   mention (`sidekick://`). That asymmetry is
 *   deliberate and is the renderer's existing security posture, not a new one.
 * - **A citation adds affordance, never disclosure.** When a target cannot be
 *   resolved — unknown, revoked, or simply not visible to this viewer — what
 *   renders is the label the message text already carried, and nothing else.
 */

/** What the workspace knows about a cited resource: enough to dress a chip. */
export interface CitationResource {
  readonly id: string;
  readonly title: string;
  readonly resourceType: string;
  /** Present when the record knows a MIME type; the kind label classifies from it. */
  readonly mimeType?: string;
}

export type CitationPreview =
  | { readonly kind: 'image'; readonly blob: Blob }
  | { readonly kind: 'text'; readonly text: string };

export interface CitationContext {
  /**
   * The cited resource under the viewer's own authorization, or `undefined`
   * when it cannot be resolved — which is also the answer for a resource the
   * viewer may not see. The two are deliberately indistinguishable here: a
   * citation must not become a way to learn that something exists.
   */
  resolve: (resourceId: string) => CitationResource | undefined;
  /** Where an opened citation goes. The host owns the route; this owns the click. */
  open: (target: CitationTarget) => void;
  /** Open a block resource embed in the host's preview surface. */
  openPreview?: (resourceId: string, returnFocus: HTMLElement, gallery?: readonly string[], selectedIndex?: number) => void;
  /** Authorized binary preview loader, used only after an audio Play action. */
  loadContent?: (resourceId: string, signal?: AbortSignal) => Promise<Blob>;
  /**
   * The resource content for the embed card's preview, or `undefined` for a
   * resource this context cannot resolve. Image bytes become the feed preview;
   * other resource kinds stay compact file rows and do not fetch a derivative
   * merely to decorate the transcript. Optional because a surface with no work
   * stream behind it has no route to read.
   */
  preview?: (resourceId: string) => Promise<CitationPreview> | undefined;
  /**
   * What the right-click menu on a resolved resource offers. The host owns the
   * list, so a surface with nothing to offer omits it and keeps no menu.
   */
  actions?: (resourceId: string) => readonly ResourceAction[] | undefined;
  /** Whether this person pinned the resource, which its card says beside its kind. */
  pinned?: (resourceId: string) => boolean;
}

/**
 * The citation context, passed through React context rather than as a prop.
 *
 * `MarkdownBody` memoises its component overrides on their dependencies, and the
 * streaming path memoises each settled segment on that object's identity — so a
 * citation context reaching the components as a prop would put a host-owned
 * object in the dependency list and turn every commit back into a whole-body
 * re-parse, which is the trap `NO_MENTIONS` exists for. Context updates
 * propagate through `memo`, so the pills still see a definition that arrives
 * mid-stream while the settled segments around them stay untouched.
 */
const CitationsContext = createContext<CitationRender | null>(null);

export interface CitationRender {
  readonly citations?: CitationContext;
  /** Qualifying footnote definitions, by lowercased identifier. */
  readonly footnotes: ReadonlyMap<string, FootnoteCitation>;
  /** This mount's id prefix, so two messages' footnote anchors cannot collide. */
  readonly prefix: string;
  /** The number GFM gives each defined footnote, by lowercased identifier. */
  readonly numbers: ReadonlyMap<string, number>;
  /**
   * This render will be looked at, not used — the saved card, today.
   *
   * Lifting a definition into its pill trades the trailing list for a popover,
   * which is the right trade in a transcript and the wrong one in a picture: a
   * still has no hover, and the export stylesheet hides the popover for the
   * same reason. So a still keeps the pills *and* keeps the list, and the
   * sources survive into the file somebody saves. Without this the card showed
   * bare numbers over nothing, which is worse than either form on its own.
   */
  readonly still?: boolean;
}

export const CitationsProvider = CitationsContext.Provider;

function useCitationRender(): CitationRender {
  return useContext(CitationsContext) ?? EMPTY_RENDER;
}

const EMPTY_RENDER: CitationRender = {
  footnotes: new Map(),
  numbers: new Map(),
  prefix: '',
};

/**
 * A resource kind as a person would read it.
 *
 * `resourceType` is a free-form system identifier — the values in the tree are
 * `github_pull_request`, `gmail_thread`, `linear_project_update`. A CSS
 * `capitalize` on that prints `Github_pull_request`; the underscores have to go
 * before the words do.
 *
 * Provenance types (`generated_file`, `uploaded_file`) are not kinds a person
 * can tell apart: every published file is one. Those classify from MIME and
 * filename into the attachment kinds, and a slide deck reads as "Deck" rather
 * than "Presentation" because that is the word the rest of the product uses.
 */
const FILE_KIND_LABELS: Record<AttachmentKind, string> = {
  image: 'Image',
  audio: 'Audio',
  markdown: 'Markdown',
  pdf: 'PDF',
  document: 'Document',
  spreadsheet: 'Spreadsheet',
  presentation: 'Deck',
  text: 'Text',
  // A page people open, not a file they download — so the chip says what it
  // is rather than what it is made of.
  site: 'Site',
  other: 'File',
};

import { FILE_PROVENANCE_TYPES } from '@rally/ui/components/resource-icon';

export function resourceKindLabel(resource: ResourceKindInput): string {
  const type = resource.resourceType;
  if (FILE_PROVENANCE_TYPES.has(type)) {
    return FILE_KIND_LABELS[classifyAttachmentKind({ mimeType: resource.mimeType, fileName: resource.title })];
  }
  if (isAttachmentKind(type)) return FILE_KIND_LABELS[type];
  const words = type.replace(/[_-]+/gu, ' ').trim();
  return words ? `${words[0]!.toUpperCase()}${words.slice(1)}` : type;
}

function isAttachmentKind(value: string): value is AttachmentKind {
  return Object.hasOwn(FILE_KIND_LABELS, value);
}

/**
 * What the icon and the kind label classify from: everything either one reads,
 * and nothing a caller has to look up. Both `CitationResource` and the rails'
 * `WorkstreamResource` satisfy it.
 */
export type ResourceKindInput = Pick<CitationResource, 'mimeType' | 'resourceType' | 'title'>;

export { resourceIconType, ResourceIcon } from '@rally/ui/components/resource-icon';
import { ResourceIcon, resourceIconType } from '@rally/ui/components/resource-icon';

/** The host's actions for a resource, or none on a still, which nobody can click. */
function useResourceActions(resourceId: string): readonly ResourceAction[] | undefined {
  const { citations, still } = useCitationRender();
  return still ? undefined : citations?.actions?.(resourceId);
}

/** Whether the host says this person pinned the resource; never on a still. */
function useResourcePinned(resourceId: string): boolean {
  const { citations, still } = useCitationRender();
  return !still && citations?.pinned?.(resourceId) === true;
}

/** A reference inside a sentence: icon, the model's words, and a click. */
function ResourceChip({ label, resource, onOpen }: {
  label: React.ReactNode;
  resource: CitationResource;
  onOpen: React.MouseEventHandler<HTMLButtonElement>;
}): React.JSX.Element {
  const actions = useResourceActions(resource.id);
  return (
    <ResourceActionMenu actions={actions}>
      <button
        aria-label={`Open ${resource.title}`}
        className="citation-chip"
        data-resource-type={resource.resourceType}
        onClick={onOpen}
        type="button"
      >
        <span aria-hidden="true" className="citation-chip-icon"><ResourceIcon resource={resource} /></span>
        <span className="citation-chip-label">{label}</span>
      </button>
    </ResourceActionMenu>
  );
}

/**
 * The announcement form: a card on its own line.
 *
 * It is reached through image syntax, and that is the whole placement mechanism.
 * Models put image syntax on its own line by training, the way they treat actual
 * images, so the card lands between sentences rather than cutting one into three
 * — no renderer heuristic has to guess where a block belongs.
 *
 * Images use the feed's intrinsic media treatment. Everything else is the same
 * compact icon, filename, and kind row used for attached files; a generated site
 * or audio file must not fall back to a tall card with an empty middle.
 */
export function ResourceEmbedCard({ label, resource, onOpen, onPreview, preview, grouped = false, still = false }: {
  label: React.ReactNode;
  resource: CitationResource;
  onOpen: () => void;
  onPreview?: (returnFocus: HTMLElement) => void;
  preview?: ((resourceId: string) => Promise<CitationPreview> | undefined) | undefined;
  grouped?: boolean;
  still?: boolean;
}): React.JSX.Element {
  const kind = resourceIconType(resource);
  const isImage = kind === 'image' && !still;
  const actions = useResourceActions(resource.id);
  const pinned = useResourcePinned(resource.id);
  const [excerpt, setExcerpt] = useState<{ for: string; src?: string; open?: boolean }>({ for: '' });
  useEffect(() => {
    const request = isImage ? preview?.(resource.id) : undefined;
    if (!request) {
      setExcerpt({ for: resource.id });
      return;
    }
    let cancelled = false;
    let objectUrl: string | undefined;
    // Announced unconditionally, including for a read the host has already
    // cached. React processes this update and the settled promise's own in one
    // commit, so a warm card re-running this effect — a refetch of the resource
    // list changes the callback's identity, and every mounted card asks again —
    // never paints the skeleton over an excerpt it already had. Review raised
    // that flash; a MutationObserver across every commit shows no skeleton node
    // is created at all, so guarding it here would be a fix for nothing.
    setExcerpt({ for: resource.id, open: true });
    request
      .then((result) => {
        if (cancelled) return;
        if (result.kind === 'image') {
          objectUrl = URL.createObjectURL(result.blob);
          setExcerpt({ for: resource.id, src: objectUrl });
          return;
        }
        setExcerpt({ for: resource.id });
      })
      .catch(() => {
        // Every rejection — unavailable, unconvertible, retries spent — means
        // the same thing here: the card keeps its empty room, exactly as it
        // stands on a surface that offers no preview at all.
        if (!cancelled) setExcerpt({ for: resource.id });
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [isImage, preview, resource.id]);
  // A commit can hand this mounted card a different resource before the effect
  // re-runs; matching on the id keeps the old resource's text off the new one.
  const settled = excerpt.for === resource.id ? excerpt : { for: resource.id };
  return (
    <ResourceMoreMenu actions={actions} label={resource.title} placement={isImage ? 'corner' : 'row'}>
      <ResourceActionMenu actions={actions}>
        <button
          aria-label={pinned ? `Open ${resource.title}, pinned` : `Open ${resource.title}`}
          className={`citation-card ${isImage ? 'is-image' : 'is-file'}`}
          data-resource-type={resource.resourceType}
          onClick={(event) => onPreview ? onPreview(event.currentTarget) : onOpen()}
          style={isImage ? {
            aspectRatio: '1',
            width: grouped ? '100%' : 'var(--attachment-media-size)',
          } : undefined}
          type="button"
        >
          {isImage && settled.open && <span aria-hidden="true" className="citation-card-preview-skeleton" />}
          {isImage && settled.src && (
            <img
              alt=""
              aria-hidden="true"
              className="citation-card-image-preview"
              loading="lazy"
              onError={() => {
                // MIME metadata can be stale and valid image bytes can still be
                // corrupt. A decode failure returns to the ordinary empty card
                // instead of leaving Chromium's broken-image rendering behind.
                setExcerpt((current) => current.for === resource.id && current.src === settled.src
                  ? { for: resource.id }
                  : current);
              }}
              src={settled.src}
            />
          )}
          {isImage && pinned && <span aria-hidden="true" className="resource-card-pin"><IconPin size={14} stroke={2} /></span>}
          {!isImage && (
            <>
              <span aria-hidden="true" className="citation-card-badge"><ResourceIcon resource={resource} /></span>
              <span className="citation-card-text">
                <strong className="citation-card-title">{label}</strong>
                <small className="citation-card-kind">
                  {pinned && <><span className="resource-card-pinned"><IconPin aria-hidden="true" size={12} stroke={1.8} />Pinned</span>{' · '}</>}
                  {resourceKindLabel(resource)}
                </small>
              </span>
            </>
          )}
        </button>
      </ResourceActionMenu>
    </ResourceMoreMenu>
  );
}

/** A parsed run uses the same gallery layout as sent attachments. Resolution
 * is checked again here because context may change without a markdown reparse. */
export function CitationEmbedRow({ node, children }: { node: EmbedRowNode; children: React.ReactNode }): React.JSX.Element {
  const { citations, still } = useCitationRender();
  const entries = (node.children ?? []).flatMap((child, index) => {
    const target = parseCitationHref(String(child.properties?.src ?? ''));
    if (target.scheme !== 'resource') return [];
    const resource = citations?.resolve(target.resourceId);
    return resource ? [{ resource, label: String(child.properties?.alt ?? resource.title), key: `${resource.id}:${index}` }] : [];
  });
  if (!citations || still || entries.length !== node.children?.length) return <div className="citation-card-row">{children}</div>;
  const images = entries.filter(({ resource }) => resourceIconType(resource) === 'image');
  const gallery = images.map(({ resource }) => resource.id);
  const card = (entry: typeof entries[number], grouped = false, imageIndex?: number): React.JSX.Element => (
    <ResourceEmbedCard key={entry.key} label={entry.label} resource={entry.resource} preview={citations.preview}
      grouped={grouped}
      onOpen={() => citations.open({ scheme: 'resource', resourceId: entry.resource.id })}
      onPreview={citations.openPreview ? (focus) => citations.openPreview!(entry.resource.id, focus, gallery, imageIndex) : undefined}
    />
  );
  return (
    <div className="citation-card-row">
      {entries.map((entry) => resourceIconType(entry.resource) === 'image'
        ? <span className="message-attachment-image-cell" key={entry.key}>{card(entry, true, images.indexOf(entry))}</span>
        : <CitationFileEmbed key={entry.key} resource={entry.resource}>{card(entry)}</CitationFileEmbed>)}
    </div>
  );
}

function CitationFileEmbed({ resource, children }: { resource: CitationResource; children: React.ReactNode }): React.JSX.Element {
  const { citations, still } = useCitationRender();
  const loader = citations?.loadContent;
  const loadContent = useMemo(() => loader ? (signal?: AbortSignal) => loader(resource.id, signal) : undefined, [loader, resource.id]);
  const actions = useResourceActions(resource.id);
  if (!still && (resourceIconType(resource) === 'audio' || isVideoAttachment(resource.mimeType ?? '', resource.title))) {
    return <ResourceMoreMenu actions={actions} label={resource.title} placement="corner"><ResourceActionMenu actions={actions}><span style={{ display: 'contents' }}><AttachmentMediaTile name={resource.title} mimeType={resource.mimeType} loadContent={loadContent}
      onOpen={(focus) => citations?.openPreview ? citations.openPreview(resource.id, focus) : citations?.open({ scheme: 'resource', resourceId: resource.id })} /></span></ResourceActionMenu></ResourceMoreMenu>;
  }
  return <span className="citation-file-attachment">{children}</span>;
}

/**
 * The slice of a hast node the embed-row pass reads and rewrites. Structural
 * rather than imported: the renderer depends on `hast` only transitively
 * through react-markdown, and four optional fields are the whole contract.
 */
export interface EmbedRowNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: EmbedRowNode[];
}

function isWhitespaceNode(node: EmbedRowNode): boolean {
  return node.type === 'text' && typeof node.value === 'string' && node.value.trim() === '';
}

/**
 * The resource images of a paragraph that holds nothing else, or `null` for
 * any other node. Only the `resource:` scheme counts, and only a target this
 * render will actually draw as a card: an identity card or a real image beside
 * an embed keeps its paragraph exactly as written.
 */
function embedImages(node: EmbedRowNode, rendersCard: (resourceId: string) => boolean): EmbedRowNode[] | null {
  if (node.type !== 'element' || node.tagName !== 'p' || !node.children) return null;
  const images: EmbedRowNode[] = [];
  for (const child of node.children) {
    if (isWhitespaceNode(child)) continue;
    const src = child.type === 'element' && child.tagName === 'img' ? String(child.properties?.src ?? '') : undefined;
    // One condition, not two: the parse already says whether this is a
    // resource target, and a second scheme test beside it would be a guard no
    // break could reach — which is to say a guard no test could cover.
    if (src !== undefined) {
      const target = parseCitationHref(src);
      if (target.scheme === 'resource' && rendersCard(target.resourceId)) {
        images.push(child);
        continue;
      }
    }
    return null;
  }
  return images.length > 0 ? images : null;
}

/**
 * Consecutive embeds share one row.
 *
 * The announcement form arrives one card per paragraph — models write each
 * image on a line of its own — so a run of them renders as a column of tiles
 * between two sentences. This pass merges adjacent embed-only paragraphs (and
 * several embeds inside one paragraph) into a single `.citation-card-row`,
 * which CitationEmbedRow presents as a proportional image gallery followed by
 * compact file cards. A lone
 * embed keeps its paragraph:
 * the row exists for runs, and rewriting the common case would change the DOM
 * every existing surface asserts on.
 *
 * It runs on hast, after the markdown has been parsed and before the citation
 * matrix renders anything — so it is told, through `rendersCard`, which targets
 * that matrix will actually draw as a card. **It groups nothing else**, and the
 * distinction is not academic: a `resource://` image on a surface with no
 * citation context, or one naming a resource this work stream does not carry,
 * renders as the label text the message already had. Grouping those would take
 * a run of ordinary sentences and lay them out as a row of flex items — which
 * is exactly what happened on the five surfaces that render
 * `MarkdownBody` without citations, until review caught it.
 *
 * Intra-run whitespace text nodes are dropped rather than carried into the row:
 * the row is a flex container whose `gap` owns the spacing, and a stray newline
 * between two flex items renders as nothing anyway.
 */
export function rehypeCitationEmbedRows(rendersCard: (resourceId: string) => boolean) {
  return function attacher(): (tree: unknown) => void {
    return (tree) => {
      const root = tree as EmbedRowNode;
      if (!root.children) return;
      const source = root.children;
      const rebuilt: EmbedRowNode[] = [];
      let index = 0;
      while (index < source.length) {
        const first = embedImages(source[index]!, rendersCard);
        if (!first) {
          rebuilt.push(source[index]!);
          index += 1;
          continue;
        }
        const run = [...first];
        let end = index + 1;
        let cursor = end;
        while (cursor < source.length) {
          if (isWhitespaceNode(source[cursor]!)) {
            cursor += 1;
            continue;
          }
          const more = embedImages(source[cursor]!, rendersCard);
          if (!more) break;
          run.push(...more);
          cursor += 1;
          end = cursor;
        }
        if (run.length < 2) {
          rebuilt.push(source[index]!);
          index += 1;
          continue;
        }
        rebuilt.push({
          type: 'element',
          tagName: 'div',
          properties: { className: ['citation-card-row'] },
          children: run,
        });
        index = end;
      }
      root.children = rebuilt;
    };
  };
}

/**
 * A grounding source: an asterisk after the punctuation with a source popover.
 * Accessible labels retain source numbers to distinguish adjacent citations.
 * A saved still keeps numbers so markers identify its printed source list.
 *
 * The popover rides the app's own tooltip rather than a hand-positioned box.
 * That is not a preference: the transcript is a scroll container, and an
 * absolutely-positioned popover inside one is *clipped* by it — a pill on the
 * top visible line lost its popover entirely, and a pill near the right edge
 * had the source's title sheared off mid-word. Radix portals the content out
 * and handles the collision, and it brings the rest of the interaction the
 * hand-rolled version was missing: a dismiss on Escape, the same open delay
 * every other hover surface in Rally uses, and a description a screen reader
 * actually announces.
 *
 * A source with nowhere to go is still a pill and still carries its popover —
 * it just does not navigate. The reader loses the click, not the source's name,
 * which is the whole point of showing a marker at all.
 */
function CitationPill({ citation, number, onOpen }: {
  citation: FootnoteCitation;
  number: React.ReactNode;
  onOpen?: () => void;
}): React.JSX.Element {
  const { still } = useCitationRender();
  const external = citation.target.scheme === 'external' ? citation.target.url : undefined;
  const favicon = useHostFavicon(still ? undefined : external);
  // The icon says which site at a glance; the host says it in words, for the
  // reader whose glance did not land — an unfamiliar mark, a monochrome one
  // against this appearance, or a marker reached by keyboard rather than by
  // eye. It rides the line that was already there rather than adding one.
  const host = external === undefined ? null : httpHostname(external);
  const opens = external === undefined
    ? 'Opens in preview'
    : host === null ? 'Opens in your browser' : `${host} · Opens in your browser`;
  const label = typeof number === 'string' || typeof number === 'number'
    ? `Source ${String(number)}: ${citation.label}`
    : `Source: ${citation.label}`;
  return (
    <Tooltip.Provider>
      <Tooltip.Root delayDuration={450}>
        <Tooltip.Trigger asChild>
          <button
            aria-label={label}
            className={favicon.source ? 'citation-pill citation-pill-favicon' : 'citation-pill'}
            onClick={onOpen}
            type="button"
          >{favicon.source
            ? <img alt="" aria-hidden="true" onError={favicon.onError} src={favicon.source} />
            : still ? number : '*'}</button>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content className="tooltip citation-pill-popover" collisionPadding={12} side="top" sideOffset={6}>
            <span className="citation-pill-source">{citation.label}</span>
            {citation.text && <span className="citation-pill-note">{citation.text}</span>}
            {onOpen && <span className="citation-pill-open">{opens}</span>}
            <Tooltip.Arrow className="tooltip-arrow" />
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}

/** An identity in the embed position: named, drawn, and going nowhere. */
function IdentityCard({ label }: { label: React.ReactNode }): React.JSX.Element {
  return (
    <span className="citation-identity-card">
      <span className="citation-identity-label">{label}</span>
    </span>
  );
}

/** Everything a cell is handed, whatever position it sits in. */
interface CellArgs {
  /** The strict parse. A resource cell can be handed an unknown target — see `citationScheme`. */
  readonly target: CitationTarget;
  /** The model's own words: a link's text, an image's alt. */
  readonly label: React.ReactNode;
  readonly render: CitationRender;
}

interface LinkArgs extends CellArgs {
  /** The anchor react-markdown built, for the cells that keep it. */
  readonly anchor: React.ComponentPropsWithoutRef<'a'>;
  /** How this render draws an identity — the host's business, not the protocol's. */
  readonly identity: () => React.ReactNode;
}

interface ImageArgs extends CellArgs {
  readonly image: React.ComponentPropsWithoutRef<'img'>;
}

interface FootnoteArgs extends CellArgs {
  readonly citation: FootnoteCitation;
  readonly number: React.ReactNode;
}

type Matrix<Args> = Readonly<Record<CitationScheme, (args: Args) => React.ReactNode>>;

/** Resolves a cited resource, or `undefined` — the one place that decision is made. */
function resolved(args: CellArgs): CitationResource | undefined {
  if (args.target.scheme !== 'resource') return undefined;
  return args.render.citations?.resolve(args.target.resourceId);
}

function opener(render: CitationRender, target: CitationTarget): (() => void) | undefined {
  const open = render.citations?.open;
  return open ? () => open(target) : undefined;
}

const LINK_CELLS: Matrix<LinkArgs> = {
  resource: (args) => {
    const resource = resolved(args);
    const onOpen = opener(args.render, args.target);
    if (!resource || !onOpen) return <>{args.label}</>;
    return <ResourceChip label={args.label} onOpen={(event) => {
      if (args.render.citations?.openPreview) {
        args.render.citations.openPreview(resource.id, event.currentTarget);
      } else onOpen();
    }} resource={resource} />;
  },
  // A real anchor. On a Channel its click opens in the rail browser
  // (`captureLinkClicks`); elsewhere the main process sends it to the system
  // browser through its existing allowlist.
  external: (args) => <a {...args.anchor} rel="noopener noreferrer" target="_blank">{args.label}</a>,
  person: (args) => args.identity(),
  // Not "render as text": this is where `mailto:`, `tel:` and every relative
  // target keep exactly the behavior they have today, including the dead anchor
  // the default transform leaves behind for a scheme it rejects.
  unknown: (args) => <a {...args.anchor} rel="noopener noreferrer" target="_blank">{args.label}</a>,
};

const IMAGE_CELLS: Matrix<ImageArgs> = {
  resource: (args) => {
    const resource = resolved(args);
    const onOpen = opener(args.render, args.target);
    if (!resource || !onOpen) return <>{args.label}</>;
    // A still keeps the empty room: the saved card is serialized at one
    // moment, and a skeleton or a half-loaded excerpt caught in that moment
    // would be printed into the picture forever.
    const preview = args.render.still ? undefined : args.render.citations?.preview;
    const openPreview = args.render.still ? undefined : args.render.citations?.openPreview;
    const card = (
      <ResourceEmbedCard
        still={args.render.still}
        label={args.label}
        onOpen={onOpen}
        onPreview={openPreview ? (returnFocus) => openPreview(resource.id, returnFocus) : undefined}
        preview={preview}
        resource={resource}
      />
    );
    return resourceIconType(resource) === 'audio' || isVideoAttachment(resource.mimeType ?? '', resource.title) ? <CitationFileEmbed resource={resource}>{card}</CitationFileEmbed> : card;
  },
  // Deliberately *not* a citation. The renderer's CSP permits external images
  // and markdown images render today, so this syntax is live and means what it
  // means everywhere; hijacking it would collide with the model legitimately
  // embedding an image.
  external: (args) => <img {...args.image} />,
  person: (args) => <IdentityCard label={args.label} />,
  unknown: (args) => <>{args.label}</>,
};

const FOOTNOTE_CELLS: Matrix<FootnoteArgs> = {
  resource: (args) => (
    <CitationPill
      citation={args.citation}
      number={args.number}
      onOpen={resolved(args) ? opener(args.render, args.target) : undefined}
    />
  ),
  external: (args) => (
    <CitationPill
      citation={args.citation}
      number={args.number}
      onOpen={opener(args.render, args.target)}
    />
  ),
  person: (args) => <CitationPill citation={args.citation} number={args.number} />,
  // Unreachable through the pinned grammar, which refuses a definition whose one
  // link names no known scheme. Defined anyway, because "cannot happen" is not a
  // thing the type system can check and a superscript is the honest fallback.
  unknown: (args) => <sup>{args.number}</sup>,
};

/**
 * The identifier behind `<prefix>fn-<id>`, keyed the way this module keys one.
 *
 * GFM does not write the identifier into the DOM verbatim: it writes
 * `normalizeUri(id.toLowerCase())`, which percent-encodes anything a URI cannot
 * carry — every non-ASCII character, and `%`, `` ` ``, `"`, `<`, `>`, `\`, `{`,
 * `}`, `|`, `^`. The grammar keys by the plain text, so without undoing the
 * escape here the two agree only for as long as every identifier a model writes
 * happens to be ASCII. `[^café]` and `[^100%]` are not, and both are ordinary
 * output: the guidance teaches numeric identifiers without constraining them.
 *
 * The cost of the disagreement was not a missing pill. The reference fell
 * through to a classic anchor while the section guard — reading the *unencoded*
 * keys, which did match each other — dropped the whole footnote section, so the
 * source left the message entirely.
 */
function footnoteIdentifier(value: string | undefined, marker: string): string | undefined {
  if (value === undefined || !value.startsWith(marker)) return undefined;
  const encoded = value.slice(marker.length);
  try {
    return decodeURIComponent(encoded).toLowerCase();
  } catch {
    // A model writes footnote identifiers, so a malformed escape is reachable
    // input: it is simply not an identifier this message defines.
    return encoded.toLowerCase();
  }
}

/**
 * A link, once the matrix has decided what it is.
 *
 * Footnote references arrive here too — GFM renders one as an anchor carrying
 * `data-footnote-ref` — and they are checked first, because their `href` is a
 * fragment that would otherwise fall through to the unknown cell as an
 * ordinary, and permanently dead, in-page anchor.
 */
export function CitationLink({ anchor, children, footnoteRef, href, identity }: {
  anchor: React.ComponentPropsWithoutRef<'a'>;
  children: React.ReactNode;
  footnoteRef: boolean;
  href: string | undefined;
  identity: () => React.ReactNode;
}): React.JSX.Element {
  const render = useCitationRender();
  if (footnoteRef) {
    const identifier = footnoteIdentifier(href, `#${render.prefix}fn-`);
    const citation = identifier === undefined ? undefined : render.footnotes.get(identifier);
    if (citation) {
      const cell = FOOTNOTE_CELLS[citation.target.scheme];
      return (
        <>{cell({
          citation,
          label: children,
          number: children,
          render,
          target: citation.target,
        })}</>
      );
    }
    // A definition that did not qualify keeps classic GFM rendering, and its
    // reference keeps pointing at the entry that is still in the trailing list.
    return <a {...anchor} href={href}>{children}</a>;
  }
  // Connector chips are minted at render time and are not a citation scheme;
  // a `sidekick://` mention names an identity, not openable content. Route both
  // through the host's identity path before the matrix, or they would land in
  // `unknown` as a navigable (or emptied) anchor.
  if (isConnectorHref(href) || isSidekickHref(href)) {
    return <>{identity()}</>;
  }
  const cell = LINK_CELLS[citationScheme(href)];
  return <>{cell({ anchor, identity, label: children, render, target: parseCitationHref(href) })}</>;
}

/** An image, once the matrix has decided whether it is one. */
export function CitationImage({ alt, image, src }: {
  alt: string | undefined;
  image: React.ComponentPropsWithoutRef<'img'>;
  src: string | undefined;
}): React.JSX.Element {
  const render = useCitationRender();
  const cell = IMAGE_CELLS[citationScheme(src)];
  return <>{cell({ image, label: alt ?? '', render, target: parseCitationHref(src) })}</>;
}

/**
 * The trailing footnote section, holding only what the grammar did not lift.
 *
 * In the common case — a grounded answer whose every footnote is a citation —
 * that is nothing, and the message spends no vertical space on a source footer
 * at all. That reclaimed space is the point of the feature.
 *
 * A still keeps everything. The lift is only a trade — the list for the pill's
 * popover — and a picture cannot open a popover, so on that surface the trade
 * has nothing on the other side of it and the sources would simply be gone.
 */
export function CitationFootnoteSection({ children, section }: {
  children: React.ReactNode;
  section: React.ComponentPropsWithoutRef<'section'>;
}): React.JSX.Element | null {
  const render = useCitationRender();
  if (render.still) return <section {...section}>{children}</section>;
  const lifted = [...render.numbers.keys()].filter((identifier) => render.footnotes.has(identifier));
  // `numbers.size > 0` is the fail-safe half, and it is about the future rather
  // than about any footnote today: an empty map means this module recognised
  // nothing in a section GFM did build, and without the guard that equality
  // holds vacuously and deletes it. Every other divergence between this grammar
  // and remark-gfm degrades toward showing too much; this one degraded toward
  // showing nothing, which is the one direction a source must never go.
  if (render.numbers.size > 0 && lifted.length === render.numbers.size) return null;
  return <section {...section}>{children}</section>;
}

/**
 * One entry of that section — dropped when its reference became a pill.
 *
 * The entries that survive carry an explicit `value`, because the numbering an
 * `<ol>` produces counts the items it still has while a footnote's number is
 * fixed by the order it was first referenced. Without it, the second footnote
 * in a message whose first was lifted would read as "1." under a superscript
 * that says 2.
 */
export function CitationFootnoteItem({ children, item }: {
  children: React.ReactNode;
  item: React.ComponentPropsWithoutRef<'li'>;
}): React.JSX.Element | null {
  const render = useCitationRender();
  const identifier = footnoteIdentifier(item.id, `${render.prefix}fn-`);
  if (identifier === undefined) return <li {...item}>{children}</li>;
  if (render.footnotes.has(identifier) && !render.still) return null;
  return <li {...item} value={render.numbers.get(identifier)}>{children}</li>;
}
