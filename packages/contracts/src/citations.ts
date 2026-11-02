/**
 * The citation protocol: what a `resource://` target means, and how a citation
 * reads on a surface that cannot render one.
 *
 * A citation is ordinary Markdown. The model writes `[Title](resource://<id>)`
 * for a reference inside prose, `![Title](resource://<id>)` on its own line to
 * announce something it produced, and GFM footnotes for grounding — and the
 * desktop's one Markdown renderer turns each into a chip, a card, or an inline
 * pill. Nothing about the wire, the schema, or the message type changes; the
 * PRD under `docs/PRDs/2026-08-27_inline-resource-citations/` has the argument.
 *
 * This module is the half of that protocol which is not React. It holds four
 * things, shared rather than reimplemented, because the consumers disagreeing
 * about what a citation *is* would be invisible until somebody read an email:
 *
 * - **`parseCitationHref`** — the scheme allowlist. Its answer decides whether
 *   something navigates, and to where.
 * - **`citationFootnotes`** — the pinned definition grammar. Exactly one link in
 *   one paragraph is a citation; anything else is a footnote, and stays one.
 * - **`embeddedResourceCitations`** — the image-syntax announcements the
 *   desktop auto-opens the inspector onto. Link-syntax chips, footnotes, and
 *   anything inside code are not announcements.
 * - **`rewriteCitationsAsPlainText`** and
 *   **`rewriteMessageAsPlainText`** — what Rally's non-renderer
 *   delivery surfaces send instead. Email, Slack, and Apple alerts have no
 *   Rally renderer in the path, so without this an internal target arrives as
 *   literal syntax.
 */

import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { isMarkdownCode, markdownLineKinds } from "./markdown-code";
import { stripPersonalSystemPrompt } from "./text";

/** A citation target, once the scheme allowlist has decided what it is. */
export type CitationTarget =
  /** Something inside Rally: opens the resource rail, under the viewer's own authorization. */
  | { readonly scheme: "resource"; readonly resourceId: string }
  /** A real web address: opens in the system browser through the sanctioned path. */
  | { readonly scheme: "external"; readonly url: string }
  /** An identity. Named, rendered, and — deliberately — never navigable. */
  | { readonly scheme: "person" }
  /** Everything else, which is text. */
  | { readonly scheme: "unknown" };

/**
 * The characters an identifier may be spelled with.
 *
 * An allowlist, not a length or a shape: the id belongs to the resource system,
 * which serves a UUID today and a short slug once the versioning sibling lands,
 * so pinning either spelling here would make the renderer the thing that has to
 * change. What this does pin is that an id is a single opaque path segment —
 * no slashes, no dots that could walk a path, no whitespace, nothing that could
 * carry a second scheme — because the value is used to look a resource up and
 * must never be able to mean anything else.
 */
const CITATION_ID = /^[A-Za-z0-9_-]+$/u;

// Case-insensitive, like every other scheme test in this module. A model that
// writes `Resource://abc` is emptied by the desktop's URL transform and so
// never leaks there — but the reduction read it as an unknown scheme and left
// it alone, which put the raw target in an inbox.
const RESOURCE_SCHEME = /^resource:(?:\/\/)?/iu;

/**
 * A well-formed person id in a mention href.
 *
 * Mentions authorize against a real user id, so unlike `resource://` — whose
 * opaque segment is the resource system's to shape — this is a UUID. Both the
 * house `person://` spelling and the legacy bare `person:` spelling are
 * accepted so stored transcript messages keep resolving.
 */
const PERSON_UUID = "[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}";
const PERSON_MENTION_HREF = new RegExp(`^person:(?:\\/\\/)?(${PERSON_UUID})$`, "iu");

/**
 * Durable Markdown link for a person mention — the house spelling.
 *
 * Callers that author mentions (composer prepare, model guidance) emit
 * `person://`. Surfaces that *read* mentions must also accept bare `person:`
 * via {@link personIdFromMentionHref} / {@link personMentionMarkdownPattern}.
 */
export function personMentionHref(personId: string): string {
  return `person://${personId}`;
}

/**
 * UUID from a person mention href, or `undefined` when the target is not a
 * well-formed id (malformed model text, a non-id label, etc.).
 */
export function personIdFromMentionHref(href: string | undefined): string | undefined {
  const match = href?.match(PERSON_MENTION_HREF);
  return match?.[1]?.toLowerCase();
}

/**
 * Matches `[@Label](person:<uuid>)` and `[@Label](person://<uuid>)` in agent
 * text. Capture group 1 is the label, with Markdown escapes intact, and group
 * 2 is the person id. Fresh each call so a `/g` lastIndex cannot leak across
 * reductions.
 */
export function personMentionMarkdownPattern(): RegExp {
  return new RegExp(
    String.raw`\[@((?:\\.|[^\\\]])+)\]\(person:(?:\/\/)?(${PERSON_UUID})\)`,
    "giu",
  );
}

export interface PersonMentionMarkdownRange {
  readonly personId: string;
  readonly startOffset: number;
  readonly endOffset: number;
}

interface PositionedMarkdownNode {
  readonly type: string;
  readonly url?: unknown;
  readonly children?: readonly PositionedMarkdownNode[];
  readonly position?: {
    readonly start: { readonly offset?: number };
    readonly end: { readonly offset?: number };
  };
}

/**
 * Identity-bearing person links in rendered Markdown prose, with exact source
 * offsets. Code examples are not mentions: fenced, indented and inline code
 * stay outside the result just as they stay outside the rendered link path.
 *
 * This only recognizes syntax. A caller that turns a range into authority must
 * still resolve `personId` against its own current participant set.
 */
export function personMentionMarkdownRanges(markdown: string): PersonMentionMarkdownRange[] {
  const ranges: PersonMentionMarkdownRange[] = [];
  const tree = unified().use(remarkParse).use(remarkGfm).parse(markdown) as PositionedMarkdownNode;
  const visit = (node: PositionedMarkdownNode): void => {
    if (node.type === "link" && typeof node.url === "string") {
      const personId = personIdFromMentionHref(node.url);
      const startOffset = node.position?.start.offset;
      const endOffset = node.position?.end.offset;
      if (personId !== undefined && startOffset !== undefined && endOffset !== undefined) {
        const source = markdown.slice(startOffset, endOffset);
        const match = [...source.matchAll(personMentionMarkdownPattern())][0];
        if (match?.index === 0 && match[0].length === source.length && match[2]?.toLowerCase() === personId) {
          ranges.push({ personId, startOffset, endOffset });
        }
      }
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(tree);
  return ranges;
}

const SIDEKICK_MENTION_HREF = new RegExp(`^sidekick:\\/\\/(${PERSON_UUID})$`, "iu");

/**
 * Durable Markdown link for a Sidekick mention: `[@Name](sidekick://<id>)`.
 * A reference with no mention row; why, and how a reader resolves it, is in
 * `docs/markdown-rendering.md#mentions`.
 */
export function sidekickMentionHref(sidekickId: string): string {
  return `sidekick://${sidekickId}`;
}

/** The Sidekick id a mention href names, or `undefined` when it is not one. */
export function sidekickIdFromMentionHref(href: string | undefined): string | undefined {
  return href?.match(SIDEKICK_MENTION_HREF)?.[1]?.toLowerCase();
}

/** Whether an href uses the Sidekick mention scheme at all, well-formed or not. */
export function isSidekickHref(href: string | undefined): boolean {
  return href !== undefined && /^sidekick:/iu.test(href);
}

/**
 * Matches `[@Label](sidekick://<uuid>)`. Group 1 is the label with Markdown
 * escapes intact. Fresh each call, like {@link personMentionMarkdownPattern}.
 */
export function sidekickMentionMarkdownPattern(): RegExp {
  return new RegExp(
    String.raw`\[@((?:\\.|[^\\\]])+)\]\(sidekick:\/\/(${PERSON_UUID})\)`,
    "giu",
  );
}

/**
 * Person and Sidekick mention links reduced to the `@Name` a reader saw, for
 * a one-line label such as a provisional title. Not code-aware and leaves all
 * other Markdown alone: {@link rewriteMessageAsPlainText} is the full reduction.
 */
export function mentionLinksAsText(text: string): string {
  const plain = (_match: string, label: string): string => `@${label.replace(/\\([\\[\]])/gu, "$1")}`;
  return text.replace(personMentionMarkdownPattern(), plain).replace(sidekickMentionMarkdownPattern(), plain);
}

/**
 * Per-render connector mention href — the house spelling.
 *
 * Connection mentions are not durable Markdown. The composer stores plain
 * `@Label` text plus offsets; the desktop renderer alone mints a tokened link
 * so a chip can share the person-mention path without letting hand-authored
 * `connector:` text impersonate one. Surfaces that *read* these hrefs must
 * also accept bare `connector:token:type` via {@link connectorTypeFromMentionHref}.
 */
export function connectorMentionHref(token: string, connectorType: string): string {
  return `connector://${token}:${encodeURIComponent(connectorType)}`;
}

const CONNECTOR_HREF_PATTERN = /^connector:/iu;
const CONNECTOR_MENTION_HREF_PATTERN = /^connector:(?:\/\/)?([0-9a-z]+):(.+)$/iu;
const CONNECTOR_EMBED_HREF_PATTERN = /^connector:(?:\/\/)?([a-z0-9_-]+)$/iu;

function decodedConnectorType(encoded: string | undefined): string | undefined {
  if (encoded === undefined) return undefined;
  try {
    return decodeURIComponent(encoded);
  } catch {
    // Message text is authored by people and models, so `[x](connector:%)` is a
    // reachable input. A malformed escape is simply not a connector reference.
    return undefined;
  }
}

/** Whether an href names the connector identity protocol in either accepted form. */
export function isConnectorHref(href: string | undefined): boolean {
  return href !== undefined && CONNECTOR_HREF_PATTERN.test(href);
}

/**
 * Connector type from a tokened mention href, or `undefined` when the href is
 * not this render's tokened link (forged text, wrong token, malformed escape).
 */
export function connectorTypeFromMentionHref(
  href: string | undefined,
  token: string,
): string | undefined {
  const match = href?.match(CONNECTOR_MENTION_HREF_PATTERN);
  if (!match || match[1] !== token) return undefined;
  return decodedConnectorType(match[2]);
}

/**
 * Connector type from a bare embed href (`connector://google`). Tokened mention
 * hrefs are deliberately rejected: an embed names a provider family, while a
 * mention must be validated through {@link connectorTypeFromMentionHref}.
 */
export function connectorTypeFromEmbedHref(href: string | undefined): string | undefined {
  const match = href?.match(CONNECTOR_EMBED_HREF_PATTERN);
  return decodedConnectorType(match?.[1])?.toLowerCase();
}

/**
 * Which scheme a link target names — the allowlist that decides navigation.
 *
 * Both `resource://` spellings parse. The URL style is what the guidance
 * teaches and what a future `?v=` parameter needs a slot in; the bare
 * `resource:` form is accepted so that anything already emitted keeps working.
 * Person mentions follow the same dual-accept rule with house form
 * `person://` — see {@link personMentionHref}. Connector mention chips are
 * minted at render time ({@link connectorMentionHref}) but are *not* a
 * citation scheme — they share the identity render path without entering this
 * allowlist. A `?v=` or `#fragment` is
 * stripped rather than honoured: a citation opens the current version (key
 * design decision 7), and leaving the parameter attached would only turn a
 * resolvable id into an unresolvable one.
 */
export function parseCitationHref(href: string | undefined): CitationTarget {
  if (href === undefined) return { scheme: "unknown" };
  if (/^https?:\/\//iu.test(href)) return { scheme: "external", url: href };
  if (/^person:/iu.test(href)) return { scheme: "person" };
  if (!RESOURCE_SCHEME.test(href)) return { scheme: "unknown" };
  // Stripped before the alphabet test, not after, so the test sees only the
  // opaque segment: `resource://abc?v=3` is a citation of `abc`, while
  // `resource://a/b?v=3` is not a citation at all.
  const resourceId = href.replace(RESOURCE_SCHEME, "").split(/[?#]/u, 1)[0] ?? "";
  return CITATION_ID.test(resourceId) ? { scheme: "resource", resourceId } : { scheme: "unknown" };
}

/** Which cell of the renderer matrix a target belongs to, before it is parsed. */
export type CitationScheme = CitationTarget["scheme"];

/**
 * The cell a link target dispatches to — its *prefix*, not its validity.
 *
 * `parseCitationHref` answers "what is this, if anything"; this answers "who
 * renders it". They differ on exactly one input and the difference is the whole
 * point: a malformed `resource://has space` parses as unknown, but it must still
 * reach the resource cell, because that cell is the one that knows a broken
 * citation degrades to its label text. Routed to the unknown cell instead it
 * would keep react-markdown's default — an anchor carrying a raw
 * `resource://` target into the DOM, which is the one outcome the scheme
 * allowlist exists to prevent.
 *
 * The unknown cell is deliberately not "render as text": it is where `mailto:`,
 * `tel:` and every other target the default transform already handles keep the
 * behavior they have today.
 */
export function citationScheme(href: string | undefined): CitationScheme {
  if (href === undefined) return "unknown";
  if (/^https?:\/\//iu.test(href)) return "external";
  if (/^person:/iu.test(href)) return "person";
  return RESOURCE_SCHEME.test(href) ? "resource" : "unknown";
}

/** A footnote definition that qualified as a citation under the pinned grammar. */
export interface FootnoteCitation {
  /** The link's own text — what the pill's popover names the source. */
  readonly label: string;
  readonly target: CitationTarget;
  /** Whatever plain text sat around the link, carried through with it. */
  readonly text: string;
}

export interface CitationFootnotes {
  /** Qualifying definitions, by footnote identifier, in the order defined. */
  readonly citations: ReadonlyMap<string, FootnoteCitation>;
  /** Every defined identifier's raw content, in definition order. */
  readonly definitions: ReadonlyMap<string, string>;
  /** Identifiers referenced in the body, in order of first reference. */
  readonly referenced: readonly string[];
}

/**
 * A footnote identifier as GFM matches it, and as it appears in the DOM.
 *
 * `[^Rev]` and `[^rev]` are the same footnote to the parser, and the anchor it
 * emits is lowercased either way. Keying by the raw label instead would leave
 * the renderer looking up `Rev` against an id that says `rev` and quietly
 * showing a classic footnote where a pill belonged.
 */
function normalizeFootnoteIdentifier(label: string): string {
  return label.toLowerCase();
}

/** `[^label]: content`, at the start of a line. */
const FOOTNOTE_DEFINITION = /^ {0,3}\[\^([^\]\s]+)\]:[ \t]*(.*)$/u;
/**
 * `[^label]` used in the body. Never at the head of a definition — checked first.
 *
 * Shared by the readers in this module, which use it only with `matchAll` and
 * `replace`: the first clones the regex and the second resets `lastIndex`, so
 * neither leaves state behind. **`exec` does not** — it advances `lastIndex` on
 * the regex itself, so a caller that needs one takes a fresh copy from
 * {@link footnoteReferencePattern}, which is what that factory is for.
 */
const FOOTNOTE_REFERENCE = /\[\^([^\]\s]+)\]/gu;
/**
 * The same reference, still arriving: an opening `[`, optionally the `^` and
 * however much of the identifier has been streamed, at the very end of the
 * text and with no closing bracket yet. Only a surface watching a message grow
 * has any use for this — a settled message's `[^foo` is text a model wrote and
 * stays text — but it is the same grammar as the reference above and drifting
 * from it is how one of them starts recognising a reference the other does not.
 *
 * The `^` is optional because the caret is the second character: a reader that
 * waited for it would put the opening bracket of every citation on screen for
 * one frame. What a bare `[` at the end *means* is not yet decided — a
 * citation, a link, a task list's box, a bracket in prose — so this only says
 * that the text ends mid-construct. The caller decides what to draw, and for a
 * bare `[` the honest answer is nothing.
 */
const OPEN_FOOTNOTE_REFERENCE = /\[(?:\^[^\]\s]*)?$/u;

/**
 * Matches `[^label]` wherever a reader has to find one in raw text. Capture
 * group 1 is the identifier before {@link normalizeFootnoteIdentifier}. Fresh
 * each call so a `/g` lastIndex cannot leak across callers.
 */
export function footnoteReferencePattern(): RegExp {
  return new RegExp(FOOTNOTE_REFERENCE.source, FOOTNOTE_REFERENCE.flags);
}

/**
 * Matches the trailing half of a reference whose closing bracket has not
 * arrived, down to the bare `[` that has not yet said what it opens. Anchored
 * at the end, so it answers a question only about text that is still growing.
 */
export function openFootnoteReferencePattern(): RegExp {
  return new RegExp(OPEN_FOOTNOTE_REFERENCE.source, OPEN_FOOTNOTE_REFERENCE.flags);
}

/**
 * An inline link or image, whose target group is what decides the citation.
 *
 * Deliberately as wide as the renderer's own parser, because every form this
 * misses is one the desktop draws as a chip and this module then leaves as raw
 * `resource://` syntax in an inbox — the exact leak it exists to close. So a
 * label may carry one level of balanced brackets (`[Q3 [draft] deck]`), a
 * target may be angle-bracketed, and a title may follow it: all three are
 * ordinary CommonMark that remark-gfm reads as a link, and all three used to
 * pass through the rewrite untouched.
 *
 * A destination may carry one level of balanced parentheses, which CommonMark
 * allows and Wikipedia URLs use constantly: stopping at the first `)` cut
 * `…/Function_(mathematics)` in half, and the delivered source list then named
 * a URL that goes nowhere.
 *
 * Both alternations are unambiguous on their first character — a bracket or a
 * parenthesis, or not — so neither can backtrack over a long label or target.
 */
const INLINE_LINK = /!?\[((?:[^\][]|\[[^\][]*\])*)\]\(\s*<?((?:[^\s()<>]|\([^\s()<>]*\))*)>?(?:\s+"[^"]*"|\s+'[^']*')?\s*\)/gu;

/** A non-footnote link definition, used only by the plain-text boundary. */
const REFERENCE_LINK_DEFINITION = /^ {0,3}\[((?:\\.|[^\]\\])+)\]\s*:\s*(?:<[^>\n]+>|\S+)(?:[ \t]+(?:"[^"]*"|'[^']*'|\([^)]*\)))?[ \t]*$/u;
/** Full and collapsed reference links: `[label][id]`, `[label][]`, and image forms. */
const FULL_REFERENCE_LINK = /(!?)\[((?:[^\][]|\[[^\][]*\])*)\]\[([^\]]*)\]/gu;
/** Shortcut reference links: `[label]` and `![alt]`, when a matching definition exists. */
const SHORTCUT_REFERENCE_LINK = /(!?)\[((?:[^\][]|\[[^\][]*\])*)\](?![[(])/gu;
/** A title continued onto the line after a reference-link definition. */
const REFERENCE_LINK_TITLE = /^ {0,3}(?:"[^"]*"|'[^']*'|\([^)]*\))[ \t]*$/u;
/**
 * An inline code span, as every read in this module has to agree one looks.
 *
 * One constant rather than a pattern written twice: the reference scan and the
 * rewrite disagreeing about what is code is not a visible bug in either, it is
 * a number in an email that does not match the number in the transcript.
 */
/**
 * Replaces complete inline code spans without assuming their delimiter length.
 * A run closes only on another run of exactly the same length; a longer run is
 * content, not a closing prefix. Unclosed runs stay byte-for-byte unchanged.
 */
function replaceInlineCodeSpans(
  value: string,
  replace: (span: string, content: string) => string,
): string {
  let output = "";
  let cursor = 0;
  while (cursor < value.length) {
    const opening = nextUnescapedBacktick(value, cursor);
    if (opening < 0) return output + value.slice(cursor);
    let openingEnd = opening + 1;
    while (value[openingEnd] === "`") openingEnd += 1;
    const delimiterLength = openingEnd - opening;
    let closing = openingEnd;
    let matched = false;
    while (closing < value.length) {
      closing = nextUnescapedBacktick(value, closing);
      if (closing < 0) return output + value.slice(cursor);
      let closingEnd = closing + 1;
      while (value[closingEnd] === "`") closingEnd += 1;
      if (closingEnd - closing === delimiterLength) {
        output += value.slice(cursor, opening);
        output += replace(value.slice(opening, closingEnd), value.slice(openingEnd, closing));
        cursor = closingEnd;
        matched = true;
        break;
      }
      closing = closingEnd;
    }
    if (!matched) return output + value.slice(cursor);
  }
  return output;
}

function nextUnescapedBacktick(value: string, start: number): number {
  let candidate = value.indexOf("`", start);
  while (candidate >= 0) {
    let backslashes = 0;
    for (let index = candidate - 1; index >= 0 && value[index] === "\\"; index -= 1) {
      backslashes += 1;
    }
    if (backslashes % 2 === 0) return candidate;
    candidate = value.indexOf("`", candidate + 1);
  }
  return -1;
}

/**
 * Reads a message's footnotes, and decides which of them are citations.
 *
 * The grammar is pinned rather than guessed: a definition is a citation when its
 * content is a single paragraph carrying exactly one link. Plain text around
 * the link is permitted and travels with it into the popover. Anything else — no
 * link, two links, a second block — is a footnote the author meant as a
 * footnote, and it keeps classic GFM rendering. That line is what makes the
 * degradation legible: a malformed citation reads as a normal footnote rather
 * than as a broken pill.
 *
 * A continuation line is what disqualifies a multi-block definition, and it is
 * read the way GFM reads one: indented under the definition. Nothing inside a
 * fenced block is read at all, because a message explaining this syntax is an
 * ordinary thing for Rally to write.
 */
export function citationFootnotes(markdown: string): CitationFootnotes {
  const definitions = new Map<string, string>();
  const citations = new Map<string, FootnoteCitation>();
  const referenced: string[] = [];
  const lines = markdown.replace(/\r\n/gu, "\n").split("\n");
  // Consulted only where no definition is open: inside one, an indented line is
  // the definition's own second block, which is what disqualifies it as a
  // citation — not an indented code block at the document's level.
  const code = notificationMarkdownLineKinds(lines).map(isMarkdownCode);

  /** The identifier whose definition the following indented lines continue. */
  let open: string | null = null;
  let openQuoteDepth = 0;
  for (const [index, line] of lines.entries()) {
    if (open === null && code[index]) continue;

    const contentLine = stripBlockquotePrefixes(line);
    const quoteDepth = blockquoteDepth(line);
    const definition = FOOTNOTE_DEFINITION.exec(contentLine);
    if (definition) {
      open = normalizeFootnoteIdentifier(definition[1]!);
      openQuoteDepth = quoteDepth;
      // A repeated identifier keeps the first definition, which is what a GFM
      // parser does with one; the second would otherwise silently win here and
      // disagree with what the renderer shows.
      if (!definitions.has(open)) definitions.set(open, definition[2]!);
      continue;
    }
    if (open !== null) {
      // Indented content continues the definition above; a blank line does not
      // end it, because GFM allows a blank line inside a multi-paragraph one —
      // and a definition with a second paragraph is exactly what must not
      // qualify.
      if (quoteDepth === openQuoteDepth && !contentLine.trim()) continue;
      if (quoteDepth === openQuoteDepth && /^(?: {4}|\t)/u.test(contentLine)) {
        definitions.set(open, `${definitions.get(open) ?? ""}\n\n${contentLine.trim()}`);
        continue;
      }
      open = null;
    }
    // Read with the line's code spans taken out, for the same reason the
    // rewrite skips them: a message *showing* somebody `[^1]` syntax is not
    // citing anything. Counting one there appended a source list to a message
    // that cites nothing — and, worse, took the number the first real footnote
    // was owed, so the transcript said 1 where the delivered copy said 2.
    const scannableLine = replaceInlineCodeSpans(line, () => " ");
    for (const match of scannableLine.matchAll(FOOTNOTE_REFERENCE)) {
      if (match.index !== undefined && isMarkdownEscaped(scannableLine, match.index)) continue;
      const identifier = normalizeFootnoteIdentifier(match[1]!);
      if (!referenced.includes(identifier)) referenced.push(identifier);
    }
  }

  for (const [identifier, content] of definitions) {
    const citation = asCitation(content);
    if (citation) citations.set(identifier, citation);
  }
  return { citations, definitions, referenced };
}

/** One paragraph, exactly one link — or nothing, which is a classic footnote. */
function asCitation(content: string): FootnoteCitation | null {
  if (content.includes("\n")) return null;
  const links = [...content.matchAll(INLINE_LINK)].filter((match) => {
    const opener = (match.index ?? 0) + (match[0].startsWith("!") ? 1 : 0);
    return !isMarkdownEscaped(content, opener);
  });
  if (links.length !== 1) return null;
  const [match, label = "", href = ""] = links[0]!;
  const target = parseCitationHref(href);
  if (target.scheme === "unknown") return null;
  // The words around the link, with the punctuation that only joined it to the
  // link removed: `[Deck](…), slide 4` carries "slide 4", not ", slide 4",
  // which reads as a fragment once the link is no longer beside it.
  const text = content
    .replace(match, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/^[,;:—–-]\s*/u, "")
    .trim();
  return { label, target, text };
}

/**
 * The image-syntax resource citations a message actually announces.
 *
 * The renderer turns `![Title](resource://id)` into an embed card; the chip
 * is the link form. Only the card is the "here is the document" announcement
 * the inspector auto-opens onto. This scan is the same question the rewrite
 * asks — outside code, with the same inline-link grammar — so a card the
 * desktop draws is one this function names, and a sample inside a fence or
 * a footnote definition is not. Definitions are stripped first, the way
 * the rewrite does, so `[^1]: ![Deck](resource://id)` cannot masquerade
 * as an announcement. A malformed target is omitted: the renderer degrades
 * it to label text, and there is no card to open.
 *
 * Order is document order. A caller that wants "the last one" reads the
 * last element; this does not decide which announcement wins.
 */
export function embeddedResourceCitations(markdown: string): readonly { readonly resourceId: string }[] {
  const found: { resourceId: string }[] = [];
  mapOutsideCode(stripFootnoteDefinitions(markdown), (segment) => {
    for (const match of segment.matchAll(INLINE_LINK)) {
      // An escaped bang is a chip, not a card: CommonMark renders `\![Title](…)`
      // as a literal `!` plus a link. The regex still sees the `![` substring.
      if (match.index !== undefined && match.index > 0 && segment[match.index - 1] === "\\") continue;
      if (!match[0].startsWith("!")) continue;
      const target = parseCitationHref(match[2]);
      if (target.scheme === "resource") found.push({ resourceId: target.resourceId });
    }
    return segment;
  });
  return found;
}

/**
 * Every resource a markdown body cites, without repeats: each chip
 * (`[T](resource://id)`) and card (`![T](resource://id)`) in the prose, in
 * document order, then each footnote citation the body references, in order
 * of first reference. That is every resource the renderer draws as a link. A
 * link in code or behind an escaped bracket is literal text, and a footnote
 * nothing references is never drawn, so neither counts. A merge reads this to
 * know which artifacts it shares; see docs/conversation-merge.md.
 */
export function citedResourceIds(markdown: string): string[] {
  const found: string[] = [];
  const add = (target: CitationTarget): void => {
    if (target.scheme === "resource" && !found.includes(target.resourceId)) found.push(target.resourceId);
  };
  mapOutsideCode(stripFootnoteDefinitions(markdown), (segment) => {
    for (const match of segment.matchAll(INLINE_LINK)) {
      const opener = (match.index ?? 0) + (match[0].startsWith("!") ? 1 : 0);
      if (isMarkdownEscaped(segment, opener)) continue;
      add(parseCitationHref(match[2]));
    }
    return segment;
  });
  const footnotes = citationFootnotes(markdown);
  for (const identifier of footnotes.referenced) {
    const citation = footnotes.citations.get(identifier);
    if (citation) add(citation.target);
  }
  return found;
}

/**
 * The same answer, written for a surface that renders no citations at all.
 *
 * Outbound email and Slack delivery both take agent Markdown and hand it to
 * someone else's renderer — a mail client, Slack's `markdown` block — neither of
 * which has heard of `resource://` or of footnotes. Left alone, an announcement
 * arrives as a broken image, a reference as literal bracket syntax, and a
 * grounded answer as a wall of `[^1]` markers above nothing.
 *
 * So both forms reduce to the words the model already wrote, and footnotes
 * become numbered markers over one trailing source list — the one place a
 * source list is right, because on these surfaces there is nowhere else for a
 * source to live. An external source keeps its link, which is the only way a
 * reader outside the app can follow it; an internal one is its title, since no
 * deep link into the desktop exists yet for it to become.
 *
 * The transcript copy of the same answer keeps its citations. Only what leaves
 * Rally is rewritten.
 */
export interface CitationRewriteOptions {
  /**
   * How the trailing source list is written, and whether there is one at all.
   *
   * The default, `markdown`, is for a caller that hands its output to a Markdown
   * renderer — outbound email and Slack's `markdown` block. `plain` is for one
   * that does not: Slack's `text` field is mrkdwn, which has no `**bold**` and
   * no `[label](url)`, so the Markdown form arrives there as literal syntax —
   * a different leak from the one the reduction was added to close, not none.
   * `none` reduces the body and appends nothing, for a caller with no room for
   * a bibliography: a one-line mention excerpt, an inbox preheader.
   */
  readonly sources?: "markdown" | "plain" | "none";
}

export function rewriteCitationsAsPlainText(markdown: string, options: CitationRewriteOptions = {}): string {
  const { citations, definitions, referenced } = citationFootnotes(markdown);
  // GFM's own numbering contract: a number is earned by being *referenced*, in
  // the order of first reference, and only by an identifier something defines.
  // A reference whose definition never arrived earns none and stays literal.
  const numbers = new Map<string, number>();
  for (const identifier of referenced) {
    if (definitions.has(identifier)) numbers.set(identifier, numbers.size + 1);
  }

  // Definitions come out before the rewrite, not after: the rewrite renumbers
  // `[^rev]` to `[1]` everywhere, the head of a definition line included, and a
  // definition that no longer looks like one cannot be found to remove.
  //
  // Unconditionally, too. Gating this on there being references left an
  // unreferenced definition in the delivered text with its `[^rev]:` marker
  // intact — reachable whenever a model writes a definition and then edits away
  // the sentence that cited it. GFM renders such a definition as nothing; so
  // does this. The `**Sources**` append below has its own guard.
  const source = stripFootnoteDefinitions(markdown);
  const rewritten = mapOutsideCode(source, (segment) => segment
    // `citationScheme`, not `parseCitationHref`: the question here is "is this
    // a citation", not "is this a *resolvable* citation". A malformed
    // identifier still has to be reduced — the renderer degrades it to its
    // label, and a surface with no renderer must not be the one place the raw
    // scheme shows through. Asking the strict parser instead left
    // `[the deck](resource://Q3-deck.pdf)` verbatim in an email and
    // `![Plan](resource://plans/2026)` as a broken image in a channel.
    .replace(INLINE_LINK, (match, label: string, href: string, offset: number, value: string) => {
      const opener = offset + (match.startsWith("!") ? 1 : 0);
      return !isMarkdownEscaped(value, opener) && citationScheme(href) === "resource" ? label : match;
    })
    // Only a referenced *and* defined identifier is renumbered. A reference
    // whose definition never arrived is left exactly as written, because
    // rewriting it would invent a source that does not exist.
    .replace(FOOTNOTE_REFERENCE, (match, identifier: string, offset: number, value: string) => {
      if (isMarkdownEscaped(value, offset)) return match;
      // Folded, like every other read of an identifier in this module. The
      // definitions and the source list below key on the folded form, so
      // looking up the raw capture here left `[^Q3]` in the body above a
      // source list it no longer pointed at.
      const number = numbers.get(normalizeFootnoteIdentifier(identifier));
      return number === undefined ? match : `[${number}]`;
    }));

  // `none` still reduces the body — the markers and the label text are the
  // point — and simply has nowhere to put a list. The body is returned as it
  // stands, trailing whitespace included, exactly as an uncited one is.
  if (numbers.size === 0 || options.sources === "none") return rewritten;
  const plain = options.sources === "plain";
  const body = rewritten.replace(/\s+$/u, "");
  const sources = [...numbers].map(([identifier, number]) => {
    const citation = citations.get(identifier);
    if (!citation) return `${number}. ${plainInline(definitions.get(identifier) ?? "", plain)}`;
    const source = sourceLine(citation.label, citation.target, plain);
    return `${number}. ${source}${citation.text ? ` ${citation.text}` : ""}`;
  });
  return `${body}\n\n${plain ? "Sources" : "**Sources**"}\n\n${sources.join("\n")}`;
}

/**
 * A message, written for a surface without Rally's renderer.
 *
 * Citation, person-mention, and general Markdown reduction are one outbound
 * boundary: a client that cannot draw Rally's rich text must receive the words
 * and useful structure, never the syntax behind them. Keeping the composition
 * here prevents email, Slack, and push from disagreeing about the same stored
 * message.
 */
export function rewriteMessageAsPlainText(
  markdown: string,
  options: CitationRewriteOptions = {},
): string {
  const inlineSpans: string[] = [];
  const protectedMarkdown = mapNotificationProse(
    stripPersonalSystemPrompt(markdown).split(MESSAGE_SPAN_PLACEHOLDER).join(""),
    (prose) => replaceInlineCodeSpans(prose, (_span, content) => {
      inlineSpans.push(content);
      return `${MESSAGE_SPAN_PLACEHOLDER}${inlineSpans.length - 1}${MESSAGE_SPAN_PLACEHOLDER}`;
    }),
  );
  const references = mapOutsideCode(rewriteCitationsAsPlainText(protectedMarkdown, options), mentionLinksAsText);
  return markdownFormattingAsPlainText(references).replace(
    new RegExp(`${MESSAGE_SPAN_PLACEHOLDER}(\\d+)${MESSAGE_SPAN_PLACEHOLDER}`, "gu"),
    (_match, index: string) => inlineSpans[Number(index)] ?? "",
  );
}

/** Markdown structure reduced to readable plain text without flattening it. */
function markdownFormattingAsPlainText(markdown: string): string {
  const inlineSpans: string[] = [];
  const references = rewriteReferenceLinksAsPlainText(markdown);
  const parkedMarkdown = mapNotificationProse(
    references.split(MULTILINE_SPAN_PLACEHOLDER).join(""),
    (prose) => replaceInlineCodeSpans(prose, (_span, content) => {
      inlineSpans.push(content);
      return `${MULTILINE_SPAN_PLACEHOLDER}${inlineSpans.length - 1}${MULTILINE_SPAN_PLACEHOLDER}`;
    }),
  );
  const lines: string[] = [];
  const source = parkedMarkdown.replace(/\r\n/gu, "\n").split("\n");
  const kinds = notificationMarkdownLineKinds(source);
  let fenceQuoteDepth = 0;
  let fenceListIndent = 0;
  for (let index = 0; index < source.length; index += 1) {
    const raw = source[index]!;
    const kind = kinds[index]!;
    if (kind === "fence-open") {
      fenceQuoteDepth = blockquoteDepth(raw);
      fenceListIndent = listFenceOpening(stripBlockquotePrefixes(raw))?.contentIndent ?? 0;
      continue;
    }
    if (kind === "fence-close") {
      fenceQuoteDepth = 0;
      fenceListIndent = 0;
      continue;
    }
    if (kind === "fence-content") {
      const content = stripListContinuationIndent(
        stripBlockquotePrefixes(raw, fenceQuoteDepth),
        fenceListIndent,
      );
      lines.push(`    ${content.trimEnd()}`);
      continue;
    }
    if (kind === "indented-code") {
      lines.push(stripBlockquotePrefixes(raw).trimEnd());
      continue;
    }
    const line = stripBlockquotePrefixes(raw.trimEnd());
    if (/^ {0,3}(?:=+|-+)\s*$/u.test(line)
      && index > 0
      && kinds[index - 1] === "prose"
      && source[index - 1]!.trim()) {
      continue;
    }
    if (/^ {0,3}(?:[-*_]\s*){3,}$/u.test(line)) {
      continue;
    }
    const heading = /^ {0,3}(#{1,6})\s+(.*?)(?:\s+#+)?$/u.exec(line);
    if (heading) {
      lines.push(stripInlineMarkdown(heading[2]!));
      continue;
    }
    const bullet = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/u.exec(line);
    if (bullet) {
      const indent = " ".repeat(markdownIndentWidth(bullet[1]!));
      const marker = /\d/u.test(bullet[2]!) ? bullet[2]! : "-";
      const item = bullet[3]!.replace(/^\[([ xX])\]\s*/u, (_match, checked: string) =>
        (checked === " " ? "☐ " : "☑ "));
      const itemLines = [item];
      const quoteDepth = blockquoteDepth(raw);
      while (index + 1 < source.length && kinds[index + 1] === "prose") {
        const nextRaw = source[index + 1]!;
        const next = stripBlockquotePrefixes(nextRaw.trimEnd());
        if (!next.trim()
          || blockquoteDepth(nextRaw) !== quoteDepth
          || /^(\s*)(?:[-*+]|\d{1,3}[.)])\s+/u.test(next)) break;
        itemLines.push(next);
        index += 1;
      }
      const reduced = stripInlineMarkdown(itemLines.join("\n")).split("\n");
      lines.push(`${indent}${marker} ${reduced[0] ?? ""}`);
      lines.push(...reduced.slice(1));
      continue;
    }
    const paragraph = [line];
    const quoteDepth = blockquoteDepth(raw);
    while (index + 1 < source.length && kinds[index + 1] === "prose") {
      const nextRaw = source[index + 1]!;
      const next = stripBlockquotePrefixes(nextRaw.trimEnd());
      if (!next.trim()
        || blockquoteDepth(nextRaw) !== quoteDepth
        || isMarkdownBlockStart(next)) break;
      paragraph.push(next);
      index += 1;
    }
    lines.push(...stripInlineMarkdown(paragraph.join("\n")).split("\n"));
  }
  return lines.join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .replace(/^\n+|\n+$/gu, "")
    .replace(
      new RegExp(`${MULTILINE_SPAN_PLACEHOLDER}(\\d+)${MULTILINE_SPAN_PLACEHOLDER}`, "gu"),
      (_match, index: string) => inlineSpans[Number(index)] ?? "",
    );
}

/**
 * Reduces reference-style links after collecting their definitions.
 *
 * A reference is syntax only when its normalized label has a definition. This
 * keeps ordinary bracketed prose intact while giving full, collapsed, and
 * shortcut links the same label-only result as an inline link. Definitions and
 * references inside code remain literal.
 */
function rewriteReferenceLinksAsPlainText(markdown: string): string {
  const inlineSpans: string[] = [];
  const protectedMarkdown = mapNotificationProse(
    markdown.replace(/\r\n/gu, "\n").split(REFERENCE_SPAN_PLACEHOLDER).join(""),
    (prose) => replaceInlineCodeSpans(prose, (span) => {
      inlineSpans.push(span);
      return `${REFERENCE_SPAN_PLACEHOLDER}${inlineSpans.length - 1}${REFERENCE_SPAN_PLACEHOLDER}`;
    }),
  );
  const source = protectedMarkdown.split("\n");
  const kinds = notificationMarkdownLineKinds(source);
  const definitions = new Set<string>();
  const definitionLines = new Set<number>();
  for (const [index, line] of source.entries()) {
    if (isMarkdownCode(kinds[index]!)) continue;
    const definition = REFERENCE_LINK_DEFINITION.exec(stripBlockquotePrefixes(line));
    if (!definition || definition[1]!.startsWith("^")) continue;
    definitions.add(normalizeReferenceIdentifier(definition[1]!));
    definitionLines.add(index);
    const nextLine = source[index + 1] ?? "";
    if (blockquoteDepth(nextLine) === blockquoteDepth(line)
      && REFERENCE_LINK_TITLE.test(stripBlockquotePrefixes(nextLine))) {
      definitionLines.add(index + 1);
    }
  }
  if (definitions.size === 0) return restoreReferenceSpans(protectedMarkdown, inlineSpans);
  const withoutDefinitions = source
    .filter((_line, index) => !definitionLines.has(index))
    .join("\n");
  const rewritten = mapOutsideCode(withoutDefinitions, (prose) => prose
    .replace(FULL_REFERENCE_LINK, (match, image: string, label: string, identifier: string, offset: number, value: string) => {
      if (isMarkdownEscaped(value, offset + image.length)) return match;
      const reference = identifier || label;
      return definitions.has(normalizeReferenceIdentifier(reference)) ? label : match;
    })
    .replace(SHORTCUT_REFERENCE_LINK, (match, image: string, label: string, offset: number, value: string) =>
      !isMarkdownEscaped(value, offset + image.length) && definitions.has(normalizeReferenceIdentifier(label))
        ? label
        : match));
  return restoreReferenceSpans(rewritten, inlineSpans);
}

function restoreReferenceSpans(value: string, spans: readonly string[]): string {
  return value.replace(
    new RegExp(`${REFERENCE_SPAN_PLACEHOLDER}(\\d+)${REFERENCE_SPAN_PLACEHOLDER}`, "gu"),
    (_match, index: string) => spans[Number(index)] ?? "",
  );
}

function isMarkdownBlockStart(line: string): boolean {
  return /^ {0,3}(?:#{1,6}\s|(?:[-*_]\s*){3,}$|(?:[-*+]|\d{1,3}[.)])\s+)/u.test(line);
}

function normalizeReferenceIdentifier(value: string): string {
  return value.replace(/\\([\\`*_[\]{}()#+.!|>~-])/gu, "$1").trim().replace(/\s+/gu, " ").toLowerCase();
}

function markdownIndentWidth(value: string): number {
  return [...value].reduce((width, character) => width + (character === "\t" ? 4 : 1), 0);
}

function isMarkdownEscaped(value: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === "\\"; cursor -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

function stripInlineMarkdown(value: string): string {
  const spans: string[] = [];
  const parked = replaceInlineCodeSpans(value.split(SPAN_PLACEHOLDER).join(""), (_span, content) => {
    spans.push(content);
    return `${SPAN_PLACEHOLDER}${spans.length - 1}${SPAN_PLACEHOLDER}`;
  });
  const escaped = parked.replace(/\\([\\`*_[\]{}()#+.!|>~-])/gu, (_match, character: string) => {
    spans.push(character);
    return `${SPAN_PLACEHOLDER}${spans.length - 1}${SPAN_PLACEHOLDER}`;
  });
  return escaped
    .replace(INLINE_LINK, (match, label: string, href: string) => (match.startsWith("!") ? label || href : label))
    .replace(/<br\s*\/?>/giu, "\n")
    .replace(/<((?:https?:\/\/|mailto:)[^>]+)>/giu, "$1")
    .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/gu, "$1")
    .replace(/(^|[^\p{L}\p{N}])__(?=\S)([\s\S]*?\S)__(?=$|[^\p{L}\p{N}])/gu, "$1$2")
    .replace(/(^|[^\p{L}\p{N}])\*(?=\S)([\s\S]*?\S)\*(?=$|[^\p{L}\p{N}])/gu, "$1$2")
    .replace(/(^|[^\p{L}\p{N}_])_(?=\S)([\s\S]*?\S)_(?=$|[^\p{L}\p{N}_])/gu, "$1$2")
    .replace(/~~(?=\S)([^~]*?\S)~~/gu, "$1")
    .replace(
      new RegExp(`${SPAN_PLACEHOLDER}(\\d+)${SPAN_PLACEHOLDER}`, "gu"),
      (_match, index: string) => spans[Number(index)] ?? "",
    )
    .trimEnd();
}

/**
 * One source, named so a reader can follow it on the surface it lands on.
 *
 * An external source has to carry its URL — it is the only way a reader outside
 * Rally reaches it — and the two shapes below are the same fact written for a
 * renderer that reads Markdown links and one that does not.
 */
function sourceLine(label: string, target: CitationTarget, plain: boolean): string {
  if (target.scheme !== "external") return label;
  return plain ? `${label} — ${target.url}` : `[${label}](${target.url})`;
}

/** The definitions themselves, now that their content lives in the source list. */
function stripFootnoteDefinitions(markdown: string): string {
  const lines = markdown.replace(/\r\n/gu, "\n").split("\n");
  const code = notificationMarkdownLineKinds(lines).map(isMarkdownCode);
  const kept: string[] = [];
  let dropping = false;
  let definitionQuoteDepth = 0;
  for (const [index, line] of lines.entries()) {
    // Same rule as the scan: a `[^1]:` line inside code is the syntax being
    // shown, not a definition to remove.
    if (!dropping && code[index]) {
      kept.push(line);
      continue;
    }
    const contentLine = stripBlockquotePrefixes(line);
    const quoteDepth = blockquoteDepth(line);
    if (FOOTNOTE_DEFINITION.test(contentLine)) {
      dropping = true;
      definitionQuoteDepth = quoteDepth;
      continue;
    }
    if (dropping) {
      if (quoteDepth === definitionQuoteDepth
        && (!contentLine.trim() || /^(?: {4}|\t)/u.test(contentLine))) continue;
      dropping = false;
    }
    kept.push(line);
  }
  return kept.join("\n");
}

/** A footnote's own words, with the marks a plain list would show verbatim removed. */
function plainInline(content: string, plain: boolean): string {
  return content
    .replace(INLINE_LINK, (match, label: string, href: string, offset: number, value: string) => {
      const opener = offset + (match.startsWith("!") ? 1 : 0);
      if (isMarkdownEscaped(value, opener)) return match;
      const target = parseCitationHref(href);
      if (target.scheme !== "external") return label;
      return plain ? sourceLine(label, target, true) : match;
    })
    .trim();
}

/**
 * The placeholder a parked code span leaves behind while the rewrite runs.
 *
 * It is interpolated into a `RegExp` below, so whatever stands here has to be
 * inert in a pattern as well as absent from the input. NUL is both; a character
 * that means something in a regex would compile into a pattern matching more
 * than the placeholder it stands in for.
 *
 * "Absent from the input" is enforced rather than assumed: `mapOutsideCode`
 * strips any NUL the line already carried before it parks the first span, so a
 * model writing one cannot forge a placeholder and splice in a span of its own.
 */
const SPAN_PLACEHOLDER = "\u0000";
/** A separate placeholder for code spans parked across prose line boundaries. */
const MULTILINE_SPAN_PLACEHOLDER = "\u0001";
/** Reference scanning parks spans separately so a definition-shaped code line stays literal. */
const REFERENCE_SPAN_PLACEHOLDER = "\u0002";
/** The outer boundary protects inline code before citation and footnote scans run. */
const MESSAGE_SPAN_PLACEHOLDER = "\u0003";

/**
 * Applies a rewrite to everything except code.
 *
 * A message that teaches this syntax — a Rally answer explaining how to cite
 * something, which is an ordinary thing for it to be asked — shows the citation
 * inside a fence, an indented block, or a span. Rewriting that would delete the
 * very thing being shown, and it is the one input where the rewrite is
 * certainly wrong. Whole lines are [`markdown-code.ts`](markdown-code.ts)'s
 * business — shared so that no rewriter in the repository can disagree with
 * another about where a block ends; this adds the spans, which stay here
 * because parking one inside a line is not the same operation as splitting
 * prose at one.
 *
 * Inline spans are parked whole, the way the email renderer parks them, behind a
 * character the input cannot contain: it is stripped from the line first, so a
 * model writing a NUL cannot forge a placeholder and splice a span of its own
 * choosing back in.
 */
function mapOutsideCode(markdown: string, rewrite: (segment: string) => string): string {
  return mapNotificationProse(markdown.replace(/\r\n/gu, "\n"), (prose) => {
    const spans: string[] = [];
    const parked = replaceInlineCodeSpans(prose.split(SPAN_PLACEHOLDER).join(""), (span) => {
      spans.push(span);
      return `${SPAN_PLACEHOLDER}${spans.length - 1}${SPAN_PLACEHOLDER}`;
    });
    return rewrite(parked).replace(
      new RegExp(`${SPAN_PLACEHOLDER}(\\d+)${SPAN_PLACEHOLDER}`, "gu"),
      (_match, index: string) => spans[Number(index)] ?? "",
    );
  });
}

function mapNotificationProse(markdown: string, rewrite: (prose: string) => string): string {
  const lines = markdown.split("\n");
  const kinds = notificationMarkdownLineKinds(lines);
  const runs: string[] = [];
  let run: string[] = [];
  let prose = true;
  for (const [index, line] of lines.entries()) {
    const lineIsProse = !isMarkdownCode(kinds[index]!);
    if (lineIsProse !== prose && run.length > 0) {
      runs.push(prose ? rewrite(run.join("\n")) : run.join("\n"));
      run = [];
    }
    prose = lineIsProse;
    run.push(line);
  }
  if (run.length > 0) runs.push(prose ? rewrite(run.join("\n")) : run.join("\n"));
  return runs.join("\n");
}

/**
 * The shared code classifier applied after removing blockquote containers.
 *
 * A fenced example remains code when it is quoted. Keeping this adaptation at
 * the notification boundary avoids changing structural consumers that need the
 * raw container markers to build their own rendered block tree.
 */
function notificationMarkdownLineKinds(lines: readonly string[]) {
  let activeListFence: { readonly contentIndent: number; readonly delimiter: string } | null = null;
  const normalized = lines.map((raw) => {
    const line = stripBlockquotePrefixes(raw);
    if (activeListFence) {
      const content = stripListContinuationIndent(line, activeListFence.contentIndent);
      const closing = /^ {0,3}(`{3,}|~{3,})/u.exec(content)?.[1];
      if (closing?.startsWith(activeListFence.delimiter[0]!)
        && closing.length >= activeListFence.delimiter.length) activeListFence = null;
      return content;
    }
    const opening = listFenceOpening(line);
    if (!opening) return line;
    activeListFence = { contentIndent: opening.contentIndent, delimiter: opening.delimiter };
    return opening.content;
  });
  return markdownLineKinds(normalized);
}

function listFenceOpening(line: string): {
  readonly content: string;
  readonly contentIndent: number;
  readonly delimiter: string;
} | null {
  const match = /^(\s*)(?:[-+*]|\d{1,3}[.)])([ \t]+)(`{3,}|~{3,})(.*)$/u.exec(line);
  if (!match) return null;
  const delimiter = match[3]!;
  if (delimiter.startsWith("`") && match[4]!.includes("`")) return null;
  return {
    content: `${delimiter}${match[4]!}`,
    contentIndent: match[0]!.indexOf(delimiter),
    delimiter,
  };
}

function stripListContinuationIndent(line: string, width: number): string {
  let index = 0;
  let removed = 0;
  while (index < line.length && removed < width) {
    if (line[index] === " ") {
      removed += 1;
      index += 1;
      continue;
    }
    if (line[index] === "\t") {
      removed += 4;
      index += 1;
      continue;
    }
    break;
  }
  return removed >= width ? line.slice(index) : line;
}

function blockquoteDepth(line: string): number {
  let depth = 0;
  let rest = line;
  while (depth < line.length) {
    const prefix = /^ {0,3}>[ \t]?/u.exec(rest)?.[0];
    if (!prefix) return depth;
    depth += 1;
    rest = rest.slice(prefix.length);
  }
  return depth;
}

function stripBlockquotePrefixes(line: string, maximum = Number.POSITIVE_INFINITY): string {
  let depth = 0;
  let rest = line;
  while (depth < maximum) {
    const prefix = /^ {0,3}>[ \t]?/u.exec(rest)?.[0];
    if (!prefix) break;
    depth += 1;
    rest = rest.slice(prefix.length);
  }
  return rest;
}
