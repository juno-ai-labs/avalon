import {
  type CitationScheme,
  type CitationTarget,
  type FootnoteCitation,
  citationScheme,
  parseCitationHref,
} from '@rally/contracts/citations';
import { ExternalLink, File, FileText, Link2 } from 'lucide-react';
import { createContext, useContext } from 'react';

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
 *   name openable content and navigate; `person:` and `connector:` name
 *   identities and never do, in any position. That asymmetry is deliberate and
 *   is the renderer's existing security posture, not a new one.
 * - **A citation adds affordance, never disclosure.** When a target cannot be
 *   resolved — unknown, revoked, or simply not visible to this viewer — what
 *   renders is the label the message text already carried, and nothing else.
 */

/** What the workspace knows about a cited resource: enough to dress a chip. */
export interface CitationResource {
  readonly id: string;
  readonly title: string;
  readonly resourceType: string;
}

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

/** The kind of thing a resource is, at a glance. Shared with the rail's own list. */
export function ResourceIcon({ type }: { type: string }): React.JSX.Element {
  const normalized = type.toLowerCase();
  if (normalized.includes('doc') || normalized.includes('text')) return <FileText size={15} />;
  if (normalized.includes('url') || normalized.includes('web')) return <Link2 size={15} />;
  return <File size={15} />;
}

/** A reference inside a sentence: icon, the model's words, and a click. */
function ResourceChip({ label, resource, onOpen }: {
  label: React.ReactNode;
  resource: CitationResource;
  onOpen: () => void;
}): React.JSX.Element {
  return (
    <button
      aria-label={`Open ${resource.title}`}
      className="citation-chip"
      data-resource-type={resource.resourceType}
      onClick={onOpen}
      type="button"
    >
      <span aria-hidden="true" className="citation-chip-icon"><ResourceIcon type={resource.resourceType} /></span>
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
 */
function ResourceEmbedCard({ label, resource, onOpen }: {
  label: React.ReactNode;
  resource: CitationResource;
  onOpen: () => void;
}): React.JSX.Element {
  return (
    <button
      aria-label={`Open ${resource.title}`}
      className="citation-card"
      data-resource-type={resource.resourceType}
      onClick={onOpen}
      type="button"
    >
      <span aria-hidden="true" className="citation-card-icon"><ResourceIcon type={resource.resourceType} /></span>
      <span className="citation-card-text">
        <strong className="citation-card-title">{label}</strong>
        <small className="citation-card-kind">{resource.resourceType}</small>
      </span>
      <ExternalLink aria-hidden="true" className="citation-card-chevron" size={14} />
    </button>
  );
}

/**
 * A grounding source: a numbered marker after the punctuation, and nothing else.
 *
 * The popover is a sibling rather than the pill's own content so the marker
 * stays one character wide, and it is wired with `aria-describedby` rather than
 * `aria-label` so the number a sighted reader sees and the source a screen
 * reader hears are the same two facts in the same order.
 *
 * A source with nowhere to go renders the same marker without a button. That is
 * the degradation the whole feature leans on: the reader still sees that the
 * claim was sourced, and loses only the click.
 */
function CitationPill({ citation, number, popoverId, onOpen }: {
  citation: FootnoteCitation;
  number: React.ReactNode;
  popoverId: string;
  onOpen?: () => void;
}): React.JSX.Element {
  const opens = citation.target.scheme === 'external' ? 'Opens in your browser' : 'Opens in the rail';
  const popover = (
    <span className="citation-pill-popover" id={popoverId} role="tooltip">
      <span className="citation-pill-source">{citation.label}</span>
      {citation.text && <span className="citation-pill-note">{citation.text}</span>}
      {onOpen && <span className="citation-pill-open">{opens}</span>}
    </span>
  );
  return (
    <span className="citation-pill-wrap">
      {onOpen
        ? (
          <button
            aria-describedby={popoverId}
            aria-label={`Source: ${citation.label}`}
            className="citation-pill"
            onClick={onOpen}
            type="button"
          >{number}</button>
        )
        : <span aria-describedby={popoverId} className="citation-pill">{number}</span>}
      {popover}
    </span>
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
  readonly popoverId: string;
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
    return <ResourceChip label={args.label} onOpen={onOpen} resource={resource} />;
  },
  // Unchanged: a real anchor, whose click the main process intercepts and sends
  // to the system browser through its existing allowlist.
  external: (args) => <a {...args.anchor} rel="noopener noreferrer" target="_blank">{args.label}</a>,
  person: (args) => args.identity(),
  connector: (args) => args.identity(),
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
    return <ResourceEmbedCard label={args.label} onOpen={onOpen} resource={resource} />;
  },
  // Deliberately *not* a citation. The renderer's CSP permits external images
  // and markdown images render today, so this syntax is live and means what it
  // means everywhere; hijacking it would collide with the model legitimately
  // embedding an image.
  external: (args) => <img {...args.image} />,
  person: (args) => <IdentityCard label={args.label} />,
  connector: (args) => <IdentityCard label={args.label} />,
  unknown: (args) => <>{args.label}</>,
};

const FOOTNOTE_CELLS: Matrix<FootnoteArgs> = {
  resource: (args) => (
    <CitationPill
      citation={args.citation}
      number={args.number}
      onOpen={resolved(args) ? opener(args.render, args.target) : undefined}
      popoverId={args.popoverId}
    />
  ),
  external: (args) => (
    <CitationPill
      citation={args.citation}
      number={args.number}
      onOpen={opener(args.render, args.target)}
      popoverId={args.popoverId}
    />
  ),
  person: (args) => <CitationPill citation={args.citation} number={args.number} popoverId={args.popoverId} />,
  connector: (args) => <CitationPill citation={args.citation} number={args.number} popoverId={args.popoverId} />,
  // Unreachable through the pinned grammar, which refuses a definition whose one
  // link names no known scheme. Defined anyway, because "cannot happen" is not a
  // thing the type system can check and a superscript is the honest fallback.
  unknown: (args) => <sup>{args.number}</sup>,
};

/** `#<prefix>fn-<identifier>` — the target GFM gives a footnote reference. */
function footnoteIdentifier(href: string | undefined, prefix: string): string | undefined {
  const marker = `#${prefix}fn-`;
  return href?.startsWith(marker) ? href.slice(marker.length) : undefined;
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
    const identifier = footnoteIdentifier(href, render.prefix);
    const citation = identifier === undefined ? undefined : render.footnotes.get(identifier);
    if (citation) {
      const cell = FOOTNOTE_CELLS[citation.target.scheme];
      return (
        <>{cell({
          citation,
          label: children,
          number: children,
          popoverId: `${render.prefix}cite-${identifier}`,
          render,
          target: citation.target,
        })}</>
      );
    }
    // A definition that did not qualify keeps classic GFM rendering, and its
    // reference keeps pointing at the entry that is still in the trailing list.
    return <a {...anchor} href={href}>{children}</a>;
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
 */
export function CitationFootnoteSection({ children, section }: {
  children: React.ReactNode;
  section: React.ComponentPropsWithoutRef<'section'>;
}): React.JSX.Element | null {
  const render = useCitationRender();
  const lifted = [...render.numbers.keys()].filter((identifier) => render.footnotes.has(identifier));
  if (lifted.length === render.numbers.size) return null;
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
  const marker = `${render.prefix}fn-`;
  const identifier = item.id?.startsWith(marker) ? item.id.slice(marker.length) : undefined;
  if (identifier === undefined) return <li {...item}>{children}</li>;
  if (render.footnotes.has(identifier)) return null;
  return <li {...item} value={render.numbers.get(identifier)}>{children}</li>;
}
