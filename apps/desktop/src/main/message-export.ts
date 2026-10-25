import { describeZodIssues } from '@rally/contracts/zod-diagnostics';
import { z } from 'zod';
import {
  MESSAGE_EXPORT_FILE_NAME_PATTERN,
  MESSAGE_EXPORT_FILE_TYPES,
  type MessageExportFormat,
  type MessageExportRequest,
  type MessageExportResult,
} from '../common/message-export';
import { exportSyntaxPalette } from '../common/theme-assets';

/**
 * Rendering a message to a picture or a PDF, in the main process.
 *
 * The renderer hands over the message as HTML; everything below decides what the
 * page around it looks like, drives an off-screen Chromium window over it, and
 * writes the bytes wherever the person pointed the save dialog.
 * [`docs/message-export.md`](../../../../docs/message-export.md) owns the design
 * and records why it is shaped this way.
 */

/**
 * The document is served over a scheme of its own rather than handed to the
 * window as a `data:` URL: Chromium refuses a top-level `data:` navigation past
 * roughly 128 KB, which a message with a table in it reaches easily. A scheme
 * also carries a response header, so the export policy below is a real CSP
 * rather than a `<meta>` the document could restate.
 */
export const MESSAGE_EXPORT_SCHEME = 'rallywithai-export';
const MESSAGE_EXPORT_HOST = 'sheet';

/**
 * No script, no plugins, no network except the pictures a message can already
 * show in the feed. The window that renders this has no preload and no Node, so
 * the policy is the second lock rather than the first.
 */
export const MESSAGE_EXPORT_CONTENT_SECURITY_POLICY =
  "default-src 'none'; img-src data: https:; style-src 'unsafe-inline'; font-src data:";

/** The card's width, in CSS pixels: a comfortable measure for prose at 15px. */
const IMAGE_WIDTH = 960;
/** The window a PDF is laid out in. Letter at 96dpi less the printed margins. */
const PDF_WIDTH = 816;
/** Rendered at 2× so the picture is crisp on the display it will be read on. */
const IMAGE_SCALE = 2;
/**
 * The tallest picture Chromium is asked to hold in one surface. A message longer
 * than this is rendered at 1× and, past 12,000 CSS pixels, cropped — the format
 * has stopped being the right one by then, and the PDF beside it has no limit.
 */
const IMAGE_MAX_DEVICE_HEIGHT = 12_000;

const LOAD_TIMEOUT_MS = 15_000;
const MEASURE_TIMEOUT_MS = 15_000;
const RENDER_TIMEOUT_MS = 60_000;
/** One paint after the resize, so the capture is of the page at its final size. */
const SETTLE_MS = 180;
/** The window a token can be redeemed in, if its window never asks for it. */
const DOCUMENT_TTL_MS = 30_000;

const MAX_CONTENT_HTML_LENGTH = 600_000;
const MAX_LOGO_LENGTH = 400_000;

// One message is bounded; a whole conversation is not. See `MessageExportScope`.
const MessageExportRequestSchema = z.object({
  format: z.enum(['image', 'pdf']),
  scope: z.enum(['message', 'conversation']).optional(),
  contentHtml: z.string().min(1),
  fileName: z.string().regex(MESSAGE_EXPORT_FILE_NAME_PATTERN),
  logoDataUrl: z.string().max(MAX_LOGO_LENGTH).regex(/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/u),
}).superRefine((request, context) => {
  if (request.scope === 'conversation') {
    if (request.format !== 'pdf') context.addIssue({ code: 'custom', path: ['format'], message: 'A conversation exports as a PDF' });
  } else if (request.contentHtml.length > MAX_CONTENT_HTML_LENGTH) {
    context.addIssue({ code: 'custom', path: ['contentHtml'], message: 'Too long for one message' });
  }
});

/**
 * Whether a URL addresses the export protocol.
 *
 * Shared with the application's `onHeadersReceived` policy so that the two
 * agree on what an export response is: the document is served with the strict
 * policy above, and the renderer's — far broader — policy must not be applied
 * over it.
 */
export function isMessageExportUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return url.protocol === `${MESSAGE_EXPORT_SCHEME}:` && url.host === MESSAGE_EXPORT_HOST;
  } catch {
    return false;
  }
}

/** Parses an IPC payload into a request, or throws. */
export function parseMessageExportRequest(value: unknown): MessageExportRequest {
  const parsed = MessageExportRequestSchema.safeParse(value);
  if (!parsed.success) throw new Error(`Invalid message export request: ${describeZodIssues(parsed.error)}`);
  return parsed.data;
}

/**
 * The window operations the exporter needs, named in its own terms so the
 * sequence below can be tested without Electron. `index.ts` implements this over
 * a hidden `BrowserWindow`.
 */
export interface MessageExportWindow {
  /** Resolves when the document has finished loading, rejects when it cannot. */
  load: (url: string) => Promise<void>;
  /** Evaluates a script in the document and answers what it returned. */
  evaluate: (script: string) => Promise<unknown>;
  /** Resizes the window's content area and sets the zoom the capture is taken at. */
  resize: (width: number, height: number, zoom: number) => void;
  /** Captures the whole content area as JPEG bytes. */
  captureJpeg: (quality: number) => Promise<Uint8Array>;
  /** Prints the document to PDF bytes, paginated by Chromium. */
  printPdf: (options: MessageExportPrintOptions) => Promise<Uint8Array>;
  destroy: () => void;
}

export interface MessageExportPrintOptions {
  /** Drawn by Chromium in the bottom margin of **every** page. */
  footerHtml: string;
  /** Inches, matching Chromium's own printing options. */
  margins: { top: number; bottom: number; left: number; right: number };
}

export interface MessageExportDependencies {
  readonly createWindow: (size: { width: number; height: number }) => MessageExportWindow;
  /** Answers the chosen path, or null when the person dismissed the dialog. */
  readonly showSaveDialog: (input: {
    defaultFileName: string;
    extension: string;
    filterLabel: string;
  }) => Promise<string | null>;
  readonly writeFile: (path: string, data: Uint8Array) => Promise<void>;
  /** Reads one of `MESSAGE_EXPORT_FONTS` out of the app's `export-fonts` resources. */
  readonly readFont: (file: string) => Promise<Uint8Array>;
  readonly logWarning: (message: string, error: unknown) => void;
  readonly randomToken: () => string;
  readonly now: () => number;
  readonly delay: (milliseconds: number) => Promise<void>;
}

/**
 * The faces the card is set in, embedded in every export.
 *
 * Static TrueType only, and that is the whole point. Chromium's PDF writer
 * embeds a static TrueType face as a normal CID font, but writes a CFF face
 * (Inter as most systems install it, SF Mono) or a variable one (the Mac's
 * system font, the app's own Geist Mono) as Type 3 glyphs with an upside-down
 * font bounding box. Viewers that trust that box clip every glyph, and the
 * person opens a PDF of empty white pages. Embedding these means the card
 * never reaches for a system font for Latin, Greek or Cyrillic text.
 *
 * The weights between files (560, 640, 660) take the nearest face, which is
 * why there is no Medium. Italic bold is synthesized.
 */
export const MESSAGE_EXPORT_FONTS = [
  { file: 'Inter-Regular.ttf', family: 'Rally Export Sans', weight: 400, style: 'normal' },
  { file: 'Inter-SemiBold.ttf', family: 'Rally Export Sans', weight: 600, style: 'normal' },
  { file: 'Inter-Bold.ttf', family: 'Rally Export Sans', weight: 700, style: 'normal' },
  { file: 'Inter-Italic.ttf', family: 'Rally Export Sans', weight: 400, style: 'italic' },
  { file: 'GeistMono-Regular.ttf', family: 'Rally Export Mono', weight: 400, style: 'normal' },
] as const;

/** The `@font-face` rules for `MESSAGE_EXPORT_FONTS`, from the bytes read for each. */
export function messageExportFontFaces(fonts: readonly Uint8Array[]): string {
  return MESSAGE_EXPORT_FONTS.map((font, index) => `@font-face { font-family: "${font.family}"; font-style: ${font.style}; font-weight: ${font.weight}; src: url(data:font/ttf;base64,${Buffer.from(fonts[index]!).toString('base64')}) format("truetype"); }`).join('\n');
}

/**
 * The script the image path measures with. It waits for the fonts and for every
 * picture the message carries, because a capture taken before either has settled
 * is a card with the wrong height and, sometimes, empty boxes where the pictures
 * are. A picture that fails to load resolves too — the export is not the place to
 * discover that a URL is dead.
 */
const MEASURE_SCRIPT = `void 0, (async () => {
  await document.fonts.ready;
  await Promise.all([...document.images].filter((image) => !image.complete).map((image) => new Promise((resolve) => {
    image.addEventListener('load', resolve, { once: true });
    image.addEventListener('error', resolve, { once: true });
  })));
  return Math.ceil(document.body.getBoundingClientRect().height);
})()`;

/**
 * Five washes of colour over a diagonal base, placed by percentage so the
 * splash spreads over a card of any height rather than pooling at the top of a
 * long one. The seed rotates
 * which corner each colour lands in, so two messages saved from the same work
 * stream do not come out identical.
 */
function splashBackground(seed: number): string {
  const colours = ['#cedc00', '#47c7fc', '#ccff00', '#b995f5', '#2f7d5c'];
  const positions = [
    { size: '78% 34%', at: '6% 1%' },
    { size: '70% 30%', at: '96% 7%' },
    { size: '84% 36%', at: '88% 99%' },
    { size: '64% 30%', at: '2% 94%' },
    { size: '52% 26%', at: '48% 52%' },
  ];
  const layers = positions.map((position, index) => {
    const colour = colours[(index + seed) % colours.length]!;
    return `radial-gradient(${position.size} at ${position.at}, ${colour} 0%, ${transparent(colour)} 63%)`;
  });
  return [...layers, 'linear-gradient(135deg, #20221d 0%, #14150f 100%)'].join(', ');
}

/** `#rrggbb` as a fully transparent `rgba()`, so the gradient fades out rather
 * than through grey — a transparent hex fades through black in every engine. */
function transparent(colour: string): string {
  const value = Number.parseInt(colour.slice(1), 16);
  return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, 0)`;
}

/** A small stable number from the content, so a message always splashes the same. */
function seedFrom(text: string): number {
  let hash = 0;
  for (const character of text) hash = (hash * 31 + character.charCodeAt(0)) % 100_003;
  return hash;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/**
 * The stylesheet of the exported card.
 *
 * It deliberately does not reuse `app.css`. That stylesheet dresses markdown for
 * a dark application window; a card that is going to be pasted into a document
 * or a chat is a light one, and every element needs different colours rather
 * than a filter over the same ones. What it does keep is the class names
 * `MarkdownBody` emits, so the two stay in step by construction: a new class
 * there is a missing rule here, and shows up the first time the card is looked
 * at. Code blocks stay dark on purpose — the highlighter's colours are inline
 * styles chosen for a dark background, and repainting them on white would mean
 * overriding every one of them.
 *
 * Those inline styles are `var(--av-sys-color-syntax-*)` references, and this
 * document is the one place `MarkdownBody`'s markup is re-hosted outside the
 * application, where nothing declares them. So `:root` declares them here, from
 * the generated `exportSyntaxPalette` rather than from a second copy of the
 * values. Without it every reference is invalid at computed-value time, `color`
 * falls back to the inherited near-black, and the code block is near-black text
 * on a near-black ground.
 */
function stylesheet(format: MessageExportFormat, logoDataUrl: string, seed: number, fontFaces: string): string {
  const splash = splashBackground(seed);
  const syntax = Object.entries(exportSyntaxPalette)
    .map(([property, value]) => `    ${property}: ${value};`)
    .join('\n');
  return `
  ${fontFaces}
  :root {
${syntax}
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    -webkit-font-smoothing: antialiased;
    color: #24251c;
    font-family: "Rally Export Sans", Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    font-size: 15px;
    line-height: 1.55;
  }
  ${format === 'image' ? `
  body { background: ${splash}; padding: 30px; }
  .export-card { border-radius: 26px; padding: 42px 46px 20px; }
  ` : `
  body { background: #ffffff; }
  .export-sheet {
    background: ${splash};
    -webkit-box-decoration-break: clone;
    border-radius: 24px;
    padding: 13px;
  }
  .export-card { -webkit-box-decoration-break: clone; border-radius: 14px; padding: 28px 32px; }
  `}
  .export-card { background: #fdfdfb; }
  .export-signature {
    align-items: center;
    color: #8a8b80;
    display: flex;
    font-size: 12px;
    font-weight: 560;
    gap: 7px;
    justify-content: flex-end;
    padding-top: 20px;
  }
  /* The mark goes into a CSS url() unescaped. MessageExportRequestSchema is what
     makes that safe: base64 and padding only, so nothing in it can close the
     string. Widening that pattern — to SVG, whose data URLs carry quotes and
     angle brackets — means escaping here first. */
  .export-signature .export-mark {
    background: #b6c400;
    display: inline-block;
    height: 15px;
    -webkit-mask: url('${logoDataUrl}') center / contain no-repeat;
    mask: url('${logoDataUrl}') center / contain no-repeat;
    width: 15px;
  }
  .markdown-body > :first-child { margin-top: 0; }
  .markdown-body > :last-child { margin-bottom: 0; }
  .markdown-body h1 { font-size: 25px; font-weight: 660; letter-spacing: -0.015em; margin: 26px 0 12px; }
  .markdown-body h2 { font-size: 19px; font-weight: 640; margin: 24px 0 10px; }
  .markdown-body h3 { font-size: 16px; font-weight: 640; margin: 20px 0 8px; }
  .markdown-body h4, .markdown-body h5, .markdown-body h6 { font-size: 15px; font-weight: 640; margin: 18px 0 6px; }
  .markdown-body p { margin: 12px 0; }
  .markdown-body a { color: #4a6a12; text-decoration: underline; text-underline-offset: 2px; }
  .markdown-body ul, .markdown-body ol { margin: 12px 0; padding-left: 24px; }
  .markdown-body ul { list-style: disc; }
  .markdown-body ol { list-style: decimal; }
  .markdown-body ul ul, .markdown-body ol ul { list-style: circle; }
  .markdown-body li { margin: 5px 0; }
  .markdown-body li::marker { color: #9a9b8e; }
  .markdown-body .contains-task-list { list-style: none; padding-left: 4px; }
  /* A system checkbox is a control, and a greyed one in a picture reads as
     broken rather than as a task that is not done. Drawn as a mark instead. */
  .markdown-body input[type="checkbox"] {
    appearance: none;
    -webkit-appearance: none;
    border: 1.5px solid #bab8a7;
    border-radius: 4px;
    height: 13px;
    margin: 0 8px 0 -22px;
    position: relative;
    top: 2px;
    width: 13px;
  }
  .markdown-body input[type="checkbox"]:checked { background: #cedc00; border-color: #b6c400; }
  .markdown-body input[type="checkbox"]:checked::after {
    border: solid #2f3121;
    border-width: 0 0 1.6px 1.6px;
    content: "";
    height: 3px;
    left: 2px;
    position: absolute;
    top: 3px;
    transform: rotate(-45deg);
    width: 6px;
  }
  .markdown-body blockquote { border-left: 3px solid #cedc00; color: #4d4f42; margin: 16px 0; padding: 2px 0 2px 16px; }
  .markdown-body blockquote > :last-child { margin-bottom: 0; }
  .markdown-body hr { background: #e2e0d3; border: 0; height: 1px; margin: 22px 0; }
  .markdown-body img { border-radius: 8px; display: block; height: auto; margin: 16px 0; max-width: 100%; }
  .markdown-body del { color: #86877c; }
  .markdown-inline-code {
    background: #eceade;
    border-radius: 4px;
    font-family: "Rally Export Mono", "SFMono-Regular", Consolas, "Liberation Mono", monospace;
    font-size: 0.88em;
    padding: 1px 5px;
  }
  .markdown-code-block { background: #1b1c18; border-radius: 12px; margin: 16px 0; padding: 14px 16px; }
  .markdown-code-block-header { display: block; }
  /* The copy button is a control, and a picture of a control is a lie. */
  .markdown-code-block-header button { display: none; }
  /* display: block so margin-bottom below actually opens a gap — an inline span ignores vertical margin. */
  .markdown-code-language { color: #85867c; display: block; font-size: 10px; letter-spacing: 0.08em; margin-bottom: 6px; text-transform: uppercase; }
  .markdown-code-block pre {
    font-family: "Rally Export Mono", "SFMono-Regular", Consolas, "Liberation Mono", monospace;
    font-size: 12.5px;
    line-height: 1.55;
    margin: 0;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .markdown-table-scroll { margin: 16px 0; overflow: hidden; }
  .markdown-body table {
    border-collapse: separate;
    border-spacing: 2px;
    font-size: 13.5px;
    table-layout: fixed;
    width: 100%;
  }
  .markdown-body th, .markdown-body td { background: #f1efe5; border-radius: 5px; padding: 7px 9px; text-align: left; vertical-align: top; }
  .markdown-body th { background: #e6e3d4; font-weight: 640; }
  .mention-chip {
    align-items: center;
    background: #eceade;
    border-radius: 999px;
    color: #3d3f33;
    display: inline-flex;
    font-size: 0.92em;
    font-weight: 560;
    gap: 4px;
    padding: 0 7px;
  }
  .mention-chip-avatar { display: none; }
  /* GFM titles its footnote section with a heading it expects the host to hide.
     This document loads none of the application stylesheet, so without a rule
     here the card printed a bare "Footnotes" above the list — a word out of the
     renderer's plumbing, in the middle of a saved picture. Hidden outright
     rather than clipped the way the app does it: nothing here is read aloud. */
  .sr-only { display: none; }
  /* Citations, drawn for a still card rather than an application.

     What the card cannot have is the part that makes a citation useful: the
     click. So the chip and the embed keep their shape — a reader recognises the
     thing they clicked in the app — and lose everything that promises
     interaction. The popover goes entirely: a hover affordance printed into a
     PNG is a grey box over the text with no way to dismiss it, and the source it
     would have named is on the pill's own line in the app, not here. The pill
     stays a plain numbered superscript, which is what a citation degrades to
     everywhere outside this renderer anyway. */
  /* These three are buttons, and this document loads none of the application's
     preflight — so without an explicit inherit they render in the UA's default
     face: Arial beside Inter, invisible on a host where the two resolve alike
     and obvious on a Mac. */
  .citation-file-attachment { display: block; max-width: 100%; }
  .citation-chip, .citation-card, .citation-pill { font: inherit; line-height: inherit; }
  .citation-chip {
    align-items: center;
    background: #eceade;
    border: 1px solid #dcd9c9;
    border-radius: 999px;
    color: #3d3f33;
    display: inline-flex;
    font-size: 0.92em;
    font-weight: 560;
    gap: 4px;
    padding: 1px 8px 1px 6px;
  }
  .citation-chip-icon { color: #6b6d5e; display: inline-flex; }
  .markdown-body .citation-chip-icon svg { height: 0.95em; width: 0.95em; }
  .citation-chip-label { display: inline; }
  /* The same file-tile shape the app draws — badge at the head, title and kind
     at the foot, room between — in this card's fixed light palette. */
  /* Composed exactly as the app composes it: the same gap, and the title block
     pushed to the foot by its own margin-top auto rather than by a
     space-between that would only agree with the app while the card has
     exactly two children. */
  .citation-card {
    background: #ffffff;
    border: 1px solid #dcd9c9;
    border-radius: 12px;
    color: #3d3f33;
    display: flex;
    flex-direction: column;
    gap: 9px;
    margin: 16px 0;
    min-height: 170px;
    padding: 11px;
    text-align: left;
    width: 176px;
  }
  .citation-card-badge {
    align-items: center;
    align-self: flex-start;
    border: 1px solid #dcd9c9;
    border-radius: 7px;
    color: #6b6d5e;
    display: inline-flex;
    height: 27px;
    justify-content: center;
    width: 27px;
  }
  /* A run of embeds shares a row in the app and scrolls; a still cannot
     scroll, so here the row wraps and every card stays in the picture. */
  .citation-card-row { display: flex; flex-wrap: wrap; gap: 10px; margin: 16px 0; }
  .citation-card-row .citation-card { margin: 0; }
  /* A still renders with MarkdownBody's still flag, which never asks for a
     preview at all — so none of these can appear in a saved card. They are
     declared because a class the renderer can emit must have an answer here,
     and the honest answer for a live-loading affordance in a picture is that
     it is not drawn. */
  .citation-card-image-preview, .citation-card-preview, .citation-card-preview-skeleton { display: none; }
  /* An audio card is a container with controls in it rather than one button,
     and a picture of a transport is a dead bar with a clock stopped on it — so
     the still keeps the tile and drops the playback entirely. The title block
     is a button here, which in a document that loads no preflight means the
     UA's own chrome unless it is reset like the card is. */
  .citation-card-audio { display: flex; flex-direction: column; gap: 9px; }
  .citation-card-audio-source, .citation-card-elapsed, .citation-card-play,
  .citation-card-progress, .citation-card-transport { display: none; }
  .citation-card-text { display: flex; flex-direction: column; gap: 3px; margin-top: auto; }
  .citation-card-open {
    background: none;
    border: 0;
    color: inherit;
    display: flex;
    flex-direction: column;
    font: inherit;
    gap: 3px;
    line-height: inherit;
    margin-top: auto;
    padding: 0;
    text-align: left;
  }
  .citation-card-title { font-size: 0.97em; font-weight: 560; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  /* No text-transform: the renderer already turns the system identifier into
     words, and capitalizing each of them made the card say "Github Pull
     Request" where the app says "Github pull request". */
  .citation-card-kind { color: #6b6d5e; font-size: 10px; }
  /* Sized and raised exactly as the app's is, and for the same reason: GFM's
     sup wrapper applies its own smaller and its own super, and stacking the
     pill's on top of those left a digit too small to read. The card keeps numbered
     markers to identify its printed source list; neutralising the wrapper
     keeps those numbers readable at the intended size. */
  .markdown-body sup:has(.citation-pill) { font-size: inherit; vertical-align: baseline; }
  .citation-pill {
    background: #ededed;
    border: 1px solid #b5b5b5;
    border-radius: 999px;
    color: #070707;
    display: inline-block;
    font: inherit;
    font-size: 0.72em;
    font-weight: 680;
    line-height: 1.5;
    margin: 0 1px;
    min-width: 1.5em;
    padding: 0 0.35em;
    text-align: center;
    vertical-align: super;
  }
  /* The popover and its parts: a hover affordance printed into a still image is
     a grey box over the text with no way to dismiss it, and the source it names
     is already on the pill in the app. */
  .citation-pill-popover,
  .citation-pill-source,
  .citation-pill-note,
  .citation-pill-open { display: none; }
  .citation-identity-label { font: inherit; }
  /* A footnote that was not lifted still renders, and without a rule it reads as
     an ordinary numbered list inside the answer. */
  .markdown-body .footnotes { border-top: 1px solid #e2e0d3; color: #6b6d5e; font-size: 0.9em; margin-top: 22px; padding-top: 12px; }
  .markdown-body .data-footnote-backref { display: none; }
  .citation-identity-card {
    background: #eceade;
    border: 1px solid #dcd9c9;
    border-radius: 6px;
    color: #3d3f33;
    display: inline-block;
    font-size: 0.92em;
    font-weight: 560;
    padding: 3px 9px;
  }
  .mention-text-fallback { color: #3d3f33; font-weight: 560; }
  /* A whole conversation: its title, then one section per turn, each under who
     said it and when. The feed's bubbles and alignment are a screen's way of
     telling speakers apart; on paper the byline does that alone. */
  .markdown-body .export-conversation-title { margin: 0 0 18px; }
  .export-turn { border-top: 1px solid #e7e5da; padding: 14px 0 4px; }
  .export-turn:first-of-type { border-top: 0; padding-top: 0; }
  .export-turn-byline { align-items: baseline; display: flex; gap: 8px; margin-bottom: 6px; }
  .export-turn-author { color: #24251c; font-size: 13px; font-weight: 640; }
  .export-turn-time { color: #8a8b80; font-size: 12px; }
  .export-turn-body > :first-child { margin-top: 0; }
  .export-turn-body > :last-child { margin-bottom: 0; }
  /* Paged output only: a heading stranded at the foot of a page reads as a
     heading for nothing, and a table split across pages loses its header. */
  blockquote, table, .markdown-code-block { break-inside: avoid-page; }
  h1, h2, h3, h4, .export-turn-byline { break-after: avoid-page; break-inside: avoid-page; }
  `;
}

/** The card, as a complete document ready for Chromium. */
export function messageExportDocument(input: {
  format: MessageExportFormat;
  contentHtml: string;
  logoDataUrl: string;
  /** `messageExportFontFaces`; absent sets the card in whatever the system has. */
  fontFaces?: string;
}): string {
  // `contentHtml` is interpolated as markup, not escaped, because it *is* the
  // rendered message. What makes that safe is upstream: `MarkdownBody` mounts
  // `react-markdown` with no `rehype-raw`, so HTML in a model's markdown is
  // already text by the time it reaches here — except the break-tag rewrite,
  // which emits only empty `<br>` elements from a closed pattern. The window's
  // `default-src 'none'` is the second lock. Both have to hold — a raw-HTML
  // plug-in added to the renderer would turn this into an injection point.
  const seed = seedFrom(input.contentHtml);
  const signature = `<div class="export-signature"><span class="export-mark"></span>Saved from Rally</div>`;
  const card = `<div class="export-card"><div class="markdown-body">${input.contentHtml}</div>${
    input.format === 'image' ? signature : ''
  }</div>`;
  return [
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Saved from Rally</title>',
    `<style>${stylesheet(input.format, input.logoDataUrl, seed, input.fontFaces ?? '')}</style></head>`,
    `<body>${input.format === 'pdf' ? `<div class="export-sheet">${card}</div>` : card}</body></html>`,
  ].join('');
}

/**
 * The footer Chromium draws in the bottom margin of every page. It is a separate
 * document from the card — Chromium renders header and footer templates in their
 * own frame — so it carries its own inline styling and cannot reach the
 * stylesheet above. Backgrounds and images only print here when the template
 * says so itself, which is what `print-color-adjust` and the inlined mark are
 * for.
 *
 * It is set in Arial, not the card's face. Chromium loads no web fonts into a
 * template's frame, inline `@font-face` included, so the footer can only use a
 * font installed on the machine, and Arial is the one every Mac has as static
 * TrueType. See `MESSAGE_EXPORT_FONTS` for why that matters.
 */
export function messageExportFooter(logoDataUrl: string): string {
  return `<div style="-webkit-print-color-adjust:exact;print-color-adjust:exact;color:#84857a;display:flex;font-family:Arial,Helvetica,sans-serif;font-size:8px;justify-content:flex-end;padding:0 0.4in;width:100%;">
    <span style="align-items:center;display:flex;gap:5px;">
      <img alt="" src="${escapeHtml(logoDataUrl)}" style="height:9px;width:9px;">
      <span>Saved from Rally</span>
      <span style="opacity:0.6;padding-left:4px;"><span class="pageNumber"></span> / <span class="totalPages"></span></span>
    </span>
  </div>`;
}

async function withTimeout<T>(work: Promise<T>, milliseconds: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Message export timed out while ${label}`)), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Renders and saves one message at a time.
 *
 * Serialized deliberately: each export owns a Chromium window, and two of them
 * racing costs a window's worth of memory for no gain — nobody is waiting on the
 * second file while the first save dialog is still open.
 */
export class MessageExporter {
  private readonly documents = new Map<string, { html: string; expiresAt: number }>();
  private queue: Promise<unknown> = Promise.resolve();
  private fontFaces: Promise<string> | undefined;

  constructor(private readonly dependencies: MessageExportDependencies) {}

  /**
   * Answers the export document a window is asking for, or null when the token
   * is unknown, spent, or expired.
   *
   * **Reading it spends it.** A token is minted for one window and one
   * navigation, and Chromium asks once; anything asking a second time — a
   * reload, a request that raced the render, a URL that got out — is not that
   * navigation and gets nothing. The alternative, dropping it when the load
   * finished, left the document readable for as long as a capture took.
   */
  document(url: string): string | null {
    if (!isMessageExportUrl(url)) return null;
    const token = decodeURIComponent(new URL(url).pathname).replace(/^\/+/u, '');
    const entry = this.documents.get(token);
    if (!entry) return null;
    this.documents.delete(token);
    return entry.expiresAt <= this.dependencies.now() ? null : entry.html;
  }

  async save(request: MessageExportRequest): Promise<MessageExportResult> {
    // The tail is always an already-settled promise — `catch` below makes sure
    // of it — so this needs no rejection arm: an export that failed hands the
    // next one a resolved link rather than a poisoned chain.
    const run = this.queue.then(() => this.renderAndWrite(request));
    this.queue = run.then(() => undefined, () => undefined);
    return await run;
  }

  private async renderAndWrite(request: MessageExportRequest): Promise<MessageExportResult> {
    const bytes = await this.render(request);
    const fileType = MESSAGE_EXPORT_FILE_TYPES[request.format];
    const path = await this.dependencies.showSaveDialog({
      defaultFileName: `${request.fileName}.${fileType.extension}`,
      extension: fileType.extension,
      filterLabel: fileType.label,
    });
    if (!path) return { saved: false };
    await this.dependencies.writeFile(path, bytes);
    return { saved: true };
  }

  /**
   * The embedded faces, read on the first export, every file at once, and kept
   * for the rest of the session. A failed read is not kept, so the next export
   * tries again.
   */
  private loadFontFaces(): Promise<string> {
    this.fontFaces ??= Promise.all(MESSAGE_EXPORT_FONTS.map((font) => this.dependencies.readFont(font.file)))
      .then(messageExportFontFaces)
      .catch((error: unknown) => {
        this.fontFaces = undefined;
        throw error;
      });
    return this.fontFaces;
  }

  private async render(request: MessageExportRequest): Promise<Uint8Array> {
    const width = request.format === 'image' ? IMAGE_WIDTH : PDF_WIDTH;
    // The faces are read while the window starts its renderer process, not
    // before it. Rejecting here is handled by the `try` below, which owns the window.
    const fontFaces = this.loadFontFaces();
    fontFaces.catch(() => undefined);
    // The window comes first, and the token is published only once there is
    // something to load it: a `createWindow` that throws — during shutdown, or
    // out of resources — must not leave the document behind with no `finally`
    // to clear it.
    const window = this.dependencies.createWindow({ width, height: 900 });
    const token = this.dependencies.randomToken();
    try {
      const html = messageExportDocument({ ...request, fontFaces: await fontFaces });
      this.documents.set(token, { html, expiresAt: this.dependencies.now() + DOCUMENT_TTL_MS });
      return await withTimeout(this.draw(window, request, token, width), RENDER_TIMEOUT_MS, 'rendering the card');
    } finally {
      this.documents.delete(token);
      try {
        window.destroy();
      } catch (error) {
        this.dependencies.logWarning('could not close the message export window', error);
      }
    }
  }

  private async draw(
    window: MessageExportWindow,
    request: MessageExportRequest,
    token: string,
    width: number,
  ): Promise<Uint8Array> {
    await withTimeout(
      window.load(`${MESSAGE_EXPORT_SCHEME}://${MESSAGE_EXPORT_HOST}/${token}`),
      LOAD_TIMEOUT_MS,
      'loading the card',
    );
    if (request.format === 'pdf') {
      // Printing does not wait for web fonts on its own; a page printed before
      // they decode falls back to the system faces this module exists to avoid.
      await withTimeout(window.evaluate('document.fonts.ready.then(() => true)'), MEASURE_TIMEOUT_MS, 'loading the fonts');
      return await window.printPdf({
        footerHtml: messageExportFooter(request.logoDataUrl),
        margins: { top: 0.5, bottom: 0.62, left: 0.55, right: 0.55 },
      });
    }
    // The measurement is what makes the picture whole: a capture is of the
    // window's content area, so the window has to be exactly as tall as the card
    // before the shutter opens. It also wakes a window that has never been
    // shown, which otherwise has no reason to have painted anything yet.
    const measured = await withTimeout(window.evaluate(MEASURE_SCRIPT), MEASURE_TIMEOUT_MS, 'measuring the card');
    const height = typeof measured === 'number' && Number.isFinite(measured) && measured > 0
      ? Math.ceil(measured)
      : 900;
    const scale = height * IMAGE_SCALE <= IMAGE_MAX_DEVICE_HEIGHT ? IMAGE_SCALE : 1;
    const capturedHeight = Math.min(height, IMAGE_MAX_DEVICE_HEIGHT);
    window.resize(width * scale, capturedHeight * scale, scale);
    await this.dependencies.delay(SETTLE_MS);
    return await window.captureJpeg(92);
  }
}
