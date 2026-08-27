/**
 * The citation protocol: how a model says what it used and what it made.
 *
 * A citation is ordinary Markdown. A work-stream resource is cited with link
 * syntax for an inline reference (`[Title](resource://<id>)`) or image syntax
 * for an embed card (`![Title](resource://<id>)`); a grounding source is cited
 * with a GFM footnote whose definition carries the link. Nothing here is a new
 * message type or a wire field — the desktop's single Markdown renderer
 * dispatches on what this module recognises, and everything it does not
 * recognise stays the text the model wrote.
 *
 * This module is the *grammar*, shared because three surfaces have to agree on
 * it and cannot each hold their own copy:
 *
 * - the desktop renderer, which turns a recognised citation into a chip, a
 *   card, or a floating pill;
 * - outbound email, which renders Markdown with no renderer of ours;
 * - Slack delivery, which hands Markdown to Slack.
 *
 * The two delivery paths call `rewriteCitationsForPlainDelivery`, because Slack
 * and a mail client render neither `resource://` nor footnote syntax: without
 * the rewrite an answer arrives with a raw scheme URL in it, a literal `[^1]`,
 * or — for the embed form — a broken image. That makes the rewrite load-bearing
 * rather than cosmetic, which is why it lives beside the grammar rather than in
 * either caller.
 */

import { mapMarkdownProse, maskMarkdownCode } from "./markdown-code";

/** Where a citation appeared, which is what decides how it renders. */
export type CitationPosition = "link" | "image" | "footnote";

/**
 * What a citation's target names.
 *
 * `resource` and `external` name openable content and are navigable; `identity`
 * names a person or a connection and never navigates, exactly as the renderer's
 * mention chips already behave. Everything else is `unknown` and renders as the
 * label's own text — the dispatch is an allowlist, so nothing in a model's
 * output can reach another protocol handler.
 */
export type CitationTarget =
  | { kind: "resource"; resourceId: string }
  | { kind: "external"; url: string }
  | { kind: "identity"; scheme: "person" | "connector" }
  /** A citation scheme with a target that is not one: a chip that cannot open. */
  | { kind: "invalid" }
  /** Not a citation at all — whatever the surface already does with it stands. */
  | { kind: "unknown" };

/**
 * The characters a resource identifier may be spelled with.
 *
 * Deliberately an alphabet rather than a UUID pattern: the shape of a resource
 * identifier belongs to the resource system, not to the renderer, so a UUID
 * today and a short slug tomorrow both parse with no change here. It is an
 * allowlist and not a length bound — a `?v=3` is reserved, unparsed syntax, and
 * anything with a slash, a dot segment, or a query in it is not an identifier
 * and must not be dressed as one.
 */
const RESOURCE_ID = /^[A-Za-z0-9_-]+$/u;

/** `resource://<id>`, and the bare `resource:<id>` spelling that predates it. */
const RESOURCE_HREF = /^resource:(?:\/\/)?(.*)$/iu;

/**
 * Reads a link target as a citation target.
 *
 * Parsing is lenient across both `resource://` and the legacy bare `resource:`
 * — nothing already emitted should break — while the emission guidance teaches
 * `resource://` only.
 */
export function parseCitationTarget(href: string | undefined): CitationTarget {
  if (href === undefined || href === "") return { kind: "unknown" };
  const resource = RESOURCE_HREF.exec(href);
  if (resource) {
    const resourceId = resource[1] ?? "";
    // `invalid`, not `unknown`: the model *meant* a citation here, so the label
    // has to be shown as text rather than left as raw syntax. A scheme this
    // module does not own is a different answer, and the renderer treats it as
    // one — it renders whatever it rendered before citations existed.
    return RESOURCE_ID.test(resourceId) ? { kind: "resource", resourceId } : { kind: "invalid" };
  }
  if (/^https?:\/\//iu.test(href)) return { kind: "external", url: href };
  if (/^person:/iu.test(href)) return { kind: "identity", scheme: "person" };
  if (/^connector:/iu.test(href)) return { kind: "identity", scheme: "connector" };
  return { kind: "unknown" };
}

/** A footnote definition that qualifies as a citation, lifted into its reference. */
export interface FootnoteCitation {
  /** The identifier as written after `[^`, which is how a reference finds it. */
  identifier: string;
  /** The single link's label: what names the source to a reader. */
  label: string;
  /** The single link's target, still unparsed — `parseCitationTarget` decides it. */
  href: string;
  /** Whatever plain text sat around the link, carried into the popover with it. */
  note: string;
}

/**
 * A footnote definition line, and the identifier it defines.
 *
 * Up to three leading spaces, the way every other Markdown block opener is
 * allowed to be indented; four would be an indented code block.
 */
const FOOTNOTE_DEFINITION = /^ {0,3}\[\^([^\]\s]+)\]:[ \t]*(.*)$/u;

/** A footnote reference in prose. */
const FOOTNOTE_REFERENCE = /\[\^([^\]\s]+)\]/gu;

/** An inline link, with its label and target. Images are matched separately. */
const INLINE_LINK = /(!?)\[([^\][]*)\]\(([^\s)]*)\)/gu;

/**
 * The definitions in `markdown` that qualify as citations, keyed by identifier.
 *
 * The grammar is pinned rather than guessed: a definition qualifies when its
 * content is **a single paragraph containing exactly one link**. Plain text
 * around the link is permitted and comes back as `note`. A definition with no
 * link, with more than one, or with a second block is not a citation — its
 * reference stays an ordinary superscript and it renders as a classic footnote,
 * so a free-form or malformed footnote degrades to standard GFM rendering
 * instead of a broken pill.
 */
export function collectFootnoteCitations(markdown: string): Map<string, FootnoteCitation> {
  const citations = new Map<string, FootnoteCitation>();
  for (const definition of footnoteDefinitions(markdown)) {
    const citation = citationFrom(definition);
    if (citation) citations.set(definition.identifier, citation);
  }
  return citations;
}

interface FootnoteDefinition {
  identifier: string;
  /** The definition's whole content, continuation lines joined into one string. */
  content: string;
  /** Offsets of the definition's lines in the source, so a rewrite can cut them. */
  start: number;
  end: number;
  /** More than one block: still a definition, but never a citation. */
  multiBlock: boolean;
}

/**
 * Every footnote definition in the source, with the offsets of the lines it
 * spans.
 *
 * Read off a code mask, so a definition written inside a fence — a model
 * showing someone the syntax — is not one.
 */
function footnoteDefinitions(markdown: string): FootnoteDefinition[] {
  const masked = maskMarkdownCode(markdown);
  const definitions: FootnoteDefinition[] = [];
  let offset = 0;
  let open: (FootnoteDefinition & { lines: string[] }) | null = null;
  let blankRun = false;
  const close = () => {
    if (!open) return;
    definitions.push({
      identifier: open.identifier,
      content: open.lines.join("\n"),
      start: open.start,
      end: open.end,
      multiBlock: open.multiBlock,
    });
    open = null;
  };
  for (const maskedLine of masked.split("\n")) {
    const lineEnd = offset + maskedLine.length;
    const source = markdown.slice(offset, lineEnd);
    const definition = FOOTNOTE_DEFINITION.exec(maskedLine);
    if (definition) {
      close();
      const content = source.slice(source.length - (definition[2] ?? "").length);
      open = {
        identifier: definition[1] ?? "",
        content: "",
        lines: [content],
        start: offset,
        end: lineEnd,
        multiBlock: false,
      };
      blankRun = false;
    } else if (open) {
      const blank = maskedLine.trim() === "";
      // A continuation is indented; a blank line only continues the definition
      // when an indented line follows it, and when one does the definition has
      // a second block and is no longer a citation.
      if (blank) {
        blankRun = true;
      } else if (/^ {2,}/u.test(maskedLine)) {
        if (blankRun) open.multiBlock = true;
        open.lines.push(source.trim());
        open.end = lineEnd;
        blankRun = false;
      } else {
        close();
        blankRun = false;
      }
    }
    offset = lineEnd + 1;
  }
  close();
  return definitions;
}

/** A definition as a citation, or nothing when it does not qualify as one. */
function citationFrom(definition: FootnoteDefinition): FootnoteCitation | undefined {
  const { content, identifier, multiBlock } = definition;
  if (multiBlock || content.trim() === "") return undefined;
  const links = [...content.matchAll(INLINE_LINK)].filter((match) => match[1] === "");
  if (links.length !== 1) return undefined;
  const [match] = links;
  if (!match) return undefined;
  const note = (content.slice(0, match.index) + content.slice(match.index + match[0].length)).trim();
  return {
    identifier,
    label: (match[2] ?? "").trim(),
    href: match[3] ?? "",
    note,
  };
}

/**
 * The same answer, readable on a surface that renders none of this.
 *
 * Applied by outbound email and by Slack delivery before either sends. Chips
 * and embed cards reduce to their label text; footnote references become plain
 * bracketed numbers and their definitions a trailing source list, titles for
 * internal sources and real links for external ones. An external link and a
 * real image are left exactly as written — both mean what they mean on those
 * surfaces, and rewriting them would be this function's own damage.
 *
 * Deliberately *not* applied to the transcript copy of the same answer: the
 * desktop renders citations fully, and only the copy leaving Rally is rewritten.
 */
export function rewriteCitationsForPlainDelivery(markdown: string): string {
  const definitions = footnoteDefinitions(markdown);
  const withoutDefinitions = cutDefinitionLines(markdown, definitions);
  const byIdentifier = new Map(definitions.map((definition) => [definition.identifier, definition]));

  // Numbered by first reference, the way a Markdown renderer numbers them, so
  // the delivered copy and the transcript copy agree about which source is [1].
  const order: string[] = [];
  const numbered = mapMarkdownProse(withoutDefinitions, (prose) => prose.replace(
    FOOTNOTE_REFERENCE,
    (reference, identifier: string) => {
      if (!byIdentifier.has(identifier)) return reference;
      if (!order.includes(identifier)) order.push(identifier);
      return `[${order.indexOf(identifier) + 1}]`;
    },
  ));

  const reduced = mapMarkdownProse(numbered, reduceResourceLinks);
  // Only a document that lost definition lines gets its blank runs closed up:
  // an answer that cites nothing must come back byte-identical, trailing
  // newline included, because both callers hand this every message they send.
  const body = definitions.length === 0 ? reduced : reduced.replace(/\n{3,}/gu, "\n\n").trim();
  if (order.length === 0) return body;

  const sources = order.map((identifier, index) => {
    const definition = byIdentifier.get(identifier);
    const content = reduceResourceLinks(definition?.content ?? "");
    const citation = definition ? citationFrom(definition) : undefined;
    if (!citation) return `${index + 1}. ${content.trim()}`;
    const target = parseCitationTarget(citation.href);
    const source = target.kind === "external" ? `${citation.label} (${citation.href})` : citation.label;
    return `${index + 1}. ${citation.note ? `${citation.note} ` : ""}${source}`.trim();
  });
  return `${body}\n\nSources:\n\n${sources.join("\n")}`;
}

/**
 * Link and image citations reduced to the words they were decorating.
 *
 * Only a `resource:` target is touched. An `https` link is a link and an
 * `https` image is an image on every surface this feeds, so both are left as
 * the model wrote them.
 */
function reduceResourceLinks(value: string): string {
  return value.replace(INLINE_LINK, (match, bang: string, label: string, href: string) => {
    const kind = parseCitationTarget(href).kind;
    // A malformed target is reduced too. It cannot open anything anywhere, and
    // leaving it is leaving raw `resource://` syntax in somebody's inbox, which
    // is the exact leak this rewrite exists to close.
    return kind === "resource" || kind === "invalid" ? (label || "") : match;
  });
}

/** The source with every footnote definition line removed. */
function cutDefinitionLines(markdown: string, definitions: FootnoteDefinition[]): string {
  let result = "";
  let cursor = 0;
  for (const definition of definitions) {
    result += markdown.slice(cursor, definition.start);
    cursor = Math.min(definition.end + 1, markdown.length);
  }
  return result + markdown.slice(cursor);
}
