import { rewriteCitationsAsPlainText } from "@rally/contracts/citations";
import { normalizeModelMarkdown, normalizeModelText } from "@rally/contracts/model-markdown";

import { escapeHtml } from "./resend";

/**
 * The Markdown a model wrote, rendered into the HTML a mail client will
 * actually show.
 *
 * Every email Avalon sends carries model-authored Markdown — a digest, an
 * automation's result — and a mail client renders none of it. The text has to
 * become real elements here or the reader gets `## Heading` and `**bold**` on
 * screen, which is what an automation result looked like before this was
 * shared.
 *
 * The renderer is deliberately small rather than a library. Mail clients ignore
 * most of what a general renderer emits, and rendering raw HTML would mean
 * rendering model output into an email. This covers the subset these emails
 * use, escapes everything before a single tag is added, and only ever emits an
 * `href` it built itself. What it does not understand — a table, a fenced
 * block — is kept verbatim inside a `<pre>` rather than flattened into a
 * paragraph, because a briefing's table read as one run-on line of pipes is
 * worse than a plain one.
 *
 * Styling is inline and dark. Not because the app has one appearance — it ships
 * four themes and two of them are light — but because a mail client cannot tell
 * this renderer which one the reader chose, so the email is rendered in the
 * shipped default, stated on the elements themselves: a client will strip a
 * `<style>` block, and several rewrite a page that declares a light scheme. A
 * light variant behind `prefers-color-scheme` is the open question, not a
 * decision this file has already settled.
 */

/** The application's palette, so the email and the app are the same product. */
export const COLOR = {
  canvas: "#111210",
  surface: "#1d1e1b",
  surfaceRaised: "#22231f",
  line: "#32332e",
  lineSoft: "#292a26",
  ink: "#ecebe5",
  inkSoft: "#cac9c2",
  muted: "#94948c",
  mutedDeep: "#706f69",
  brand: "#cedc00",
  onBrand: "#141507",
} as const;

const TITLE_STYLE = `margin:28px 0 14px;font-size:21px;line-height:1.25;font-weight:700;letter-spacing:-.02em;color:${COLOR.ink}`;
const SECTION_STYLE = `margin:30px 0 12px;padding:0 0 0 12px;border-left:3px solid ${COLOR.brand};font-size:17px;line-height:1.3;font-weight:700;color:${COLOR.ink};letter-spacing:-.01em`;
const SUBSECTION_STYLE = `margin:22px 0 8px;font-size:13px;line-height:1.4;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:${COLOR.muted}`;
const PARAGRAPH_STYLE = `margin:0 0 13px;font-size:15px;line-height:1.65;color:${COLOR.inkSoft}`;
const LIST_STYLE = `margin:0 0 16px;padding-left:20px;font-size:15px;line-height:1.6;color:${COLOR.inkSoft}`;
const LIST_ITEM_STYLE = "margin:0 0 9px;padding-left:3px";
const NESTED_LIST_STYLE = `margin:9px 0 0;padding-left:18px;font-size:14px;line-height:1.55;color:${COLOR.muted}`;
const QUOTE_STYLE = `margin:0 0 16px;padding:12px 16px;background:${COLOR.surfaceRaised};border-left:3px solid ${COLOR.mutedDeep};border-radius:0 8px 8px 0;font-size:14px;line-height:1.6;color:${COLOR.muted}`;
const PRE_STYLE = `margin:0 0 16px;padding:14px 16px;background:${COLOR.surfaceRaised};border:1px solid ${COLOR.line};border-radius:8px;overflow-x:auto;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;line-height:1.5;color:${COLOR.inkSoft}`;
const CODE_STYLE = `padding:2px 6px;border-radius:5px;background:${COLOR.surfaceRaised};border:1px solid ${COLOR.line};font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;color:${COLOR.inkSoft}`;
export const RULE_STYLE = `border:0;border-top:1px solid ${COLOR.lineSoft};margin:26px 0`;

interface ListItem {
  /** Columns of leading whitespace, resolved against the list's own base. */
  indent: number;
  /** Whether this item's own marker was `1.`/`1)` rather than `-`, `*`, or `+`. */
  ordered: boolean;
  text: string;
}

interface Block {
  kind: "heading" | "paragraph" | "list" | "quote" | "rule" | "preformatted";
  level?: number;
  lines: string[];
  items?: ListItem[];
}

/** A tab is an indent, not one column — a sub-bullet may be written with either. */
function indentWidth(value: string): number {
  return [...value].reduce((width, character) => width + (character === "\t" ? 4 : 1), 0);
}

export function markdownToEmailHtml(markdown: string): string {
  // Every body this renders today is a model's words — a digest, an automation
  // result — so the TeX repair applies unconditionally. An email that one day
  // carries a person's words verbatim needs an opt-out here first, the way
  // `MarkdownBody` grew one for the human bubble.
  return blocksFromMarkdown(forEmail(markdown)).map(renderBlock).join("\n");
}

/**
 * A model's Markdown, made safe for a surface with no renderer of ours in it.
 *
 * Citations first, TeX second, and the order matters: the citation rewrite
 * reads link and footnote syntax, and the TeX repair escapes Markdown
 * punctuation in what it unwraps — a `\[` manufactured there would stop looking
 * like the link the rewrite has to find.
 *
 * Without the rewrite all three leaks are live today, not hypothetical: the
 * HTML path links only `http(s)` targets, so a `resource://` link passes
 * through as literal bracket syntax; the text path appends whatever target it
 * is handed; and neither part has any footnote handling at all.
 */
function forEmail(markdown: string): string {
  return normalizeModelMarkdown(rewriteCitationsAsPlainText(markdown));
}

/**
 * The plain-text alternative, which is what a text-only client receives.
 *
 * It converts rather than passes through. A client showing this part is the one
 * client that will never render markup, so leaving `## Heading` and `**bold**`
 * here hands the defect this module exists to remove to the readers least able
 * to cope with it. Structure that survives as text — the bullet, the rank, a
 * link's target in parentheses — is kept.
 */
export function markdownToEmailText(markdown: string): string {
  // The plain-text entry point, deliberately: nothing below parses Markdown,
  // so an escape manufactured by `normalizeModelMarkdown` would reach the
  // reader as a literal backslash. The citation rewrite still runs first — its
  // output is Markdown that `stripInlineMarks` below then reduces, and a
  // footnote marker it did not remove would reach the reader as `[^1]`.
  markdown = normalizeModelText(rewriteCitationsAsPlainText(markdown));
  const lines: string[] = [];
  let fenced = false;
  for (const raw of markdown.replace(/\r\n/gu, "\n").split("\n")) {
    if (/^\s{0,3}(?:```|~~~)/u.test(raw)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) {
      lines.push(`    ${raw.trimEnd()}`);
      continue;
    }
    const line = raw.trimEnd();
    if (/^\s{0,3}(?:[-*_]\s*){3,}$/u.test(line)) {
      lines.push("-".repeat(24));
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/u.exec(line);
    if (heading) {
      lines.push(stripInlineMarks(heading[2]!, true));
      continue;
    }
    const bullet = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/u.exec(line);
    if (bullet) {
      const indent = indentWidth(bullet[1]!) >= 2 ? "    " : "  ";
      const marker = /\d/u.test(bullet[2]!) ? bullet[2]! : "-";
      lines.push(`${indent}${marker} ${stripInlineMarks(bullet[3]!, true)}`);
      continue;
    }
    lines.push(stripInlineMarks(line, true));
  }
  return lines.join("\n").replace(/\n{3,}/gu, "\n\n").trim();
}

/**
 * The one line a mail client shows beside the subject.
 *
 * The marks are dropped rather than rendered: a preheader is plain text in an
 * inbox list, so `## Deep dive` there is noise the reader sees before they open
 * anything.
 */
export function markdownToEmailPreheader(markdown: string, limit = 160): string {
  const plain = normalizeModelText(rewriteCitationsAsPlainText(markdown))
    .replace(/\r\n/gu, "\n")
    .replace(/^\s{0,3}(?:```|~~~).*$/gmu, " ")
    .replace(/^\s{0,3}(?:[-*_]\s*){3,}$/gmu, " ")
    .replace(/^\s{0,3}#{1,6}\s+/gmu, "")
    .replace(/^\s{0,3}>\s?/gmu, "")
    .replace(/^\s*(?:[-*+]|\d{1,3}[.)])\s+/gmu, "")
    .split("\n")
    .map((line) => stripInlineMarks(line))
    .join(" ")
    .replace(/[\r\n\t]+/gu, " ")
    .replace(/\s{2,}/gu, " ")
    .trim();
  return plain.length <= limit ? plain : `${plain.slice(0, limit - 1).trimEnd()}…`;
}

/**
 * Inline Markdown reduced to the words it was decorating.
 *
 * Shared by the plain-text part and the preheader, so the inbox preview and the
 * text body cannot disagree about which marks are punctuation and which are
 * formatting — they did, while one stripped `__bold__` and the other did not.
 * They differ on one thing only, and deliberately: the text part keeps a link's
 * target, because it is the reader's only way to follow it, while the preheader
 * is one line beside a subject and a URL in it is spent space.
 */
function stripInlineMarks(value: string, keepLinkTargets = false): string {
  return value
    .replace(/!\[([^\]]*)\]\(([^)]*)\)/gu, (_match, alt: string, href: string) => alt || href)
    .replace(/\[([^\][]+)\]\(([^)]*)\)/gu, (_match, label: string, href: string) =>
      keepLinkTargets && href ? `${label} (${href})` : label)
    .replace(/(\*\*|__)([^*_]+)\1/gu, "$2")
    .replace(/(^|[\s(])([*_])([^\s*_][^*_]*[^\s*_]|[^\s*_])\2(?=[\s.,;:)!?]|$)/gu, "$1$3")
    .replace(/~~([^~]+)~~/gu, "$1")
    .replace(/`([^`]+)`/gu, "$1")
    .trimEnd();
}

function blocksFromMarkdown(markdown: string): Block[] {
  const blocks: Block[] = [];
  let current: Block | null = null;
  let fence: string | null = null;
  const flush = (): void => {
    if (current) blocks.push(current);
    current = null;
  };

  for (const raw of markdown.replace(/\r\n/gu, "\n").split("\n")) {
    const line = raw.trimEnd();
    // A fenced block is kept exactly as written. Flattening it into a paragraph
    // let the inline-code pass match across the fences, which emitted one
    // mangled span and two stray backticks — and a result carrying JSON is
    // ordinary now that this renderer serves automations rather than only
    // digests.
    const fenceMark = /^\s{0,3}(```|~~~)/u.exec(line);
    if (fence) {
      if (fenceMark && line.trim().startsWith(fence)) {
        flush();
        fence = null;
      } else {
        current?.lines.push(raw);
      }
      continue;
    }
    if (fenceMark) {
      flush();
      fence = fenceMark[1]!;
      current = { kind: "preformatted", lines: [] };
      continue;
    }
    if (line.trim().length === 0) {
      flush();
      continue;
    }
    if (/^\s{0,3}(?:[-*_]\s*){3,}$/u.test(line)) {
      flush();
      blocks.push({ kind: "rule", lines: [] });
      continue;
    }
    // A table is not rendered as a table — there is no table model here — but
    // it is not flattened either: the rows keep their breaks and their columns
    // line up in a monospace block, which a reader can still use.
    if (/^\s{0,3}\|.*\|\s*$/u.test(line)) {
      if (current?.kind !== "preformatted") {
        flush();
        current = { kind: "preformatted", lines: [] };
      }
      current.lines.push(line.trim());
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/u.exec(line);
    if (heading) {
      flush();
      blocks.push({ kind: "heading", level: heading[1]!.length, lines: [heading[2]!] });
      continue;
    }
    const quote = /^\s{0,3}>\s?(.*)$/u.exec(line);
    if (quote) {
      if (current?.kind !== "quote") {
        flush();
        current = { kind: "quote", lines: [] };
      }
      current.lines.push(quote[1]!);
      continue;
    }
    // Indentation is read rather than trimmed away: a briefing's sources sit
    // under the point they belong to, and a sub-bullet promoted to a sibling
    // reads as another finding. One level is kept and no more, for the reason
    // headings stop at two — depth past that is noise in a mail client.
    const bullet = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/u.exec(line);
    if (bullet) {
      if (current?.kind !== "list") {
        flush();
        current = { kind: "list", lines: [], items: [] };
      }
      current.items!.push({
        indent: indentWidth(bullet[1]!),
        ordered: /\d/u.test(bullet[2]!),
        text: bullet[3]!,
      });
      continue;
    }
    // A wrapped bullet continues the bullet above it rather than starting a
    // paragraph, which is what keeps a long item from splitting mid-sentence.
    if (current?.kind === "list"
      && current.items!.length > 0
      && indentWidth(/^\s*/u.exec(raw)![0]) >= 2) {
      current.items![current.items!.length - 1]!.text += ` ${line.trim()}`;
      continue;
    }
    if (current?.kind === "paragraph") {
      current.lines.push(line.trim());
      continue;
    }
    flush();
    current = { kind: "paragraph", lines: [line.trim()] };
  }
  flush();
  return blocks;
}

function renderBlock(block: Block): string {
  if (block.kind === "rule") return `<hr style="${RULE_STYLE}">`;
  if (block.kind === "preformatted") {
    return `<pre style="${PRE_STYLE}">${escapeHtml(block.lines.join("\n"))}</pre>`;
  }
  if (block.kind === "heading") {
    // Three tiers and no more. A result usually opens with its own title, and
    // rendering that identically to the sections under it left a long briefing
    // one flat rank deep — the reader could not tell the document's name from
    // the first finding in it.
    const level = block.level ?? 1;
    const style = level === 1 ? TITLE_STYLE : level === 2 ? SECTION_STYLE : SUBSECTION_STYLE;
    const tag = level === 1 ? "h1" : level === 2 ? "h2" : "h3";
    return `<${tag} style="${style}">${renderInline(block.lines[0] ?? "")}</${tag}>`;
  }
  if (block.kind === "quote") {
    return `<blockquote style="${QUOTE_STYLE}">${renderInline(block.lines.join(" "))}</blockquote>`;
  }
  if (block.kind === "list") return renderList(block.items ?? []);
  return `<p style="${PARAGRAPH_STYLE}">${renderInline(block.lines.join(" "))}</p>`;
}

/**
 * A list, with one level of nesting kept and its numbering intact.
 *
 * Depth is relative to the list's own shallowest bullet, not to column zero. A
 * whole list written indented — under a paragraph, or inside a quoted block a
 * model copied — is a list of siblings, and reading its indent absolutely made
 * every item after the first a child of the one before it.
 *
 * `1.` renders as an `<ol>`: the compiler asks automations for stack-ranked
 * briefings, and a ranking whose numbers the renderer drops is a ranking the
 * reader cannot see. The plain-text part keeps the same numbers, so the two
 * MIME parts of one message rank the same way.
 */
function renderList(items: ListItem[]): string {
  const base = Math.min(...items.map((item) => item.indent));
  const groups: Array<{ text: string; ordered: boolean; children: ListItem[] }> = [];
  for (const item of items) {
    const parent = groups.at(-1);
    if (item.indent > base && parent) parent.children.push(item);
    else groups.push({ text: item.text, ordered: item.ordered, children: [] });
  }
  const rendered = groups.map((group) => {
    const children = group.children.length === 0
      ? ""
      : listElement(
        group.children[0]!.ordered,
        NESTED_LIST_STYLE,
        group.children.map((child) => `<li style="${LIST_ITEM_STYLE}">${renderInline(child.text)}</li>`).join(""),
      );
    return `<li style="${LIST_ITEM_STYLE}">${renderInline(group.text)}${children}</li>`;
  }).join("");
  return listElement(groups[0]?.ordered ?? false, LIST_STYLE, rendered);
}

function listElement(ordered: boolean, style: string, items: string): string {
  const tag = ordered ? "ol" : "ul";
  return `<${tag} style="${style}">${items}</${tag}>`;
}

/** The placeholder a parked code span leaves behind while emphasis runs. */
const CODE_PLACEHOLDER = "\u0000";

/**
 * Inline emphasis, code and links.
 *
 * The text is escaped first, so every later pass matches already-escaped text
 * and can only ever produce markup this function built. Two orderings inside
 * that are load-bearing, and both were defects before they were:
 *
 * - A link's target is written with `*`, `_` and backticks encoded, because the
 *   emphasis and code passes that follow would otherwise match *inside* the
 *   `href` and splice this function's own quoted templates into the attribute,
 *   breaking the destination and spilling the rest of the tag into visible
 *   text. The entities decode to the same URL for the reader.
 * - A code span is parked behind a placeholder before emphasis runs, so
 *   `` `a _b_ c` `` stays code rather than growing an `<em>` inside it.
 */
function renderInline(value: string): string {
  // The placeholder is the one construct here that model text could forge, so
  // the character it is built from never survives the input.
  let html = escapeHtml(value.split(CODE_PLACEHOLDER).join(""));
  const codeSpans: string[] = [];
  // A Markdown escape means the literal character, and the passes below are
  // this surface's whole parser — `normalizeModelMarkdown` escapes what it
  // unwraps on the contract that the parser downstream eats the backslash, and
  // a model's own `\*` means an asterisk, not emphasis. Each escape is parked
  // behind a placeholder *before* the link pass, or `\[a\](…)` still reads as
  // a link; a code span's contents are matched here only to be stepped over,
  // because a backslash inside backticks — a regex's `\.` — is code, not an
  // escape. The character may already sit in the text as its HTML entity,
  // which is parked whole for the same reason.
  html = html.replace(
    /(`[^`\n]+`)|\\(&(?:amp|lt|gt|quot|#39);|[!-/:-@[-`{-~])/gu,
    (match, code: string | undefined, literal: string | undefined) => {
      if (code !== undefined || literal === undefined) return match;
      codeSpans.push(literal);
      return `${CODE_PLACEHOLDER}${codeSpans.length - 1}${CODE_PLACEHOLDER}`;
    },
  );
  html = html.replace(
    /\[([^\][]+)\]\((https?:\/\/[^\s)]+)\)/gu,
    (_match, label: string, href: string) =>
      `<a href="${encodeLinkTarget(href)}" style="color:${COLOR.brand};text-decoration:none;border-bottom:1px solid rgba(206,220,0,.35)">${label}</a>`,
  );
  html = html.replace(/`([^`\n]+)`/gu, (_match, code: string) => {
    codeSpans.push(`<code style="${CODE_STYLE}">${code}</code>`);
    return `${CODE_PLACEHOLDER}${codeSpans.length - 1}${CODE_PLACEHOLDER}`;
  });
  html = html.replace(/\*\*([^*]+)\*\*/gu, (_match, bold: string) =>
    `<strong style="color:${COLOR.ink};font-weight:650">${bold}</strong>`);
  // Both emphasis marks, and asterisks only after bold has consumed its pairs.
  // A model writes `*a quoted claim*` far more often than `_this_`, and an
  // unrendered pair is exactly the raw punctuation this renderer exists to
  // remove. The boundaries are what keep arithmetic and a stray mark out.
  html = html.replace(
    /(^|[\s(])([*_])([^\s*_][^*_]*[^\s*_]|[^\s*_])\2(?=[\s.,;:)!?]|$)/gu,
    (_match, prefix: string, _mark: string, italic: string) =>
      `${prefix}<em style="color:${COLOR.inkSoft}">${italic}</em>`,
  );
  return html.replace(
    new RegExp(`${CODE_PLACEHOLDER}(\\d+)${CODE_PLACEHOLDER}`, "gu"),
    (_match, index: string) => codeSpans[Number(index)] ?? "",
  );
}

/** The characters a later pass could match inside an `href`, made inert. */
function encodeLinkTarget(href: string): string {
  return href.replace(/[*_`]/gu, (character) => `&#${character.codePointAt(0)};`);
}
