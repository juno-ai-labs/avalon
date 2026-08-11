import { escapeHtml } from "./resend";

/**
 * The digest email.
 *
 * Dark, and deliberately only dark: it is a copy of an Avalon surface, and the
 * app has one appearance. Every colour is the app's own token, written inline —
 * a mail client will strip a `<style>` block, and several rewrite a page that
 * declares a light scheme, so the palette is stated on the elements themselves
 * and stays put. The canvas is also asked to fill the reading pane rather than
 * stop at the last line — see `digestEmailHtml`.
 *
 * The Markdown renderer here is deliberately small rather than a library. Mail
 * clients ignore most of what a general renderer emits, and rendering raw HTML
 * would mean rendering model output into an email. This covers the subset a
 * digest uses, escapes everything before a single tag is added, and only ever
 * emits an `href` it built itself. Unknown syntax degrades to visible text.
 */

/** The application's palette, so the email and the app are the same product. */
const COLOR = {
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
const QUOTE_STYLE = `margin:0 0 16px;padding:12px 16px;background:${COLOR.surfaceRaised};border-left:3px solid ${COLOR.mutedDeep};border-radius:0 8px 8px 0;font-size:14px;line-height:1.6;color:${COLOR.muted}`;
const RULE_STYLE = `border:0;border-top:1px solid ${COLOR.lineSoft};margin:26px 0`;

interface Block {
  kind: "heading" | "paragraph" | "list" | "quote" | "rule";
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
    const quote = /^\s{0,3}>\s?(.*)$/u.exec(line);
    if (quote) {
      if (current?.kind !== "quote") {
        flush();
        current = { kind: "quote", lines: [] };
      }
      current.lines.push(quote[1]!);
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
    // A wrapped bullet continues the bullet above it rather than starting a
    // paragraph, which is what keeps a long item from splitting mid-sentence.
    if (current?.kind === "list" && /^\s{2,}/u.test(raw)) {
      current.lines[current.lines.length - 1] += ` ${line.trim()}`;
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
    // Two levels of heading and no more. A digest is a page someone skims in a
    // mail client, and a third level reads as noise rather than structure.
    const style = (block.level ?? 1) <= 2 ? SECTION_STYLE : SUBSECTION_STYLE;
    const tag = (block.level ?? 1) <= 2 ? "h2" : "h3";
    return `<${tag} style="${style}">${renderInline(block.lines[0] ?? "")}</${tag}>`;
  }
  if (block.kind === "quote") {
    return `<blockquote style="${QUOTE_STYLE}">${renderInline(block.lines.join(" "))}</blockquote>`;
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
    `<code style="padding:2px 6px;border-radius:5px;background:${COLOR.surfaceRaised};border:1px solid ${COLOR.line};font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;color:${COLOR.inkSoft}">${code}</code>`);
  html = html.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/gu,
    (_match, label: string, href: string) =>
      `<a href="${href}" style="color:${COLOR.brand};text-decoration:none;border-bottom:1px solid rgba(206,220,0,.35)">${label}</a>`,
  );
  html = html.replace(/\*\*([^*]+)\*\*/gu, (_match, bold: string) =>
    `<strong style="color:${COLOR.ink};font-weight:650">${bold}</strong>`);
  html = html.replace(/(^|[\s(])_([^_]+)_(?=[\s.,;:)!?]|$)/gu, (_match, prefix: string, italic: string) =>
    `${prefix}<em style="color:${COLOR.inkSoft}">${italic}</em>`);
  return html;
}

export interface DigestEmailContent {
  recipientName: string;
  workspaceName: string;
  /** e.g. "Tuesday 11 August · 9:00 AM" in the reader's own timezone. */
  occurrenceLabel: string;
  bodyMarkdown: string;
  itemCount: number;
  highlightCount: number;
  /** Where the reader goes to see everything, and where they change the schedule. */
  appUrl: string;
  settingsUrl: string;
}

function pill(text: string, options: { accent?: boolean } = {}): string {
  const style = options.accent
    ? `display:inline-block;padding:5px 11px;border-radius:999px;background:${COLOR.brand};color:${COLOR.onBrand};font-size:12px;font-weight:700;letter-spacing:.01em`
    : `display:inline-block;padding:5px 11px;border-radius:999px;background:${COLOR.surfaceRaised};border:1px solid ${COLOR.line};color:${COLOR.muted};font-size:12px;font-weight:600`;
  return `<span style="${style}">${escapeHtml(text)}</span>`;
}

export function digestEmailHtml(content: DigestEmailContent): string {
  const recipientName = escapeHtml(content.recipientName);
  const workspaceName = escapeHtml(content.workspaceName);
  const occurrence = escapeHtml(content.occurrenceLabel);
  const appUrl = escapeHtml(content.appUrl);
  const settingsUrl = escapeHtml(content.settingsUrl);
  const items = `${content.itemCount} update${content.itemCount === 1 ? "" : "s"}`;
  // The preheader is what a phone shows next to the subject, so it carries the
  // one number that decides whether this gets opened now or later.
  const preheader = content.highlightCount > 0
    ? `${content.highlightCount} need${content.highlightCount === 1 ? "s" : ""} you · ${items} in ${content.workspaceName}`
    : `${items} in ${content.workspaceName}`;

  // `height:100%` on the document and body, so a short digest does not end in a
  // hard edge with the client's own white below it.
  //
  // A body background normally propagates to the canvas and paints the whole
  // pane on its own. What defeats that is a client painting its own background
  // onto `html` — propagation only happens while the root has none — and that
  // is the only case this chain is for: a full-height body paints the pane
  // itself rather than relying on a propagation the client has already broken.
  //
  // A percentage is load-bearing, and a viewport unit would be wrong. Where a
  // webmail client strips `<body>` and injects this markup into its own page,
  // the percentage meets an auto-height ancestor and collapses to nothing,
  // leaving the message the height of its content — which is what a thread card
  // wants. `100vh` there would measure the browser window instead of the pane
  // and hang a tall dark tail off the bottom of the card. Nothing carries a
  // height on the layout table either: the Word engine reads that as a minimum
  // against the page box, which is the same tail in a different client.
  return `<!doctype html>
<html lang="en" style="color-scheme:dark;supported-color-schemes:dark;height:100%;background:${COLOR.canvas}">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <meta name="color-scheme" content="dark">
    <meta name="supported-color-schemes" content="dark">
    <title>Your ${workspaceName} digest</title>
  </head>
  <body style="margin:0;padding:0;width:100%;height:100%;background:${COLOR.canvas};color:${COLOR.ink};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${escapeHtml(preheader)}</div>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:${COLOR.canvas};padding:36px 14px">
      <tr><td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:600px">

          <tr><td style="padding:0 4px 14px">
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr>
              <td style="font-size:12px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:${COLOR.brand}">Avalon</td>
              <td align="right" style="font-size:12px;color:${COLOR.mutedDeep}">${workspaceName}</td>
            </tr></table>
          </td></tr>

          <tr><td style="background:${COLOR.surface};border:1px solid ${COLOR.line};border-radius:16px;padding:32px 30px">

            <h1 style="margin:0 0 6px;font-size:25px;line-height:1.2;font-weight:700;letter-spacing:-.02em;color:${COLOR.ink}">Your digest</h1>
            <p style="margin:0 0 18px;font-size:13px;line-height:1.5;color:${COLOR.mutedDeep}">${occurrence}</p>
            <p style="margin:0 0 16px">${content.highlightCount > 0 ? `${pill(`${content.highlightCount} for you`, { accent: true })}&nbsp;` : ""}${pill(items)}</p>
            <p style="margin:0 0 4px;font-size:15px;line-height:1.6;color:${COLOR.inkSoft}">${recipientName ? `Hi ${recipientName} — here` : "Here"} is what moved since your last digest.</p>

            <hr style="${RULE_STYLE}">

            ${digestMarkdownToHtml(content.bodyMarkdown)}

            <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin-top:30px"><tr><td style="border-radius:10px;background:${COLOR.brand}">
              <a href="${appUrl}" style="display:inline-block;padding:13px 22px;font-size:14px;font-weight:700;color:${COLOR.onBrand};text-decoration:none">Open Avalon &rarr;</a>
            </td></tr></table>

          </td></tr>

          <tr><td style="padding:20px 4px 0">
            <p style="margin:0 0 6px;font-size:11.5px;line-height:1.6;color:${COLOR.mutedDeep}">Written by Avalon from activity you already have access to. Generated by AI — check anything important.</p>
            <p style="margin:0;font-size:11.5px;line-height:1.6;color:${COLOR.mutedDeep}"><a href="${settingsUrl}" style="color:${COLOR.muted};text-decoration:underline">Change when you get this</a></p>
          </td></tr>

        </table>
      </td></tr>
    </table>
  </body>
</html>`;
}
