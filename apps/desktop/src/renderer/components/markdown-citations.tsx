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
import { File, FileText, Image as ImageIcon, Link2, Pause, Play, Volume2 } from 'lucide-react';
import { createContext, useContext, useEffect, useRef, useState, type ComponentType } from 'react';

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

/**
 * What the host read for a card, in the form the card can actually use.
 *
 * The two media kinds keep the resource's own bytes — an image the card draws,
 * an audio file it plays — and everything else is the readable derivative the
 * rail's panel shows. The split is made at the read, not here: sending bytes
 * through the derivative reader decodes them as UTF-8, which is how an audio
 * card came to show a paragraph of replacement characters.
 */
export type CitationPreview =
  | { readonly kind: 'audio' | 'image'; readonly blob: Blob }
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
  /**
   * The resource content for the embed card's preview, or `undefined` for a
   * resource this context cannot resolve. Images and audio files keep their
   * bytes — one so the card can draw a thumbnail, the other so it can play the
   * recording; everything else is the preview route's readable
   * derivative — a Word file's markdown, a PDF's OCR. The promise settles only
   * once the route has stopped answering "still preparing"; the card shows its
   * skeleton exactly as long as the promise is open. Optional because a surface
   * with no work stream behind it has no route to read, and the card then simply
   * keeps its room.
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
  /**
   * How the embed card's preview renders the derivative's markdown.
   *
   * Lives here rather than as an import of `MarkdownBody` because that module
   * already imports this one for the citation matrix; a reverse import would
   * cycle. The body supplies itself — glance, verbatim, no citations — so the
   * preview uses the one renderer without mounting a second `react-markdown`,
   * a document that cites another resource cannot draw a card inside this card,
   * and a fence or a link cannot nest a control inside the card's button.
   */
  readonly PreviewBody?: ComponentType<{ children: string }>;
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

/**
 * Whether this resource is something to *hear*, and so gets the transport card.
 *
 * Read from the record rather than from the bytes that have not arrived yet, so
 * the card is one shape for its whole life. Deciding it on the settled preview
 * instead would swap a button for a container under a reader who had already
 * focused it.
 *
 * It classifies from MIME and filename **unconditionally**, which is not what
 * `resourceIconType` does — that answers the raw `resourceType` for anything
 * outside the two provenance types, because a `github_pull_request` is not a
 * file. Both halves that decide the *bytes* — `ResourceService.preview` and
 * `useCitations` — make this same unconditional call, and a card that
 * classified more narrowly than the read disagreed with it: an MP3 carrying a
 * connector's own type (`slack_file`, `drive_file`) was fetched as audio and
 * then drawn by the ordinary card, which has nothing to put in the room for a
 * blob it did not classify as an image. The three have to agree.
 */
function isAudioResource(resource: CitationResource): boolean {
  return classifyAttachmentKind({ mimeType: resource.mimeType, fileName: resource.title }) === 'audio';
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
 * It is drawn as a file tile — the kind badge at the head, the title and kind at
 * the foot, room between — rather than as a list row, so an announced resource
 * reads as a thing that was produced, not as another line of the sentence.
 *
 * The room is not always empty: an image resource shows a cropped thumbnail,
 * and a readable document shows the opening lines of its converted markdown,
 * clipped by the stylesheet — never scrolled. Both show a shimmering skeleton
 * while the read is open. The preview is presentation, so it is `aria-hidden`
 * (and text is `inert`), while the button's label stays the title alone. A still
 * render skips it entirely: a picture serialized mid-skeleton would keep the
 * skeleton forever.
 *
 * An audio resource is the one kind whose card is *not* a single button — it
 * hands off to `ResourceAudioCard`, which has a control in it. This component
 * still owns the read: one effect, one cache entry, one object URL per *blob*,
 * whichever shape the card takes.
 */
function ResourceEmbedCard({ label, resource, onOpen, preview }: {
  label: React.ReactNode;
  resource: CitationResource;
  onOpen: () => void;
  preview?: ((resourceId: string) => Promise<CitationPreview> | undefined) | undefined;
}): React.JSX.Element {
  const { PreviewBody } = useCitationRender();
  const [excerpt, setExcerpt] = useState<CardPreviewState>({ for: '' });
  /**
   * One object URL per blob, held across effect runs rather than minted by each.
   *
   * This effect re-runs whenever `preview`'s identity changes, and it changes
   * whenever the work stream's resource array does — which the socket replaces
   * on every `resource_attached` and `resource_updated`. The cached read then
   * resolves to the *same* blob, so minting a URL per run handed the element a
   * new `src` for bytes that had not changed: the `audio` reloaded and a reader
   * halfway through a recording was returned to 0:00 with the button back on
   * "Play", because the agent published an unrelated file. An image tolerated
   * it as an imperceptible re-decode; a recording does not.
   *
   * A ref rather than state: nothing renders from it, and the identity of the
   * URL is what the element keys its load on.
   */
  const held = useRef<{ blob: Blob; url: string } | null>(null);
  // Revoked on unmount alone, for the same reason it is minted once: a run that
  // resolves the blob it already holds must leave the live URL alone.
  useEffect(() => () => {
    if (held.current) URL.revokeObjectURL(held.current.url);
    held.current = null;
  }, []);
  useEffect(() => {
    const request = preview?.(resource.id);
    if (!request) {
      setExcerpt({ for: resource.id });
      return;
    }
    let cancelled = false;
    // Asking is announced on top of what the card already holds, not in place
    // of it. A warm card re-runs this effect whenever the callback's identity
    // changes — the socket replaces the work stream's resource array on every
    // attach — and the settled read then resolves a microtask later, in a
    // *second* commit. Replacing the state here emptied the card for the one in
    // between: harmless for an excerpt nobody saw blink, fatal for a recording,
    // because the `audio` element unmounted and took the playback with it. The
    // skeleton is chosen at render from having nothing to show, so a re-ask
    // still cannot paint one over an excerpt that is already there.
    setExcerpt(asking(resource.id, true));
    request
      .then((result) => {
        if (cancelled) return;
        if (result.kind === 'text') {
          setExcerpt({ for: resource.id, text: previewExcerpt(result.text) });
          return;
        }
        setExcerpt({ for: resource.id, media: result.kind, src: objectUrlFor(held, result.blob) });
      })
      .catch(() => {
        // Every rejection — unavailable, unconvertible, retries spent — means
        // the same thing here: the card keeps its empty room, exactly as it
        // stands on a surface that offers no preview at all. A card that
        // already holds bytes keeps them, for the same reason the ask does not
        // clear them: a failed *re*-ask is an answer about the next read, not a
        // reason to take a recording away from somebody listening to it.
        if (!cancelled) setExcerpt(asking(resource.id, false));
      });
    return () => {
      cancelled = true;
    };
  }, [preview, resource.id]);
  // A commit can hand this mounted card a different resource before the effect
  // re-runs; matching on the id keeps the old resource's text off the new one.
  const settled = excerpt.for === resource.id ? excerpt : { for: resource.id };
  if (isAudioResource(resource)) {
    return (
      <ResourceAudioCard
        label={label}
        loading={loadingRoom(settled)}
        onOpen={onOpen}
        resource={resource}
        src={settled.media === 'audio' ? settled.src : undefined}
      />
    );
  }
  return (
    <button
      aria-label={`Open ${resource.title}`}
      className="citation-card"
      data-resource-type={resource.resourceType}
      onClick={onOpen}
      type="button"
    >
      <span aria-hidden="true" className="citation-card-badge"><ResourceIcon type={resourceIconType(resource)} /></span>
      {loadingRoom(settled) && (
        <span aria-hidden="true" className="citation-card-preview-skeleton">
          <span /><span /><span />
        </span>
      )}
      {settled.media === 'image' && settled.src && (
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
      {settled.text !== undefined && settled.text !== '' && (
        <span aria-hidden="true" className="citation-card-preview" inert>
            {PreviewBody ? <PreviewBody>{settled.text}</PreviewBody> : settled.text}
        </span>
      )}
      <span className="citation-card-text">
        <strong className="citation-card-title">{label}</strong>
        <small className="citation-card-kind">{resourceKindLabel(resource)}</small>
      </span>
    </button>
  );
}

/**
 * The card that is playing, so that starting one stops it.
 *
 * Module-level rather than context, because it is not a piece of application
 * state anybody renders from: nothing outside the card that owns the element
 * needs to know which one is sounding, and a provider for it would have to be
 * mounted by every one of the surfaces that render markdown. A run of announced
 * recordings shares one row, and two of them playing at once is not a mix
 * anybody chose.
 */
let sounding: HTMLAudioElement | null = null;

/**
 * The announcement form for a resource somebody is meant to *hear*.
 *
 * Every other embed card is one button whose room holds a picture of the
 * document. A recording has no such picture — the preview route serves audio as
 * its own bytes — and what a reader wants from an announced recording is to
 * play it, not to look at it. So this card carries a transport where a glance
 * would go, and it is the one card that is *not* a single button: a control
 * cannot nest inside one, and a play button that opened the rail instead would
 * be the same defect in the other direction. The tile keeps its shape — the
 * badge stays the kind glyph every card carries, the room becomes the position
 * with a small play/pause button under it, and the title block is the button
 * that opens the rail — so a row of cards still reads as a row of cards.
 *
 * It is a transport, not a player: play, pause, and where you are. Scrubbing,
 * volume and speed are the rail's own `<audio controls>`, one click away
 * through the title, and a scrub target 150px wide inside a tile is a control
 * nobody can land on. That is a trade, and it is the cheap one to reverse.
 *
 * **Everything here is phrasing content, and that is load-bearing.** A lone
 * embed keeps the paragraph the markdown put it in — `rehypeCitationEmbedRows`
 * merges only runs of two or more — so this card renders inside a `<p>`. The
 * container is a `span` rather than a `div` for that reason: React builds the
 * live DOM node by node and would nest one happily, but the export serializes
 * that DOM to a string and Chromium *reparses* it, and the parser closes an
 * open paragraph before a `div` and leaves a stray empty one behind. The saved
 * picture then has a paragraph the turn did not. `button`, `span`, `small` and
 * `audio` are all phrasing; a block element added here reopens this.
 *
 * The played position and the elapsed clock come from the element's own events
 * rather than from the click, so the button can never claim to be playing
 * something the element stopped — an audio file whose bytes will not decode
 * fails on `play()` and the card goes back to saying "Play".
 */
function ResourceAudioCard({ label, loading, onOpen, resource, src }: {
  label: React.ReactNode;
  loading: boolean;
  onOpen: () => void;
  resource: CitationResource;
  /** The object URL for the resource's bytes, or `undefined` until they arrive. */
  src: string | undefined;
}): React.JSX.Element {
  const element = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState<number | null>(null);

  // Bytes that changed under a mounted card start over. Carrying the position
  // across is the same defect as an excerpt of the wrong revision: the clock
  // would report one recording's place in another.
  useEffect(() => {
    setPlaying(false);
    setPosition(0);
    setDuration(null);
  }, [src]);

  // Removing a media element from the document does not stop it, so a card
  // scrolled out of the transcript would go on playing with nothing on screen
  // to stop it. The node is captured here rather than read in the cleanup
  // because React has already detached the ref by then.
  useEffect(() => {
    const audio = element.current;
    return () => {
      audio?.pause();
      if (sounding === audio) sounding = null;
    };
  }, [src]);

  return (
    <span className="citation-card citation-card-audio" data-resource-type={resource.resourceType}>
      {/* The kind badge every card carries, and the same speaker glyph the rail's
          own list draws for a recording. The transport below is the control;
          the badge says what the card is. */}
      <span aria-hidden="true" className="citation-card-badge"><ResourceIcon type="audio" /></span>
      {/* The bar shimmers while the bytes are on their way and sits empty when
          no route offered them, which is also what a saved still holds. The
          control sits under the position it moves, so the eye reads the card
          top to bottom: what this is, where it is, what to press. */}
      <span className="citation-card-transport">
        <span
          aria-hidden="true"
          className="citation-card-progress"
          data-loading={loading ? 'true' : undefined}
          style={{ '--citation-card-played': playedWidth(position, duration) } as React.CSSProperties}
        />
        {src !== undefined && (
          <small className="citation-card-elapsed">
            {clock(position)}{duration === null ? '' : ` / ${clock(duration)}`}
          </small>
        )}
        {src !== undefined && (
          <button
            aria-label={`${playing ? 'Pause' : 'Play'} ${resource.title}`}
            className="icon-button citation-card-play"
            onClick={() => {
              const audio = element.current;
              if (!audio) return;
              if (audio.paused) void audio.play().catch(() => setPlaying(false));
              else audio.pause();
            }}
            type="button"
          >
            {playing ? <Pause size={15} /> : <Play size={15} />}
          </button>
        )}
      </span>
      {src !== undefined && (
        <audio
          className="citation-card-audio-source"
          onDurationChange={(event) => {
            // A stream whose container carries no duration reports Infinity,
            // and a clock reading "Infinity" is worse than no clock at all.
            const seconds = event.currentTarget.duration;
            setDuration(Number.isFinite(seconds) ? seconds : null);
          }}
          onEnded={() => {
            setPlaying(false);
            setPosition(0);
          }}
          onPause={() => setPlaying(false)}
          onPlay={() => {
            if (sounding && sounding !== element.current) sounding.pause();
            sounding = element.current;
            setPlaying(true);
          }}
          onTimeUpdate={(event) => setPosition(event.currentTarget.currentTime)}
          preload="metadata"
          ref={element}
          src={src}
        />
      )}
      <button
        aria-label={`Open ${resource.title}`}
        className="citation-card-text citation-card-open"
        onClick={onOpen}
        type="button"
      >
        <strong className="citation-card-title">{label}</strong>
        <small className="citation-card-kind">{resourceKindLabel(resource)}</small>
      </button>
    </span>
  );
}

/**
 * Whether the card's room is a read in progress rather than something to show.
 *
 * Read at render from the content rather than tracked as a state of its own, so
 * that a re-ask over an excerpt or a player the card already has cannot paint a
 * skeleton across it.
 */
function loadingRoom(settled: CardPreviewState): boolean {
  return settled.open === true && settled.src === undefined && settled.text === undefined;
}

/** How much of the bar is played, as the width the stylesheet fills it to. */
function playedWidth(position: number, duration: number | null): string {
  if (duration === null || duration <= 0) return '0%';
  return `${Math.min(100, (position / duration) * 100)}%`;
}

/**
 * A position on the transport, in the clock a media player uses: `m:ss`, and
 * `h:mm:ss` once a recording runs past the hour. `formatDuration` is the
 * elapsed-time voice — "3m 45s" — which is right beside a run's timings and
 * wrong beside a play button.
 */
function clock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor(whole / 60) % 60;
  const remainder = String(whole % 60).padStart(2, '0');
  if (hours === 0) return `${minutes}:${remainder}`;
  return `${hours}:${String(minutes).padStart(2, '0')}:${remainder}`;
}

/** What the card holds while a read is open, or has just failed, for one resource. */
type CardPreviewState = { for: string; media?: 'audio' | 'image'; src?: string; text?: string; open?: boolean };

/**
 * Move a card into or out of the asking state without discarding what it shows.
 *
 * A card handed a *different* resource starts empty — the old document's
 * excerpt must not sit under the new one's title — and one asked again about
 * the resource it already holds keeps everything but the flag.
 */
function asking(resourceId: string, open: boolean): (current: CardPreviewState) => CardPreviewState {
  return (current) => (current.for === resourceId ? { ...current, open } : { for: resourceId, open });
}

/**
 * The card's URL for these bytes: the one it already holds when the blob is the
 * same object, a fresh one otherwise.
 *
 * Identity rather than equality, because that is exactly the question — the
 * read is cached, so a re-run of the effect resolves the very same `Blob`, and
 * two different reads produce two different objects whether or not the bytes
 * inside them match. Replacing a held URL revokes it first: the element has
 * already been handed the new one by the time anything could load the old.
 */
function objectUrlFor(held: React.RefObject<{ blob: Blob; url: string } | null>, blob: Blob): string {
  const current = held.current;
  if (current?.blob === blob) return current.url;
  if (current) URL.revokeObjectURL(current.url);
  const url = URL.createObjectURL(blob);
  held.current = { blob, url };
  return url;
}

/**
 * The slice of a derivative the preview actually shows.
 *
 * Blank lines stay: they *are* the block grammar, and collapsing them used
 * to be a plain-text trick for spending the clamp on words rather than on
 * empty lines. Fed to `MarkdownBody` that rewrite joins paragraphs, promotes
 * a paragraph above `---` into a heading, and swallows the sentence after a
 * list into its last item. The clamp's seams now live in CSS (`margin: 0` on
 * the nested body) rather than in the source. The tail beyond a few times
 * the visible clamp is still not put in the DOM — the stylesheet clips at
 * four lines, so shipping a whole document into the box would render the
 * same pixels at many times the node weight.
 */
function previewExcerpt(text: string): string {
  return text
    .replace(/\r\n/gu, '\n')
    .trim()
    .slice(0, 600);
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
  const opens = citation.target.scheme === 'external' ? 'Opens in your browser' : 'Opens in Details';
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
    return <ResourceChip label={args.label} onOpen={onOpen} resource={resource} />;
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
    return <ResourceEmbedCard label={args.label} onOpen={onOpen} preview={preview} resource={resource} />;
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
