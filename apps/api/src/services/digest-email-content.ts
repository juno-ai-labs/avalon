import { escapeHtml } from "./resend";

/**
 * The digest's Markdown, rendered to email-safe HTML.
 *
 * A general Markdown library is the wrong tool here. Mail clients ignore most of
 * what one emits, several strip `<style>` entirely, and anything that renders
 * raw HTML would be rendering model output into an email — so this covers the
 * subset a digest actually uses and escapes everything before a single tag is
 * added. Unknown syntax degrades to visible text rather than to markup.
 */

const HEADING_STYLES = [
  "margin:32px 0 10px;font-size:19px;line-height:1.3;font-weight:700;color:#f2f3ec",
  "margin:26px 0 8px;font-size:16px;line-height:1.35;font-weight:700;color:#f2f3ec",
  "margin:22px 0 6px;font-size:14px;line-height:1.4;font-weight:700;letter-spacing:.02em;color:#c9ccc4",
];
const PARAGRAPH_STYLE = "margin:0 0 14px;font-size:15px;line-height:1.65;color:#c9ccc4";
const LIST_STYLE = "margin:0 0 16px;padding-left:20px;font-size:15px;line-height:1.65;color:#c9ccc4";
const LIST_ITEM_STYLE = "margin:0 0 7px";
const RULE_STYLE = "border:0;border-top:1px solid #2c302a;margin:26px 0";

interface Block {
  kind: "heading" | "paragraph" | "list" | "rule";
  level?: number;
  lines: string[];
}

export function digestMarkdownToHtml(markdown: string): string {
  return blocksFromMarkdown(markdown).map(renderBlock).join("\n");
}

/** The plain-text alternative, which is what a text-only client receives. */
export function digestMarkdownToText(markdown: string): string {
  return markdown.replace(/\r\n/gu, "\n").replace(/\n{3,}/gu, "\n\n").trim();
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
    const bullet = /^\s{0,3}(?:[-*+]|\d{1,3}[.)])\s+(.*)$/u.exec(line);
    if (bullet) {
      if (current?.kind !== "list") {
        flush();
        current = { kind: "list", lines: [] };
      }
      current.lines.push(bullet[1]!);
      continue;
    }
    if (current?.kind === "paragraph") {
      current.lines.push(line.trim());
      continue;
    }
    // A wrapped bullet continues the bullet above it rather than starting a
    // paragraph, which is what keeps a long item from splitting mid-sentence.
    if (current?.kind === "list" && /^\s{2,}/u.test(raw)) {
      current.lines[current.lines.length - 1] += ` ${line.trim()}`;
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
    const level = Math.min(block.level ?? 1, 3);
    const style = HEADING_STYLES[level - 1] ?? HEADING_STYLES[2]!;
    return `<h${level + 1} style="${style}">${renderInline(block.lines[0] ?? "")}</h${level + 1}>`;
  }
  if (block.kind === "list") {
    const items = block.lines
      .map((line) => `<li style="${LIST_ITEM_STYLE}">${renderInline(line)}</li>`)
      .join("");
    return `<ul style="${LIST_STYLE}">${items}</ul>`;
  }
  return `<p style="${PARAGRAPH_STYLE}">${renderInline(block.lines.join(" "))}</p>`;
}

/**
 * Inline emphasis, code and links. The text is escaped first, so a link target
 * is matched against already-escaped text and can only ever produce an `href`
 * this function built — never markup the model wrote.
 */
function renderInline(value: string): string {
  let html = escapeHtml(value);
  html = html.replace(/`([^`]+)`/gu, (_match, code: string) =>
    `<code style="padding:1px 5px;border-radius:4px;background:#20241e;font-size:13px;color:#e2e5dc">${code}</code>`);
  html = html.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/gu,
    (_match, label: string, href: string) =>
      `<a href="${href}" style="color:#CEDC00;text-decoration:none;font-weight:600">${label}</a>`,
  );
  html = html.replace(/\*\*([^*]+)\*\*/gu, (_match, bold: string) =>
    `<strong style="color:#f2f3ec">${bold}</strong>`);
  html = html.replace(/(^|[\s(])_([^_]+)_(?=[\s.,;:)!?]|$)/gu, (_match, prefix: string, italic: string) =>
    `${prefix}<em>${italic}</em>`);
  return html;
}

export interface DigestEmailContent {
  recipientName: string;
  workspaceName: string;
  /** e.g. "Tuesday, 12 August · 9:00 AM" in the reader's own timezone. */
  occurrenceLabel: string;
  bodyMarkdown: string;
  itemCount: number;
  highlightCount: number;
  settingsUrl: string;
}

/**
 * The digest email.
 *
 * Table-based, inline-styled, single column and 560px wide, matching the
 * mention and automation emails so Avalon's mail all looks like one product. The
 * summary strip at the top is what shows in a notification preview, which is
 * where most of these are read first.
 */
export function digestEmailHtml(content: DigestEmailContent): string {
  const recipientName = escapeHtml(content.recipientName);
  const workspaceName = escapeHtml(content.workspaceName);
  const occurrence = escapeHtml(content.occurrenceLabel);
  const settingsUrl = escapeHtml(content.settingsUrl);
  const greeting = recipientName ? `Hi ${recipientName},` : "Here is your Avalon digest.";
  const highlights = content.highlightCount > 0
    ? `<span style="display:inline-block;padding:4px 10px;border-radius:999px;background:#CEDC00;color:#11140f;font-size:12px;font-weight:700">${content.highlightCount} for you</span>`
    : "";
  const items = `<span style="display:inline-block;padding:4px 10px;border-radius:999px;background:#20241e;border:1px solid #343832;color:#c9ccc4;font-size:12px;font-weight:600">${content.itemCount} update${content.itemCount === 1 ? "" : "s"}</span>`;

  return `<!doctype html>
<html lang="en">
  <body style="margin:0;background:#10130f;color:#f2f3ec;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0">${content.itemCount} update${content.itemCount === 1 ? "" : "s"} from ${workspaceName}</div>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#10130f;padding:40px 16px">
      <tr><td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background:#181b17;border:1px solid #343832;border-radius:18px;padding:36px">
          <tr><td style="font-size:13px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#CEDC00">Avalon digest</td></tr>
          <tr><td><h1 style="margin:16px 0 6px;font-size:26px;line-height:1.25;color:#f2f3ec">${occurrence}</h1></td></tr>
          <tr><td style="padding-bottom:20px;font-size:14px;line-height:1.6;color:#8f948b">${greeting} Here is what moved in ${workspaceName} since your last digest.</td></tr>
          <tr><td style="padding-bottom:8px">${highlights}${highlights ? "&nbsp;" : ""}${items}</td></tr>
          <tr><td><hr style="${RULE_STYLE}"></td></tr>
          <tr><td>${digestMarkdownToHtml(content.bodyMarkdown)}</td></tr>
          <tr><td style="padding-top:26px;border-top:1px solid #2c302a">
            <p style="margin:0 0 6px;font-size:12px;line-height:1.6;color:#8f948b">Written by Avalon from activity you already have access to. Generated by AI — check anything important.</p>
            <p style="margin:0;font-size:12px;line-height:1.6;color:#8f948b"><a href="${settingsUrl}" style="color:#8f948b;text-decoration:underline">Change when you get this</a></p>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;
}
