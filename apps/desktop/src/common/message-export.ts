/**
 * The contract behind the **Image** and **PDF** buttons under one of Rally's
 * messages. The renderer turns the message's markdown into HTML with the same
 * component the feed uses; the main process lays that HTML out on a card,
 * renders it with Chromium, and writes the file the person chose.
 *
 * [`docs/message-export.md`](../../../../docs/message-export.md) owns the design.
 */

export type MessageExportFormat = 'image' | 'pdf';

/**
 * What the HTML holds: one message, or a whole Thread or Breakout. A
 * conversation is always a PDF, since a picture of one would be a strip no
 * one could read, and it carries no size bound of its own: the person asked
 * for all of it, and a ceiling would refuse exactly the long ones.
 */
export type MessageExportScope = 'message' | 'conversation';

export interface MessageExportRequest {
  format: MessageExportFormat;
  /** Absent means `message`, which is what every request was before conversations. */
  scope?: MessageExportScope | undefined;
  /**
   * The message's markdown, already rendered to HTML by `MarkdownBody`. It is
   * sent as HTML rather than as markdown because there is exactly one markdown
   * renderer in Rally and it lives in the renderer process — see
   * [`docs/markdown-rendering.md`](../../../../docs/markdown-rendering.md).
   * It never carries script: `react-markdown` renders markup in its input as
   * text, with only the closed bare-break rewrite producing an empty `<br>`,
   * and the export window runs the document under a policy that forbids script
   * anyway.
   */
  contentHtml: string;
  /**
   * The file name offered in the save dialog, without an extension. Lowercase
   * letters, digits, and hyphens only — the main process rejects anything else
   * rather than sanitizing it, so a name that could escape the chosen directory
   * cannot be built out of a message's text.
   */
  fileName: string;
  /**
   * The Rally mark as a `data:image/png;base64,…` URL, read by the renderer out
   * of its own bundle. It travels with the request because the mark is a hashed
   * Vite asset the main process has no stable path to, in development or inside
   * an asar archive.
   */
  logoDataUrl: string;
}

export interface MessageExportResult {
  /** False when the person dismissed the save dialog. Nothing was written. */
  saved: boolean;
}

/** The extension and the dialog filter label each format is written under. */
export const MESSAGE_EXPORT_FILE_TYPES: Record<MessageExportFormat, { extension: string; label: string }> = {
  image: { extension: 'jpg', label: 'JPEG image' },
  pdf: { extension: 'pdf', label: 'PDF document' },
};

/** Bounds every `fileName` the main process will accept. */
export const MESSAGE_EXPORT_FILE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,79}$/u;

/**
 * The date a save is happening on, as the person's own calendar has it.
 *
 * Deliberately not `toISOString().slice(0, 10)`, which is UTC: half of every
 * evening west of Greenwich would be filed under tomorrow, and the file names
 * of an evening's work would not sort with the day it belonged to.
 */
export function messageExportDate(now: Date): string {
  const padded = (value: number): string => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${padded(now.getMonth() + 1)}-${padded(now.getDate())}`;
}

/**
 * Turns a message's text into the file name stem offered in the save dialog:
 * the first line that carries words, stripped of markdown punctuation and
 * slugified. Falls back to `rally-message`, which is also what an image made
 * entirely of a table or a code block is called.
 */
export function messageExportFileName(text: string, savedOn: string): string {
  const firstLine = text
    .split('\n')
    // A fence's opening line is `sql`, not a title, and a message that begins
    // with a code block is exactly the kind worth saving as a picture.
    .filter((line) => !/^\s*(?:```|~~~)/u.test(line))
    .map((line) => line.replaceAll(/[#>*_`~\-[\]()!]/gu, ' ').trim())
    .find((line) => /[a-z0-9]/iu.test(line)) ?? '';
  const slug = firstLine
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, '-')
    .replaceAll(/^-+|-+$/gu, '')
    .slice(0, 48)
    .replaceAll(/-+$/gu, '');
  return `${slug || 'rally-message'}-${savedOn}`;
}
