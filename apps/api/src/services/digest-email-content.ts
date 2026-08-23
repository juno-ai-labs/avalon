import { normalizeModelMarkdown } from "@avalon/contracts/model-markdown";
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
const LINK_STYLE = `color:${COLOR.brand};text-decoration:none;border-bottom:1px solid rgba(206,220,0,.35)`;
const RULE_STYLE = `border:0;border-top:1px solid ${COLOR.lineSoft};margin:26px 0`;

const CODE_BLOCK_STYLE = `margin:0 0 16px;padding:12px 14px;background:${COLOR.canvas};border:1px solid ${COLOR.line};border-radius:8px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px;line-height:1.55;color:${COLOR.inkSoft};white-space:pre-wrap;word-break:break-word`;
const TABLE_STYLE = `margin:0 0 16px;border-collapse:separate;border-spacing:2px;width:100%;font-size:13.5px;line-height:1.5`;
const TABLE_CELL_STYLE = `padding:7px 9px;border-radius:5px;background:${COLOR.surfaceRaised};color:${COLOR.inkSoft};text-align:left;vertical-align:top`;
const TABLE_HEADER_STYLE = `padding:7px 9px;border-radius:5px;background:${COLOR.line};color:${COLOR.ink};font-weight:650;text-align:left;vertical-align:top`;
const CODE_STYLE = `padding:2px 6px;border-radius:5px;background:${COLOR.surfaceRaised};border:1px solid ${COLOR.line};font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;color:${COLOR.inkSoft}`;
/**
 * Marks where a code span was lifted out of a line so the emphasis passes
 * cannot reach inside it. U+0000 is the one character guaranteed absent: the
 * text is split on it before anything else runs.
 */
const CODE_SEPARATOR = "\u0000";

/** A checked and an unchecked box, drawn as characters no client can break. */
const TASK_MARK = { done: "☑", pending: "☐" } as const;

interface ListItem {
  /** Nesting depth, counted from the leading whitespace of the source line. */
  depth: number;
  /** Each item carries its own marker: a bulleted sublist can sit under a
   * numbered step, and inheriting the parent's would renumber it. */
  ordered: boolean;
  lines: string[];
  task?: "done" | "pending";
}

type Block =
  | { kind: "heading"; level: number; lines: string[] }
  | { kind: "paragraph"; lines: string[] }
  | { kind: "quote"; lines: string[] }
  | { kind: "rule" }
  | { kind: "code"; lines: string[] }
  | { kind: "table"; header: string[]; rows: string[][] }
  | { kind: "list"; ordered: boolean; items: ListItem[] };

export function digestMarkdownToHtml(markdown: string): string {
  return blocksFromMarkdown(normalizeModelMarkdown(markdown)).map(renderBlock).join("\n");
}

/**
 * The plain-text alternative, which is what a text-only client receives.
 *
 * Markdown is close enough to read as text, so this leaves the structure alone
 * and only removes what would read as debris in a client that renders none of
 * it: the mention links, whose target is an internal identifier that means
 * nothing outside Avalon, and the TeX the HTML part no longer shows either.
 */
export function digestMarkdownToText(markdown: string): string {
  return normalizeModelMarkdown(markdown)
    .replace(/\r\n/gu, "\n")
    .replace(MENTION_LINK, (_match, label: string) => label)
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

/** `[label](person:…)` and `[label](connector:…)`, whose targets are internal. */
const MENTION_LINK = /\[([^\]]+)\]\((?:person|connector):[^)\s]*\)/gu;

const FENCE = /^\s{0,3}(?:`{3,}|~{3,})/u;
const TABLE_DIVIDER = /^\s{0,3}\|?(?:\s*:?-{1,}:?\s*\|)+\s*:?-{1,}:?\s*\|?\s*$/u;
const TABLE_ROW = /^\s{0,3}\|.*\|\s*$/u;
const BULLET = /^(\s*)(?:[-*+]|(\d{1,3})[.)])\s+(.*)$/u;

/** A table row's cells, with the optional leading and trailing pipes removed. */
function tableCells(line: string): string[] {
  return line.trim().replace(/^\|/u, "").replace(/\|$/u, "").split("|").map((cell) => cell.trim());
}

function blocksFromMarkdown(markdown: string): Block[] {
  const blocks: Block[] = [];
  const lines = markdown.replace(/\r\n/gu, "\n").split("\n");
  let current: Extract<Block, { kind: "paragraph" | "quote" | "list" }> | null = null;
  const flush = (): void => {
    if (current) blocks.push(current);
    current = null;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index]!;
    const line = raw.trimEnd();

    // A fence takes every line up to its closer verbatim, which is the whole
    // point of one: nothing inside is markup, so nothing inside is parsed.
    if (FENCE.test(line)) {
      flush();
      const body: string[] = [];
      index += 1;
      for (; index < lines.length && !FENCE.test(lines[index]!.trimEnd()); index += 1) body.push(lines[index]!);
      blocks.push({ kind: "code", lines: body });
      continue;
    }

    if (line.trim().length === 0) {
      flush();
      continue;
    }

    if (/^\s{0,3}(?:[-*_]\s*){3,}$/u.test(line)) {
      flush();
      blocks.push({ kind: "rule" });
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/u.exec(line);
    if (heading) {
      flush();
      blocks.push({ kind: "heading", level: heading[1]!.length, lines: [heading[2]!] });
      continue;
    }

    // A table is recognised from its divider, so the header line is already
    // behind us — which is why this reads ahead rather than accumulating.
    if (TABLE_ROW.test(line) && index + 1 < lines.length && TABLE_DIVIDER.test(lines[index + 1]!.trimEnd())) {
      flush();
      const header = tableCells(line);
      const rows: string[][] = [];
      index += 2;
      for (; index < lines.length && TABLE_ROW.test(lines[index]!.trimEnd()); index += 1) {
        rows.push(tableCells(lines[index]!.trimEnd()));
      }
      index -= 1;
      blocks.push({ kind: "table", header, rows });
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

    const bullet = BULLET.exec(line);
    if (bullet) {
      const ordered = bullet[2] !== undefined;
      if (current?.kind !== "list") {
        flush();
        current = { kind: "list", ordered, items: [] };
      }
      const content = bullet[3]!;
      const task = /^\[[xX]\]\s/u.test(content) ? "done" as const
        : /^\[\s?\]\s/u.test(content) ? "pending" as const
        : undefined;
      current.items.push({
        depth: Math.min(Math.floor(bullet[1]!.replace(/\t/gu, "  ").length / 2), 3),
        ordered,
        lines: [task ? content.replace(/^\[[xX\s]?\]\s+/u, "") : content],
        ...(task ? { task } : {}),
      });
      continue;
    }

    // A wrapped bullet continues the bullet above it rather than starting a
    // paragraph, which is what keeps a long item from splitting mid-sentence.
    if (current?.kind === "list" && /^\s{2,}/u.test(raw)) {
      const last = current.items[current.items.length - 1];
      if (last) last.lines.push(line.trim());
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

/**
 * A list rendered at one nesting depth, recursing into the items below it.
 *
 * Mail clients disagree about nested-list indentation and several drop the
 * marker of an inner list entirely, so each level is its own element with its
 * own padding rather than a client's default.
 */
function renderList(items: ListItem[], ordered: boolean, depth: number): string {
  const tag = ordered ? "ol" : "ul";
  const marker = depth === 0 ? "disc" : depth === 1 ? "circle" : "square";
  const style = `${LIST_STYLE};list-style:${ordered ? "decimal" : marker}`;
  let html = "";
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]!;
    if (item.depth > depth) continue;
    const children: ListItem[] = [];
    while (index + 1 < items.length && items[index + 1]!.depth > depth) {
      children.push(items[index + 1]!);
      index += 1;
    }
    const mark = item.task ? `${TASK_MARK[item.task]} ` : "";
    const nested = children.length > 0
      ? renderList(children, children[0]!.ordered, depth + 1)
      : "";
    // A task list carries its state in the mark, so it drops the bullet that
    // would otherwise sit beside it.
    const itemStyle = item.task ? `${LIST_ITEM_STYLE};list-style:none` : LIST_ITEM_STYLE;
    html += `<li style="${itemStyle}">${mark}${renderInline(item.lines.join(" "))}${nested}</li>`;
  }
  return `<${tag} style="${style}">${html}</${tag}>`;
}

function renderBlock(block: Block): string {
  if (block.kind === "rule") return `<hr style="${RULE_STYLE}">`;
  if (block.kind === "heading") {
    // Two levels of heading and no more. A digest is a page someone skims in a
    // mail client, and a third level reads as noise rather than structure.
    const style = block.level <= 2 ? SECTION_STYLE : SUBSECTION_STYLE;
    const tag = block.level <= 2 ? "h2" : "h3";
    return `<${tag} style="${style}">${renderInline(block.lines[0] ?? "")}</${tag}>`;
  }
  if (block.kind === "code") return `<pre style="${CODE_BLOCK_STYLE}">${escapeHtml(block.lines.join("\n"))}</pre>`;
  if (block.kind === "table") {
    const width = Math.max(block.header.length, ...block.rows.map((row) => row.length));
    const cells = (row: string[], style: string, tag: string): string => Array.from({ length: width }, (_unused, index) => (
      `<${tag} style="${style}">${renderInline(row[index] ?? "")}</${tag}>`
    )).join("");
    const head = `<tr>${cells(block.header, TABLE_HEADER_STYLE, "th")}</tr>`;
    const body = block.rows.map((row) => `<tr>${cells(row, TABLE_CELL_STYLE, "td")}</tr>`).join("");
    return `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="${TABLE_STYLE}">${head}${body}</table>`;
  }
  if (block.kind === "quote") {
    return `<blockquote style="${QUOTE_STYLE}">${renderInline(block.lines.join(" "))}</blockquote>`;
  }
  if (block.kind === "list") return renderList(block.items, block.ordered, 0);
  return `<p style="${PARAGRAPH_STYLE}">${renderInline(block.lines.join(" "))}</p>`;
}

/**
 * The character references a model writes when it is quoting markup, decoded
 * before anything is escaped so `A &amp; B` reads as `A & B` rather than as its
 * own source. Decoding first and escaping second is what keeps that safe: every
 * character this produces goes straight back through `escapeHtml`.
 *
 * The named set is the one CommonMark's own test suite leans on. A name outside
 * it stays literal, which is the same thing the desktop renderer does with one
 * it cannot resolve.
 */
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0", hellip: "…",
  mdash: "—", ndash: "–", lsquo: "\u2018", rsquo: "\u2019", ldquo: "\u201c", rdquo: "\u201d",
  times: "×", divide: "÷", plusmn: "±", deg: "°", rarr: "→", larr: "←", harr: "↔",
  copy: "©", reg: "®", trade: "™", middot: "·", bull: "•", euro: "€", pound: "£", yen: "¥",
};

function decodeEntities(value: string): string {
  return value.replace(/&(#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31});/gu, (match, body: string) => {
    if (body.startsWith("#")) {
      const code = body[1] === "x" || body[1] === "X"
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      // Surrogates and out-of-range values have no character to become, and
      // `String.fromCodePoint` throws on them rather than returning anything.
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return match;
      return String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[body] ?? match;
  });
}

/**
 * Inline emphasis, code and links.
 *
 * Code spans are lifted out before anything else runs and put back at the end,
 * so the emphasis passes never reach inside one: `` `npm run **build**` `` is a
 * command with asterisks in it, and bolding part of it makes it a command
 * nobody can copy.
 *
 * The text is escaped before a single tag is added, so a link target is matched
 * against already-escaped text and can only ever produce an `href` this
 * function built — never markup the model wrote.
 */
function renderInline(value: string): string {
  const codes: string[] = [];
  // The separator is stripped from the input first, so a placeholder built from
  // it provably cannot collide with anything the model wrote.
  let html = escapeHtml(decodeEntities(value.split(CODE_SEPARATOR).join(""))).replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/gu, (_match, _fence, code: string) => {
    codes.push(`<code style="${CODE_STYLE}">${code.replace(/^ (.*) $/u, "$1")}</code>`);
    return `${CODE_SEPARATOR}${codes.length - 1}${CODE_SEPARATOR}`;
  });

  // A mention's target is an Avalon identifier, so it becomes its own label:
  // there is nothing outside the app for it to link to.
  html = html.replace(MENTION_LINK, (_match, label: string) => label);
  html = html.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/gu,
    (_match, label: string, href: string) => `<a href="${href}" style="${LINK_STYLE}">${label}</a>`,
  );
  // A bare URL, which a mail client would otherwise leave as text or linkify
  // with a target of its own choosing. Anchored so the one inside the `href`
  // just written is not matched a second time.
  html = html.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/gu, (_match, prefix: string, href: string) => (
    `${prefix}<a href="${href}" style="${LINK_STYLE}">${href}</a>`
  ));
  html = html.replace(/\*\*([^*]+)\*\*|__([^_]+)__/gu, (_match, stars?: string, unders?: string) =>
    `<strong style="color:${COLOR.ink};font-weight:650">${stars ?? unders}</strong>`);
  html = html.replace(/~~([^~]+)~~/gu, (_match, struck: string) =>
    `<del style="color:${COLOR.mutedDeep}">${struck}</del>`);
  html = html.replace(/(^|[\s(])([*_])([^\s*_](?:[^*_]*[^\s*_])?)\2(?=[\s.,;:)!?]|$)/gu, (
    _match,
    prefix: string,
    _marker: string,
    italic: string,
  ) => `${prefix}<em style="color:${COLOR.inkSoft}">${italic}</em>`);

  // Split rather than matched: the separator is a control character, and a
  // regular expression containing one is both unreadable and lint-flagged.
  // Odd positions are the indices this function put there.
  return html.split(CODE_SEPARATOR)
    .map((part, index) => (index % 2 === 1 ? codes[Number(part)] ?? "" : part))
    .join("");
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
