/**
 * Slack rendering for agent-authored markdown.
 *
 * Slack has two text dialects and they are not the same language. The `text`
 * field of `chat.postMessage` is **mrkdwn** — `*bold*`, `_italic_`, no headings,
 * no tables — while the `markdown` block and the streaming `markdown_text` field
 * take ordinary markdown. Agent output is ordinary markdown, so posting it as
 * `text` puts three literal hashes in the channel where a heading belonged.
 *
 * Everything here exists to put agent output through the `markdown` block on
 * every delivery path, and to split it at Slack's limit without severing the
 * structures that make it worth rendering at all.
 *
 * The same "every delivery path" is why the citation rewrite sits in the
 * splitter rather than at each call site. Slack renders neither the
 * `resource://` scheme nor GFM footnote syntax, so an unrewritten citation
 * reaches a channel as a raw scheme URL, a literal `[^1]`, or — for the embed
 * form — a broken image. Both paths that post agent markdown chunk it here
 * first, so this is the one place that cannot be forgotten.
 */

import { rewriteCitationsForPlainDelivery } from "@rally/contracts/citations";

/** Slack's cumulative limit for all `markdown` blocks in one message payload. */
export const SLACK_MARKDOWN_BLOCK_LIMIT = 12_000;

/** Slack's cap on a `header` block's `plain_text`. */
const SLACK_HEADER_LIMIT = 150;

/**
 * How much stripped-down prose accompanies a message as its notification and
 * screen-reader fallback. Slack accepts far more, but this text is read aloud
 * and shown in a push notification, so length past a few lines is noise.
 */
const SLACK_NOTIFICATION_TEXT_LIMIT = 3_000;

/** The shortest chunk that still has room to close and reopen a code fence. */
const MINIMUM_CHUNK = 64;

/** A line that opens or closes a fenced code block, with its marker captured. */
const FENCE_LINE = /^[ \t]{0,3}(`{3,}|~{3,})(.*)$/u;

export interface SlackMarkdownMessage {
  /** Notification and accessibility fallback. Never empty; Slack rejects that. */
  text: string;
  blocks: Record<string, unknown>[];
}

export function slackMarkdownBlock(markdown: string): Record<string, unknown> {
  return { type: "markdown", text: markdown };
}

export function slackHeaderBlock(title: string): Record<string, unknown> {
  return { type: "header", text: { type: "plain_text", text: title.slice(0, SLACK_HEADER_LIMIT) } };
}

/**
 * Splits markdown into chunks Slack will accept, breaking where the text offers
 * a seam rather than at whichever character happens to land on the limit.
 *
 * Preference order is paragraph, then line, then — only for a single line longer
 * than the whole budget — a hard character break. A chunk that ends inside a
 * fenced code block closes the fence and the next chunk reopens it, so a long
 * code block arrives as two rendered blocks instead of one block and a page of
 * loose text.
 *
 * Citations are rewritten to readable text first, before anything is measured
 * or cut, because the rewrite changes the length of what is being split and a
 * trailing source list must land whole in the last chunk rather than being
 * assembled across two.
 */
export function splitSlackMarkdown(value: string, maximum = SLACK_MARKDOWN_BLOCK_LIMIT): string[] {
  if (maximum < MINIMUM_CHUNK) throw new Error("Slack markdown chunks need room to reopen a fence");
  const normalized = rewriteCitationsForPlainDelivery(value.replace(/\r\n/gu, "\n"));
  if (!normalized.trim()) return [];
  if (normalized.length <= maximum) return [normalized];

  const chunks: string[] = [];
  let pending: string[] = [];
  let pendingLength = 0;
  // The fence open when the *current* chunk began, so a continuation can reopen
  // it, and the fence open at the current line, so a break knows to close it.
  let carriedFence: string | null = null;
  let openFence: string | null = null;

  for (const line of normalized.split("\n")) {
    // Reserve room for the reopened fence above and the closing fence below, so
    // a chunk that lands mid-block cannot exceed the limit once repaired.
    //
    // The bound is the *worst* of the current fence state and the state a flush
    // inside this line would produce, because a flush sets `carriedFence` to the
    // open fence and the remainder of the line then pays for both markers. A
    // budget computed only from the state on entry is what overflowed: a single
    // line longer than the budget with a fence open — minified JSON, a base64
    // payload, a long log line — was hard-split into pieces sized for no carried
    // fence, and every chunk after the flush came back over the limit with a
    // reopened fence on top.
    const wrapBudget = Math.max(16, maximum - Math.max(
      fenceOverhead(carriedFence, openFence),
      fenceOverhead(openFence, openFence),
    ));

    for (const piece of hardWrap(line, wrapBudget)) {
      // Measured against the fence state *after* this piece, since a piece that
      // opens a fence makes the chunk need a closing marker it did not need a
      // moment ago.
      const overhead = fenceOverhead(carriedFence, nextFenceState(openFence, piece));
      if (pending.length && overhead + pendingLength + piece.length + 1 > maximum) {
        // A blank line is only a paragraph seam outside a fence; inside one it
        // is part of the code, and breaking there splits the block for nothing.
        const paragraph = openFence === null ? lastParagraphBreak(pending) : -1;
        const carry = paragraph > 0 ? pending.slice(paragraph + 1) : [];
        chunks.push(joinChunk(carriedFence, paragraph > 0 ? pending.slice(0, paragraph) : pending, openFence));
        carriedFence = openFence;
        pending = carry;
        pendingLength = carry.reduce((total, entry) => total + entry.length + 1, 0);
      }
      pendingLength += piece.length + (pending.length ? 1 : 0);
      pending.push(piece);
      openFence = nextFenceState(openFence, piece);
    }
  }
  if (pending.length) chunks.push(joinChunk(carriedFence, pending, openFence));
  return chunks.filter((chunk) => chunk.trim().length > 0);
}

/** Room a chunk must leave for the fence it reopens and the fence it closes. */
function fenceOverhead(carried: string | null, open: string | null): number {
  return (carried === null ? 0 : carried.length + 1)
    + (open === null ? 0 : fenceMarker(open).length + 1);
}

function joinChunk(carried: string | null, body: string[], open: string | null): string {
  return [
    ...(carried === null ? [] : [carried]),
    ...body,
    ...(open === null ? [] : [fenceMarker(open)]),
  ].join("\n");
}

/**
 * Strips markdown down to something worth reading in a push notification.
 *
 * This is deliberately lossy: the rendered blocks carry the real content, and a
 * fallback that reproduces a table in a notification banner helps nobody.
 */
export function slackNotificationText(markdown: string, limit = SLACK_NOTIFICATION_TEXT_LIMIT): string {
  const plain = markdown
    .replace(/\r\n/gu, "\n")
    .replace(/^[ \t]{0,3}(?:`{3,}|~{3,}).*$/gmu, "")
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gmu, "")
    .replace(/^[ \t]{0,3}>[ \t]?/gmu, "")
    .replace(/^[ \t]{0,3}(?:[-*+]|\d+[.)])[ \t]+/gmu, "• ")
    .replace(/^[ \t]{0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/gmu, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .replace(/`([^`\n]+)`/gu, "$1")
    .replace(/(\*\*|__)(.+?)\1/gu, "$2")
    .replace(/~~(.+?)~~/gu, "$1")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
  if (!plain) return "Rally posted a result.";
  return plain.length <= limit ? plain : `${plain.slice(0, limit - 1).trimEnd()}…`;
}

/**
 * Renders agent markdown as a sequence of Slack message payloads.
 *
 * A header, when given, sits on the first message only — it titles the result
 * rather than repeating above every chunk of it.
 */
export function slackMarkdownMessages(markdown: string, options: {
  header?: string;
  fallback?: string;
} = {}): SlackMarkdownMessage[] {
  const source = markdown.replace(/\r\n/gu, "\n").trim() || (options.fallback ?? "").trim();
  const chunks = splitSlackMarkdown(source);
  if (!chunks.length) return [];
  const header = options.header?.trim();
  return chunks.map((chunk, index) => ({
    text: slackNotificationText(index === 0 && header ? `${header}\n${chunk}` : chunk),
    blocks: [
      ...(index === 0 && header ? [slackHeaderBlock(header)] : []),
      slackMarkdownBlock(chunk),
    ],
  }));
}

/** The bare marker for a fence line, without its language info string. */
function fenceMarker(fenceLine: string): string {
  return FENCE_LINE.exec(fenceLine)?.[1] ?? "```";
}

function nextFenceState(openFence: string | null, line: string): string | null {
  const match = FENCE_LINE.exec(line);
  if (!match) return openFence;
  if (openFence === null) return line;
  // A fence closes only on the same character, at least as long, and bare.
  const marker = fenceMarker(openFence);
  const closes = match[1]!.startsWith(marker[0]!)
    && match[1]!.length >= marker.length
    && !match[2]!.trim();
  return closes ? null : openFence;
}

/** The index of the last blank line in the back half of a pending chunk. */
function lastParagraphBreak(pending: string[]): number {
  for (let index = pending.length - 1; index > pending.length / 2; index -= 1) {
    if (!pending[index]!.trim()) return index;
  }
  return -1;
}

/** Breaks a single over-long line into pieces that fit, leaving others alone. */
function hardWrap(line: string, budget: number): string[] {
  if (line.length <= budget) return [line];
  const pieces: string[] = [];
  for (let start = 0; start < line.length; start += budget) {
    pieces.push(line.slice(start, start + budget));
  }
  return pieces;
}
