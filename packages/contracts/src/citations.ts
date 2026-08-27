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
 * This module is the half of that protocol which is not React. It holds three
 * things, shared rather than reimplemented, because the three consumers
 * disagreeing about what a citation *is* would be invisible until somebody read
 * an email:
 *
 * - **`parseCitationHref`** — the scheme allowlist. Its answer decides whether
 *   something navigates, and to where.
 * - **`citationFootnotes`** — the pinned definition grammar. Exactly one link in
 *   one paragraph is a citation; anything else is a footnote, and stays one.
 * - **`rewriteCitationsAsPlainText`** — what Rally's two non-renderer delivery
 *   surfaces, outbound email and Slack, send instead. Both render agent Markdown
 *   with no renderer of ours in the path, so without this an announcement
 *   arrives as a broken image and a grounded answer as a page of `[^1]` markers.
 */

/** A citation target, once the scheme allowlist has decided what it is. */
export type CitationTarget =
  /** Something inside Rally: opens the resource rail, under the viewer's own authorization. */
  | { readonly scheme: "resource"; readonly resourceId: string }
  /** A real web address: opens in the system browser through the sanctioned path. */
  | { readonly scheme: "external"; readonly url: string }
  /** An identity. Named, rendered, and — deliberately — never navigable. */
  | { readonly scheme: "person"; readonly personId: string }
  | { readonly scheme: "connector" }
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

/**
 * How long an identifier may be. **Open — set to the value at which the guard
 * changes nothing, and the number is the team's to choose**, per
 * `docs/adding-security-defensive-and-other-limits.md`.
 *
 * What a bound would contain: a model writing an enormous run of safe
 * characters into a citation target. The arithmetic for choosing one is that
 * nothing here is quadratic and nothing is retained — an over-long id fails to
 * resolve and renders as its label text, at the cost of one failed lookup — so
 * the honest read is that this guard has no work to do until an id is used as a
 * cache key or a URL somebody else parses. It is defined rather than omitted
 * because the resource system's identifiers are about to change shape, and the
 * place to bound them should already exist when they do.
 */
const CITATION_ID_MAX_LENGTH = Number.POSITIVE_INFINITY;

const RESOURCE_SCHEME = /^resource:(?:\/\/)?/u;
const PERSON_SCHEME = /^person:([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/iu;

/**
 * Which scheme a link target names — the allowlist that decides navigation.
 *
 * Both `resource://` spellings parse. The URL style is what the guidance
 * teaches and what a future `?v=` parameter needs a slot in; the bare
 * `resource:` form matches the house style of `person:` and is accepted so that
 * anything already emitted keeps working. A `?v=` or `#fragment` is stripped
 * rather than honoured: a citation opens the current version (key design
 * decision 7), and leaving the parameter attached would only turn a resolvable
 * id into an unresolvable one.
 */
export function parseCitationHref(href: string | undefined): CitationTarget {
  if (href === undefined) return { scheme: "unknown" };
  if (/^https?:\/\//iu.test(href)) return { scheme: "external", url: href };
  const person = PERSON_SCHEME.exec(href);
  if (person) return { scheme: "person", personId: person[1]!.toLowerCase() };
  if (/^connector:/u.test(href)) return { scheme: "connector" };
  if (!RESOURCE_SCHEME.test(href)) return { scheme: "unknown" };
  const resourceId = href.replace(RESOURCE_SCHEME, "").split(/[?#]/u, 1)[0] ?? "";
  return resourceId.length <= CITATION_ID_MAX_LENGTH && CITATION_ID.test(resourceId)
    ? { scheme: "resource", resourceId }
    : { scheme: "unknown" };
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
  if (/^connector:/u.test(href)) return "connector";
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
  /** Identifiers whose definition exists but is not a citation — classic footnotes. */
  readonly plain: readonly string[];
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
/** `[^label]` used in the body. Never at the head of a definition — checked first. */
const FOOTNOTE_REFERENCE = /\[\^([^\]\s]+)\]/gu;
/** An inline link, whose target group is what decides the citation. */
const INLINE_LINK = /!?\[([^\][]*)\]\(([^\s)]*)\)/gu;
const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})/u;

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
  const plain: string[] = [];
  const referenced: string[] = [];
  const lines = markdown.replace(/\r\n/gu, "\n").split("\n");

  let fence: string | null = null;
  /** The identifier whose definition the following indented lines continue. */
  let open: string | null = null;
  for (const line of lines) {
    const fenceMark = FENCE_LINE.exec(line)?.[1];
    if (fence !== null) {
      if (fenceMark?.startsWith(fence[0]!) && fenceMark.length >= fence.length) fence = null;
      continue;
    }
    if (fenceMark) {
      fence = fenceMark;
      open = null;
      continue;
    }

    const definition = FOOTNOTE_DEFINITION.exec(line);
    if (definition) {
      open = normalizeFootnoteIdentifier(definition[1]!);
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
      if (!line.trim()) continue;
      if (/^(?: {4}|\t)/u.test(line)) {
        definitions.set(open, `${definitions.get(open) ?? ""}\n\n${line.trim()}`);
        continue;
      }
      open = null;
    }
    for (const match of line.matchAll(FOOTNOTE_REFERENCE)) {
      const identifier = normalizeFootnoteIdentifier(match[1]!);
      if (!referenced.includes(identifier)) referenced.push(identifier);
    }
  }

  for (const [identifier, content] of definitions) {
    const citation = asCitation(content);
    if (citation) citations.set(identifier, citation);
    else plain.push(identifier);
  }
  return { citations, plain, definitions, referenced };
}

/** One paragraph, exactly one link — or nothing, which is a classic footnote. */
function asCitation(content: string): FootnoteCitation | null {
  if (content.includes("\n")) return null;
  const links = [...content.matchAll(INLINE_LINK)];
  if (links.length !== 1) return null;
  const [match, label = "", href = ""] = links[0]!;
  const target = parseCitationHref(href);
  if (target.scheme === "unknown") return null;
  return { label, target, text: content.replace(match, "").trim() };
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
export function rewriteCitationsAsPlainText(markdown: string): string {
  const { citations, definitions, referenced } = citationFootnotes(markdown);
  const numbers = new Map<string, number>();
  for (const identifier of referenced) {
    if (definitions.has(identifier)) numbers.set(identifier, numbers.size + 1);
  }

  // Definitions come out before the rewrite, not after: the rewrite renumbers
  // `[^rev]` to `[1]` everywhere, the head of a definition line included, and a
  // definition that no longer looks like one cannot be found to remove.
  const source = numbers.size === 0 ? markdown : stripFootnoteDefinitions(markdown);
  const rewritten = mapOutsideCode(source, (segment) => segment
    .replace(INLINE_LINK, (match, label: string, href: string) =>
      (parseCitationHref(href).scheme === "resource" ? label : match))
    // Only a referenced *and* defined identifier is renumbered. A reference
    // whose definition never arrived is left exactly as written, because
    // rewriting it would invent a source that does not exist.
    .replace(FOOTNOTE_REFERENCE, (match, identifier: string) => {
      const number = numbers.get(identifier);
      return number === undefined ? match : `[${number}]`;
    }));

  if (numbers.size === 0) return rewritten;
  const body = rewritten.replace(/\s+$/u, "");
  const sources = [...numbers].map(([identifier, number]) => {
    const citation = citations.get(identifier);
    if (!citation) return `${number}. ${plainInline(definitions.get(identifier) ?? "")}`;
    const source = citation.target.scheme === "external"
      ? `[${citation.label}](${citation.target.url})`
      : citation.label;
    return `${number}. ${source}${citation.text ? ` ${citation.text}` : ""}`;
  });
  return `${body}\n\n**Sources**\n\n${sources.join("\n")}`;
}

/** The definitions themselves, now that their content lives in the source list. */
function stripFootnoteDefinitions(markdown: string): string {
  const kept: string[] = [];
  let fence: string | null = null;
  let dropping = false;
  for (const line of markdown.replace(/\r\n/gu, "\n").split("\n")) {
    const fenceMark = FENCE_LINE.exec(line)?.[1];
    if (fence !== null) {
      if (fenceMark?.startsWith(fence[0]!) && fenceMark.length >= fence.length) fence = null;
      kept.push(line);
      continue;
    }
    if (fenceMark) {
      fence = fenceMark;
      dropping = false;
      kept.push(line);
      continue;
    }
    if (FOOTNOTE_DEFINITION.test(line)) {
      dropping = true;
      continue;
    }
    if (dropping) {
      if (!line.trim() || /^(?: {4}|\t)/u.test(line)) continue;
      dropping = false;
    }
    kept.push(line);
  }
  return kept.join("\n");
}

/** A footnote's own words, with the marks a plain list would show verbatim removed. */
function plainInline(content: string): string {
  return content
    .replace(INLINE_LINK, (match, label: string, href: string) =>
      (parseCitationHref(href).scheme === "external" ? match : label))
    .trim();
}

/** The placeholder a parked code span leaves behind while the rewrite runs. */
const SPAN_PLACEHOLDER = "\u0000";

/**
 * Applies a rewrite to everything except code.
 *
 * A message that teaches this syntax — a Rally answer explaining how to cite
 * something, which is an ordinary thing for it to be asked — shows the citation
 * inside a fence or a span. Rewriting that would delete the very thing being
 * shown, and it is the one input where the rewrite is certainly wrong.
 *
 * Inline spans are parked whole, the way the email renderer parks them, behind a
 * character the input cannot contain: it is stripped from the line first, so a
 * model writing a NUL cannot forge a placeholder and splice a span of its own
 * choosing back in.
 */
function mapOutsideCode(markdown: string, rewrite: (segment: string) => string): string {
  const lines = markdown.replace(/\r\n/gu, "\n").split("\n");
  let fence: string | null = null;
  return lines.map((line) => {
    const fenceMark = FENCE_LINE.exec(line)?.[1];
    if (fence !== null) {
      if (fenceMark?.startsWith(fence[0]!) && fenceMark.length >= fence.length) fence = null;
      return line;
    }
    if (fenceMark) {
      fence = fenceMark;
      return line;
    }
    const spans: string[] = [];
    const parked = line.split(SPAN_PLACEHOLDER).join("").replace(/`[^`\n]+`/gu, (span) => {
      spans.push(span);
      return `${SPAN_PLACEHOLDER}${spans.length - 1}${SPAN_PLACEHOLDER}`;
    });
    return rewrite(parked).replace(
      new RegExp(`${SPAN_PLACEHOLDER}(\\d+)${SPAN_PLACEHOLDER}`, "gu"),
      (_match, index: string) => spans[Number(index)] ?? "",
    );
  }).join("\n");
}
