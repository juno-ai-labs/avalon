import {
  type CitationPosition,
  type CitationTarget,
  collectFootnoteCitations,
  type FootnoteCitation,
  footnoteReferenceOrder,
  parseCitationTarget,
} from '@rally/contracts/citations';
import * as Tooltip from '@radix-ui/react-tooltip';
import { File, FileText, Link2 } from 'lucide-react';
import { createContext, useContext, useEffect } from 'react';
import { desktopBridge } from '../lib/platform';
import { useUiStore } from '../lib/ui-store';

/**
 * How a citation in a model's Markdown becomes something to click.
 *
 * The protocol is [`@rally/contracts/citations`](../../../../../packages/contracts/src/citations.ts);
 * this is the desktop's half of it. Everything here is reached from
 * `MarkdownBody`'s component overrides, which is what keeps the single-renderer
 * invariant intact — nothing in this file mounts `react-markdown`, it only
 * supplies the components that one mount dispatches to.
 *
 * The dispatch is a **registry keyed by (position, scheme)**, not an if-chain.
 * `Record<CitationPosition, Record<CitationScheme, …>>` makes the compiler
 * demand a renderer for every cell, so adding a scheme is adding components it
 * asks for rather than leaving a cell to fall through to whatever the last
 * branch happened to be. The matrix, in full:
 *
 * | Scheme | link `[..](..)` | image `![..](..)` | footnote definition |
 * | --- | --- | --- | --- |
 * | `resource://` | inline chip | embed card | pill popover → rail |
 * | `https`/`http` | external link | **a real image** | pill popover → browser |
 * | `person:`/`connector:` | mention chip (elsewhere) | identity card | pill, no open action |
 * | malformed `resource://` | plain text | plain text | plain text |
 * | any other scheme | unchanged | unchanged | unchanged |
 *
 * The last two rows are different answers and the difference matters. A
 * malformed `resource://` target is a citation the model meant and got wrong,
 * so its label is shown as text rather than as raw syntax. A scheme this
 * protocol does not own — `mailto:`, `mention:`, anything — is not a citation
 * at all, and the registry declines it so the renderer does exactly what it did
 * before citations existed. Collapsing the two would silently restyle every
 * link in the product whose scheme the URL transform empties.
 *
 * The image + `https` cell is deliberately *not* a citation: markdown images
 * render today and mean what they mean everywhere, so hijacking that syntax
 * would collide with a model legitimately embedding one.
 */

/** What the renderer knows about a cited resource beyond the model's own label. */
export interface CitationResource {
  /** The kind, which is all the chip and the card read: the label is the model's. */
  resourceType: string;
}

/**
 * The state of a citation's metadata lookup.
 *
 * `pending` and `resolved` both render an affordance — the chip's label is the
 * model's text either way, so there is nothing to wait for before drawing it,
 * and a chip that appeared only after a round trip would land mid-read.
 * `unavailable` is the degradation: plain label text, no affordance, and
 * nothing disclosed that the message did not already carry.
 */
export type CitationResolution =
  | { status: 'pending' }
  | { status: 'resolved'; resource: CitationResource }
  | { status: 'unavailable' };

export interface CitationResolver {
  /** What is known about this resource right now. Pure; called during render. */
  resolve: (resourceId: string) => CitationResolution;
  /** Ask for a resource that has not been resolved yet. Called from an effect. */
  request: (resourceId: string) => void;
}

/**
 * Where a chip's icon and kind come from.
 *
 * A cited resource is not guaranteed to be in the loaded work stream's resource
 * set — it may be cited from another work stream, or simply not loaded yet — so
 * resolution is the host's to supply rather than the renderer's to assume. The
 * default answers `pending` for everything and asks for nothing, which is what
 * a surface with no host installed gets: the export card's detached root, a
 * component test, a chip drawn from the label alone.
 *
 * Reading and asking are split so that neither one lies about the other's
 * timing. `resolve` runs during render and must stay pure; `request` runs from
 * an effect, which is the only place a fetch may be started from.
 */
export const CitationResolutionContext = createContext<CitationResolver>({
  resolve: () => ({ status: 'pending' }),
  request: () => undefined,
});

/**
 * What is known about a cited resource, asking for it if nothing is.
 *
 * A pending lookup still renders the chip: its label is the model's own text,
 * so there is nothing to wait for, and an affordance that appeared after a
 * round trip would land under a reader already past it.
 */
function useCitationResource(resourceId: string): CitationResolution {
  const { request, resolve } = useContext(CitationResolutionContext);
  useEffect(() => {
    if (resourceId !== '') request(resourceId);
  }, [request, resourceId]);
  return resolve(resourceId);
}

/** The footnote citations of the message being rendered, keyed by identifier. */
export interface MessageCitations {
  footnotes: Map<string, FootnoteCitation>;
  /** Every footnote's identifier in the order a renderer numbers them. */
  order: string[];
  /** The per-mount prefix GFM writes into footnote ids and fragment hrefs. */
  clobberPrefix: string;
}

export const MessageCitationContext = createContext<MessageCitations>({
  footnotes: new Map(),
  order: [],
  clobberPrefix: 'user-content-',
});

/** The union of target kinds, as the registry's second key. */
type CitationScheme = CitationTarget['kind'];

interface CitationInput {
  target: CitationTarget;
  /** The model's own text for this citation: a link label, an image's alt. */
  label: React.ReactNode;
  /** The label as a plain string, when it is one — what an action can be named. */
  labelText: string;
  /** A footnote's marker and its lifted definition; absent in the other positions. */
  footnote?: { marker: React.ReactNode; citation: FootnoteCitation };
}

type CitationRenderer = (input: CitationInput) => React.JSX.Element;

/** Plain text: the degradation every unrecognised cell shares. */
function asText({ label }: CitationInput): React.JSX.Element {
  return <span className="citation-text-fallback">{label}</span>;
}

/**
 * The icon for a resource kind, shared with the rail's own resource rows.
 *
 * One function rather than two that agree today: a chip in the transcript and
 * the row it opens are the same resource, and a reader who saw a document icon
 * in a sentence should not find a generic file icon in the rail.
 */
export function ResourceIcon({ resourceType, size = 13 }: {
  resourceType?: string;
  size?: number;
}): React.JSX.Element {
  const normalized = resourceType?.toLowerCase() ?? '';
  if (normalized.includes('url') || normalized.includes('web')) return <Link2 aria-hidden="true" size={size} />;
  if (normalized === '' || normalized.includes('doc') || normalized.includes('text')) {
    return <FileText aria-hidden="true" size={size} />;
  }
  return <File aria-hidden="true" size={size} />;
}

/**
 * Opens what a citation names.
 *
 * Internal targets go to the rail's resource detail through the store's one
 * action, which owns the ordering; external targets ride the sanctioned
 * external-open path, whose validation and OS hand-off already exist. Neither
 * adds a navigation capability to the renderer — a citation cannot reach any
 * other protocol handler, because the registry never dispatches one.
 */
function openCitationTarget(target: CitationTarget): void {
  if (target.kind === 'resource') {
    useUiStore.getState().openResource(target.resourceId);
    return;
  }
  if (target.kind === 'external') void desktopBridge().openExternal?.(target.url);
}

function ResourceChip({ label, labelText, target }: CitationInput): React.JSX.Element {
  const resourceId = target.kind === 'resource' ? target.resourceId : '';
  const resolution = useCitationResource(resourceId);
  if (resolution.status === 'unavailable') return asText({ label, labelText, target });
  const resource = resolution.status === 'resolved' ? resolution.resource : undefined;
  return (
    <button
      // The action, not just the label, the way the footnote pill already
      // names it. Omitted when the label is not plain text — the name then
      // comes from the button's own contents, which is never worse than an
      // invented one.
      {...(labelText ? { 'aria-label': `Open ${labelText}` } : {})}
      className="citation-chip"
      data-resource-id={resourceId}
      onClick={() => openCitationTarget(target)}
      type="button"
    >
      <span className="citation-chip-icon"><ResourceIcon resourceType={resource?.resourceType} /></span>
      <span className="citation-chip-label">{label}</span>
    </button>
  );
}

function ResourceCard({ label, labelText, target }: CitationInput): React.JSX.Element {
  const resourceId = target.kind === 'resource' ? target.resourceId : '';
  const resolution = useCitationResource(resourceId);
  if (resolution.status === 'unavailable') return asText({ label, labelText, target });
  const resource = resolution.status === 'resolved' ? resolution.resource : undefined;
  return (
    <button
      {...(labelText ? { 'aria-label': `Open ${labelText}` } : {})}
      className="citation-card"
      data-resource-id={resourceId}
      onClick={() => openCitationTarget(target)}
      type="button"
    >
      <span className="citation-card-icon"><ResourceIcon resourceType={resource?.resourceType} /></span>
      <span className="citation-card-body">
        <strong>{label}</strong>
        <small>{resource?.resourceType ?? 'Resource'}</small>
      </span>
    </button>
  );
}

/**
 * An identity in the embed position.
 *
 * Defined because the registry requires every cell to be, and non-navigable
 * because navigation is a property of the protocol: `person:` and `connector:`
 * name identities rather than openable content, exactly as the mention chips
 * this sits beside have always behaved.
 */
function IdentityCard({ label }: CitationInput): React.JSX.Element {
  return (
    <span className="citation-card citation-card-identity">
      <span className="citation-card-body"><strong>{label}</strong></span>
    </span>
  );
}

/**
 * A grounding citation: a numbered pill after the punctuation it supports.
 *
 * The pill is the trigger and the action at once. A popover with its own button
 * inside would be an interactive tooltip — which has no touch equivalent and an
 * awkward focus order — so the popover names the source and the pill opens it,
 * which reads the same with a pointer, a keyboard, and a finger.
 */
function FootnotePill({ footnote, label, labelText, target }: CitationInput): React.JSX.Element {
  if (!footnote) return asText({ label, labelText, target });
  const { citation, marker } = footnote;
  const navigable = target.kind === 'resource' || target.kind === 'external';
  const pill = (
    <button
      // `aria-disabled`, not `disabled`: a disabled button is not focusable and
      // dispatches no pointer events, so the tooltip wrapped around it can
      // never open — and for an identity pill that popover is the only thing
      // that says what the number refers to.
      aria-disabled={navigable ? undefined : true}
      aria-label={navigable ? `Open ${citation.label}` : citation.label}
      className="citation-pill"
      onClick={() => { if (navigable) openCitationTarget(target); }}
      type="button"
    >
      {marker}
    </button>
  );
  return (
    <Tooltip.Root delayDuration={200}>
      <Tooltip.Trigger asChild>{pill}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content className="tooltip citation-popover" side="top" sideOffset={6}>
          <span className="citation-popover-source">{citation.label}</span>
          {citation.note && <span className="citation-popover-note">{citation.note}</span>}
          {navigable && <span className="citation-popover-action">Open</span>}
          <Tooltip.Arrow className="tooltip-arrow" />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

/**
 * Every cell of the matrix, with no cell left implicit.
 *
 * `external` and `identity` in the link and image positions answer `null` and
 * mean "not a citation, render it the way this renderer already renders it" —
 * an external link stays a link, an external image stays an image, and a
 * mention stays the chip `MarkdownBody` has always made of it. That is a
 * *decision* recorded in the table rather than a gap, which is the whole reason
 * the registry exists.
 */
const CITATION_RENDERERS: Record<CitationPosition, Record<CitationScheme, CitationRenderer | null>> = {
  link: {
    resource: ResourceChip,
    external: null,
    identity: null,
    invalid: asText,
    unknown: null,
  },
  image: {
    resource: ResourceCard,
    external: null,
    identity: IdentityCard,
    invalid: asText,
    unknown: null,
  },
  footnote: {
    resource: FootnotePill,
    external: FootnotePill,
    identity: FootnotePill,
    invalid: asText,
    unknown: asText,
  },
};

/**
 * The citation `href` names in `position`, or nothing when this renderer has no
 * opinion and the caller should render what it would have rendered anyway.
 */
export function renderCitation(input: {
  position: CitationPosition;
  href: string | undefined;
  label: React.ReactNode;
  footnote?: { marker: React.ReactNode; citation: FootnoteCitation };
}): React.JSX.Element | null {
  const target = parseCitationTarget(input.href);
  const Renderer = CITATION_RENDERERS[input.position][target.kind];
  if (!Renderer) return null;
  const labelText = typeof input.label === 'string' ? input.label : '';
  // Rendered as an element, never called as a function. Two cells of the same
  // row use different numbers of hooks — a chip resolves its resource, an
  // external link uses none — and calling them inline would run those hooks in
  // *the caller's* slots, so a link whose scheme changes between renders at the
  // same position would change the hook count of one component instance. As
  // elements they are separate types, and React unmounts one and mounts the
  // other, which is the contract rather than an accident of reconciliation.
  return (
    <Renderer
      label={input.label}
      labelText={labelText}
      target={target}
      {...(input.footnote ? { footnote: input.footnote } : {})}
    />
  );
}

/**
 * The identifier a footnote reference's fragment names.
 *
 * GFM writes `#<prefix>fn-<identifier>`, normalising the identifier to lower
 * case and percent-encoding what a fragment cannot carry, so both are undone
 * here before the definition map is consulted.
 */
export function footnoteIdentifierFromHref(href: string | undefined, clobberPrefix: string): string | undefined {
  if (href === undefined) return undefined;
  const prefix = `#${clobberPrefix}fn-`;
  if (!href.startsWith(prefix)) return undefined;
  const identifier = href.slice(prefix.length);
  try {
    return decodeURIComponent(identifier).toLowerCase();
  } catch {
    // A model writes footnote identifiers, so a malformed escape is reachable
    // input: it is simply not an identifier this message defines.
    return identifier.toLowerCase();
  }
}

/** The identifier a footnote definition's list item is the definition of. */
export function footnoteIdentifierFromId(id: string | undefined, clobberPrefix: string): string | undefined {
  return footnoteIdentifierFromHref(id === undefined ? undefined : `#${id}`, clobberPrefix);
}

/** The footnote citations of the message being rendered. */
export function useMessageCitations(): MessageCitations {
  return useContext(MessageCitationContext);
}

/**
 * The footnote definitions of `markdown` that this renderer will lift into
 * their references, keyed by the identifier GFM will normalise them to.
 *
 * Two filters, and both are degradations rather than omissions. A definition
 * that is not a citation under the pinned grammar was never in the map. A
 * definition whose one link cannot be opened — a scheme this protocol does not
 * own, or a citation scheme with a target that is not one — is dropped here, so
 * its reference keeps its ordinary superscript and its content keeps its place
 * in the trailing footnote list. The source stays readable, which lifting it
 * would not achieve: a lifted definition the registry then renders as text puts
 * the *source's title* where the reference marker belongs and drops the
 * definition from the bottom, so the sentence reads "Revenue grew 40%.Q3 board
 * deck" and the source is gone. A model echoing the guidance's own
 * `<resource-id>` placeholder writes exactly that input.
 *
 * One function, because four component overrides have to agree about which
 * definitions were lifted: the reference that becomes a pill, the list item
 * that must not also render it, the section that renders nothing when every
 * definition was lifted, and the superscript wrapper the pill replaces.
 */
export function liftableFootnoteCitations(markdown: string): Map<string, FootnoteCitation> {
  const lifted = new Map<string, FootnoteCitation>();
  for (const [identifier, citation] of collectFootnoteCitations(markdown)) {
    const kind = parseCitationTarget(citation.href).kind;
    if (kind === 'unknown' || kind === 'invalid') continue;
    lifted.set(identifier.toLowerCase(), citation);
  }
  return lifted;
}

/**
 * The number a footnote's reference shows, from the shared ordering.
 *
 * Restated on the list items that survive because dropping the lifted ones
 * renumbers what is left: a reference reading "2" in the prose would otherwise
 * sit above a source list reading "1.".
 */
export function footnoteOrdinal(order: string[], identifier: string): number | undefined {
  const index = order.indexOf(identifier);
  return index < 0 ? undefined : index + 1;
}

/** The footnote ordering of `markdown`, for the renderer's own numbering. */
export function messageFootnoteOrder(markdown: string): string[] {
  return footnoteReferenceOrder(markdown);
}
