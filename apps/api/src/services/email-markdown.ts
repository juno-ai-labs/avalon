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
 * `href` it built itself. Unknown syntax degrades to visible text.
 *
 * Styling is inline and dark, and deliberately only dark: these are copies of
 * an Avalon surface, and the app has one appearance. A mail client will strip a
 * `<style>` block, and several rewrite a page that declares a light scheme, so
 * the palette is stated on the elements themselves and stays put.
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
  blue: "#47c7fc",
} as const;

const SECTION_STYLE = `margin:30px 0 12px;padding:0 0 0 12px;border-left:3px solid ${COLOR.brand};font-size:17px;line-height:1.3;font-weight:700;color:${COLOR.ink};letter-spacing:-.01em`;
const SUBSECTION_STYLE = `margin:22px 0 8px;font-size:13px;line-height:1.4;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:${COLOR.muted}`;
const PARAGRAPH_STYLE = `margin:0 0 13px;font-size:15px;line-height:1.65;color:${COLOR.inkSoft}`;
const LIST_STYLE = `margin:0 0 16px;padding-left:18px;font-size:15px;line-height:1.6;color:${COLOR.inkSoft}`;
const LIST_ITEM_STYLE = "margin:0 0 9px;padding-left:3px";
const NESTED_LIST_STYLE = `margin:9px 0 0;padding-left:18px;font-size:14px;line-height:1.55;color:${COLOR.muted}`;
const QUOTE_STYLE = `margin:0 0 16px;padding:12px 16px;background:${COLOR.surfaceRaised};border-left:3px solid ${COLOR.mutedDeep};border-radius:0 8px 8px 0;font-size:14px;line-height:1.6;color:${COLOR.muted}`;
export const RULE_STYLE = `border:0;border-top:1px solid ${COLOR.lineSoft};margin:26px 0`;

interface ListItem {
  /** 0 for a top-level bullet, 1 for one indented under it. */
  depth: 0 | 1;
  text: string;
}

interface Block {
  kind: "heading" | "paragraph" | "list" | "quote" | "rule";
  level?: number;
  lines: string[];
  items?: ListItem[];
}

export function markdownToEmailHtml(markdown: string): string {
  return blocksFromMarkdown(markdown).map(renderBlock).join("\n");
}

/** The plain-text alternative, which is what a text-only client receives. */
export function markdownToEmailText(markdown: string): string {
  return markdown.replace(/\r\n/gu, "\n").replace(/\n{3,}/gu, "\n\n").trim();
}

/**
 * The one line a mail client shows beside the subject.
 *
 * The marks are dropped rather than rendered: a preheader is plain text in an
 * inbox list, so `## Deep dive` there is noise the reader sees before they open
 * anything.
 */
export function markdownToEmailPreheader(markdown: string, limit = 160): string {
  const plain = markdown
    .replace(/\r\n/gu, "\n")
    .replace(/^\s{0,3}(?:[-*_]\s*){3,}$/gmu, " ")
    .replace(/^\s{0,3}#{1,6}\s+/gmu, "")
    .replace(/^\s{0,3}>\s?/gmu, "")
    .replace(/^\s{0,3}(?:[-*+]|\d{1,3}[.)])\s+/gmu, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .replace(/(\*\*|__)([^*_]+)\1/gu, "$2")
    .replace(/`([^`]+)`/gu, "$1")
    .replace(/[\r\n\t]+/gu, " ")
    .replace(/\s{2,}/gu, " ")
    .trim();
  return plain.length <= limit ? plain : `${plain.slice(0, limit - 1).trimEnd()}…`;
}

function blocksFromMarkdown(markdown: string): Block[] {
  const blocks: Block[] = [];
  let current: Block | null = null;
  const flush = (): void => {
    if (current) blocks.push(current);
    current = null;
  };

  for (const raw of markdown.replace(/\r\n/gu, "\n").split("\n")) {
    const line = raw.trimEnd();
    if (line.trim().length === 0) {
      flush();
      continue;
    }
    if (/^\s{0,3}(?:[-*_]\s*){3,}$/u.test(line)) {
      flush();
      blocks.push({ kind: "rule", lines: [] });
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
    const bullet = /^(\s*)(?:[-*+]|\d{1,3}[.)])\s+(.*)$/u.exec(line);
    if (bullet) {
      if (current?.kind !== "list") {
        flush();
        current = { kind: "list", lines: [], items: [] };
      }
      current.items!.push({ depth: bullet[1]!.length >= 2 ? 1 : 0, text: bullet[2]! });
      continue;
    }
    // A wrapped bullet continues the bullet above it rather than starting a
    // paragraph, which is what keeps a long item from splitting mid-sentence.
    if (current?.kind === "list" && current.items!.length > 0 && /^\s{2,}/u.test(raw)) {
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
  if (block.kind === "heading") {
    // Two levels of heading and no more. These are pages someone skims in a
    // mail client, and a third level reads as noise rather than structure.
    const style = (block.level ?? 1) <= 2 ? SECTION_STYLE : SUBSECTION_STYLE;
    const tag = (block.level ?? 1) <= 2 ? "h2" : "h3";
    return `<${tag} style="${style}">${renderInline(block.lines[0] ?? "")}</${tag}>`;
  }
  if (block.kind === "quote") {
    return `<blockquote style="${QUOTE_STYLE}">${renderInline(block.lines.join(" "))}</blockquote>`;
  }
  if (block.kind === "list") return renderList(block.items ?? []);
  return `<p style="${PARAGRAPH_STYLE}">${renderInline(block.lines.join(" "))}</p>`;
}

/**
 * A list, with one level of nesting kept.
 *
 * An indented bullet becomes a nested `<ul>` inside the item it belongs to. A
 * nested bullet with nothing above it is a top-level one instead, because the
 * alternative is a list that opens at a depth the reader never saw begin.
 */
function renderList(items: ListItem[]): string {
  const groups: Array<{ text: string; children: string[] }> = [];
  for (const item of items) {
    const parent = groups.at(-1);
    if (item.depth === 1 && parent) parent.children.push(item.text);
    else groups.push({ text: item.text, children: [] });
  }
  const rendered = groups.map((group) => {
    const children = group.children.length === 0
      ? ""
      : `<ul style="${NESTED_LIST_STYLE}">${group.children
        .map((child) => `<li style="${LIST_ITEM_STYLE}">${renderInline(child)}</li>`)
        .join("")}</ul>`;
    return `<li style="${LIST_ITEM_STYLE}">${renderInline(group.text)}${children}</li>`;
  }).join("");
  return `<ul style="${LIST_STYLE}">${rendered}</ul>`;
}

/**
 * Inline emphasis, code and links. The text is escaped first, so a link target
 * is matched against already-escaped text and can only ever produce an `href`
 * this function built — never markup the model wrote.
 */
function renderInline(value: string): string {
  let html = escapeHtml(value);
  html = html.replace(/`([^`]+)`/gu, (_match, code: string) =>
    `<code style="padding:2px 6px;border-radius:5px;background:${COLOR.surfaceRaised};border:1px solid ${COLOR.line};font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;color:${COLOR.inkSoft}">${code}</code>`);
  html = html.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/gu,
    (_match, label: string, href: string) =>
      `<a href="${href}" style="color:${COLOR.brand};text-decoration:none;border-bottom:1px solid rgba(206,220,0,.35)">${label}</a>`,
  );
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
  return html;
}
