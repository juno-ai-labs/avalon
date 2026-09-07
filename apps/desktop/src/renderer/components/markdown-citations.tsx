import {
  type AttachmentKind,
  classifyAttachmentKind,
} from '@rally/contracts';
import {
  type CitationScheme,
  type CitationTarget,
  type FootnoteCitation,
  citationScheme,
  isConnectorHref,
  parseCitationHref,
} from '@rally/contracts/citations';
import * as Tooltip from '@radix-ui/react-tooltip';
import { File, FileText, Image as ImageIcon, Link2, Volume2 } from 'lucide-react';
import { createContext, useContext, useEffect, useState } from 'react';

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
 *   citation scheme — they are handled before the matrix. That asymmetry is
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
  openPreview?: (resourceId: string, returnFocus: HTMLElement) => void;
  /**
   * The resource content for the embed card's preview, or `undefined` for a
   * resource this context cannot resolve. Image bytes become the feed preview;
   * other resource kinds stay compact file rows and do not fetch a derivative
   * merely to decorate the transcript. Optional because a surface with no work
   * stream behind it has no route to read.
   */
  preview?: (resourceId: string) => Promise<CitationPreview> | undefined;
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

const FILE_PROVENANCE_TYPES = new Set(['generated_file', 'uploaded_file']);

export function resourceKindLabel(resource: Pick<CitationResource, 'resourceType' | 'title' | 'mimeType'>): string {
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

function resourceIconType(resource: CitationResource): string {
  if (FILE_PROVENANCE_TYPES.has(resource.resourceType)) {
    return classifyAttachmentKind({ mimeType: resource.mimeType, fileName: resource.title });
  }
  return resource.resourceType;
}

/** The kind of thing a resource is, at a glance. Shared with the rail's own list. */
export function ResourceIcon({ type }: { type: string }): React.JSX.Element {
  const normalized = type.toLowerCase();
  if (normalized.includes('audio')) return <Volume2 size={15} />;
  if (normalized.includes('image')) return <ImageIcon size={15} />;
  if (normalized.includes('doc') || normalized.includes('text')) return <FileText size={15} />;
  if (normalized.includes('url') || normalized.includes('web')) return <Link2 size={15} />;
  return <File size={15} />;
}

/** A reference inside a sentence: icon, the model's words, and a click. */
function ResourceChip({ label, resource, onOpen }: {
  label: React.ReactNode;
  resource: CitationResource;
  onOpen: React.MouseEventHandler<HTMLButtonElement>;
}): React.JSX.Element {
  return (
    <button
      aria-label={`Open ${resource.title}`}
      className="citation-chip"
      data-resource-type={resource.resourceType}
      onClick={onOpen}
      type="button"
    >
      <span aria-hidden="true" className="citation-chip-icon"><ResourceIcon type={resourceIconType(resource)} /></span>
      <span className="citation-chip-label">{label}</span>
    </button>
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
export function ResourceEmbedCard({ label, resource, onOpen, onPreview, preview }: {
  label: React.ReactNode;
  resource: CitationResource;
  onOpen: () => void;
  onPreview?: (returnFocus: HTMLElement) => void;
  preview?: ((resourceId: string) => Promise<CitationPreview> | undefined) | undefined;
}): React.JSX.Element {
  const kind = resourceIconType(resource);
  const isImage = kind === 'image';
  const [excerpt, setExcerpt] = useState<{ for: string; src?: string; aspectRatio?: number; open?: boolean }>({ for: '' });
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
          setExcerpt({ for: resource.id, src: objectUrl, aspectRatio: 4 / 3 });
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
    <button
      aria-label={`Open ${resource.title}`}
      className={`citation-card ${isImage ? 'is-image' : 'is-file'}`}
      data-resource-type={resource.resourceType}
      onClick={(event) => onPreview ? onPreview(event.currentTarget) : onOpen()}
      style={isImage ? {
        aspectRatio: String(settled.aspectRatio ?? 4 / 3),
        width: Math.min(560, Math.max(64, (settled.aspectRatio ?? 4 / 3) * 200)),
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
          onLoad={(event) => {
            const { naturalHeight, naturalWidth } = event.currentTarget;
            if (naturalHeight <= 0 || naturalWidth <= 0) return;
            setExcerpt((current) => current.for === resource.id && current.src === settled.src
              ? { ...current, aspectRatio: naturalWidth / naturalHeight }
              : current);
          }}
          src={settled.src}
        />
      )}
      {!isImage && (
        <>
          <span aria-hidden="true" className="citation-card-badge"><ResourceIcon type={kind} /></span>
          <span className="citation-card-text">
            <strong className="citation-card-title">{label}</strong>
            <small className="citation-card-kind">{resourceKindLabel(resource)}</small>
          </span>
        </>
      )}
    </button>
  );
}

/**
 * The slice of a hast node the embed-row pass reads and rewrites. Structural
 * rather than imported: the renderer depends on `hast` only transitively
 * through react-markdown, and four optional fields are the whole contract.
 */
interface EmbedRowNode {
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
 * which the stylesheet lets scroll sideways. A lone embed keeps its paragraph:
 * the row exists for runs, and rewriting the common case would change the DOM
 * every existing surface asserts on.
 *
 * It runs on hast, after the markdown has been parsed and before the citation
 * matrix renders anything — so it is told, through `rendersCard`, which targets
 * that matrix will actually draw as a card. **It groups nothing else**, and the
 * distinction is not academic: a `resource://` image on a surface with no
 * citation context, or one naming a resource this work stream does not carry,
 * renders as the label text the message already had. Grouping those would take
 * a run of ordinary sentences and lay them out side by side in a horizontal
 * scroller — which is exactly what happened on the five surfaces that render
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
 * A grounding source: a numbered marker after the punctuation, and nothing else.
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
  const opens = citation.target.scheme === 'external' ? 'Opens in your browser' : 'Opens in preview';
  const label = typeof number === 'string' || typeof number === 'number'
    ? `Source ${String(number)}: ${citation.label}`
    : `Source: ${citation.label}`;
  return (
    <Tooltip.Provider>
      <Tooltip.Root delayDuration={450}>
        <Tooltip.Trigger asChild>
          <button
            aria-label={label}
            className="citation-pill"
            onClick={onOpen}
            type="button"
          >{number}</button>
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
  // Unchanged: a real anchor, whose click the main process intercepts and sends
  // to the system browser through its existing allowlist.
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
    return (
      <ResourceEmbedCard
        label={args.label}
        onOpen={onOpen}
        onPreview={openPreview ? (returnFocus) => openPreview(resource.id, returnFocus) : undefined}
        preview={preview}
        resource={resource}
      />
    );
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
  // Connector chips are minted at render time and are not a citation scheme.
  // Route them through the host's identity path before the matrix, or they
  // would land in `unknown` as a navigable (or emptied) anchor.
  if (isConnectorHref(href)) {
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
