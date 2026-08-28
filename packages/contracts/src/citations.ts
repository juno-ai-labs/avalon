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
  | { readonly scheme: "person" }
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

const RESOURCE_SCHEME = /^resource:(?:\/\/)?/u;

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
  if (/^person:/iu.test(href)) return { scheme: "person" };
  if (/^connector:/u.test(href)) return { scheme: "connector" };
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
 * The label alternation is unambiguous on its first character — a bracket or
 * not — so it cannot backtrack over a long label.
 */
const INLINE_LINK = /!?\[((?:[^\][]|\[[^\][]*\])*)\]\(\s*<?([^\s)<>]*)>?(?:\s+"[^"]*"|\s+'[^']*')?\s*\)/gu;
const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})/u;
/**
 * An inline code span, as every read in this module has to agree one looks.
 *
 * One constant rather than a pattern written twice: the reference scan and the
 * rewrite disagreeing about what is code is not a visible bug in either, it is
 * a number in an email that does not match the number in the transcript.
 */
const INLINE_CODE_SPAN = /`[^`\n]+`/gu;

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
    // Read with the line's code spans taken out, for the same reason the
    // rewrite skips them: a message *showing* somebody `[^1]` syntax is not
    // citing anything. Counting one there appended a source list to a message
    // that cites nothing — and, worse, took the number the first real footnote
    // was owed, so the transcript said 1 where the delivered copy said 2.
    for (const match of line.replace(INLINE_CODE_SPAN, " ").matchAll(FOOTNOTE_REFERENCE)) {
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
  const links = [...content.matchAll(INLINE_LINK)];
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
    .replace(INLINE_LINK, (match, label: string, href: string) =>
      (citationScheme(href) === "resource" ? label : match))
    // Only a referenced *and* defined identifier is renumbered. A reference
    // whose definition never arrived is left exactly as written, because
    // rewriting it would invent a source that does not exist.
    .replace(FOOTNOTE_REFERENCE, (match, identifier: string) => {
      // Folded, like every other read of an identifier in this module. The
      // definitions and the source list below key on the folded form, so
      // looking up the raw capture here left `[^Q3]` in the body above a
      // source list it no longer pointed at.
      const number = numbers.get(normalizeFootnoteIdentifier(identifier));
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
 *
 * The fence tracking is deliberately looser than CommonMark: a closing fence is
 * any run of the opener's character at least as long, whatever follows it, where
 * the spec wants the rest of the line bare. Reaching the difference means
 * writing ```` ```more ```` inside a fenced block, and erring loose fails in the
 * safe direction — a line wrongly read as code is left alone, never rewritten.
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
    const parked = line.split(SPAN_PLACEHOLDER).join("").replace(INLINE_CODE_SPAN, (span) => {
      spans.push(span);
      return `${SPAN_PLACEHOLDER}${spans.length - 1}${SPAN_PLACEHOLDER}`;
    });
    return rewrite(parked).replace(
      new RegExp(`${SPAN_PLACEHOLDER}(\\d+)${SPAN_PLACEHOLDER}`, "gu"),
      (_match, index: string) => spans[Number(index)] ?? "",
    );
  }).join("\n");
}
