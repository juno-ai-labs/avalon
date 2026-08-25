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

const MessageExportRequestSchema = z.object({
  format: z.enum(['image', 'pdf']),
  contentHtml: z.string().min(1).max(MAX_CONTENT_HTML_LENGTH),
  fileName: z.string().regex(MESSAGE_EXPORT_FILE_NAME_PATTERN),
  logoDataUrl: z.string().max(MAX_LOGO_LENGTH).regex(/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/u),
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
  if (!parsed.success) throw new Error('Invalid message export request');
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
  readonly logWarning: (message: string, error: unknown) => void;
  readonly randomToken: () => string;
  readonly now: () => number;
  readonly delay: (milliseconds: number) => Promise<void>;
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
  const colours = ['#cedc00', '#47c7fc', '#ff8a50', '#b995f5', '#2f7d5c'];
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
function stylesheet(format: MessageExportFormat, logoDataUrl: string, seed: number): string {
  const splash = splashBackground(seed);
  const syntax = Object.entries(exportSyntaxPalette)
    .map(([property, value]) => `    ${property}: ${value};`)
    .join('\n');
  return `
  :root {
${syntax}
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    -webkit-font-smoothing: antialiased;
    color: #24251c;
    font-family: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
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
    font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
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
    font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
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
  .mention-text-fallback { color: #3d3f33; font-weight: 560; }
  /* Paged output only: a heading stranded at the foot of a page reads as a
     heading for nothing, and a table split across pages loses its header. */
  blockquote, table, .markdown-code-block { break-inside: avoid-page; }
  h1, h2, h3, h4 { break-after: avoid-page; break-inside: avoid-page; }
  `;
}

/** The card, as a complete document ready for Chromium. */
export function messageExportDocument(input: {
  format: MessageExportFormat;
  contentHtml: string;
  logoDataUrl: string;
}): string {
  // `contentHtml` is interpolated as markup, not escaped, because it *is* the
  // rendered message. What makes that safe is upstream: `MarkdownBody` mounts
  // `react-markdown` with no `rehype-raw`, so HTML in a model's markdown is
  // already text by the time it reaches here. The window's `default-src 'none'`
  // is the second lock. Both have to hold — a raw-HTML plug-in added to the
  // renderer would turn this into an injection point.
  const seed = seedFrom(input.contentHtml);
  const signature = `<div class="export-signature"><span class="export-mark"></span>Saved from Avalon</div>`;
  const card = `<div class="export-card"><div class="markdown-body">${input.contentHtml}</div>${
    input.format === 'image' ? signature : ''
  }</div>`;
  return [
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Saved from Avalon</title>',
    `<style>${stylesheet(input.format, input.logoDataUrl, seed)}</style></head>`,
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
 */
export function messageExportFooter(logoDataUrl: string): string {
  return `<div style="-webkit-print-color-adjust:exact;print-color-adjust:exact;color:#84857a;display:flex;font-family:Inter,-apple-system,sans-serif;font-size:8px;justify-content:flex-end;padding:0 0.4in;width:100%;">
    <span style="align-items:center;display:flex;gap:5px;">
      <img alt="" src="${escapeHtml(logoDataUrl)}" style="height:9px;width:9px;">
      <span>Saved from Avalon</span>
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

  private async render(request: MessageExportRequest): Promise<Uint8Array> {
    const width = request.format === 'image' ? IMAGE_WIDTH : PDF_WIDTH;
    const html = messageExportDocument(request);
    // The window comes first, and the token is published only once there is
    // something to load it: a `createWindow` that throws — during shutdown, or
    // out of resources — must not leave the document behind with no `finally`
    // to clear it.
    const window = this.dependencies.createWindow({ width, height: 900 });
    const token = this.dependencies.randomToken();
    this.documents.set(token, { html, expiresAt: this.dependencies.now() + DOCUMENT_TTL_MS });
    try {
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
