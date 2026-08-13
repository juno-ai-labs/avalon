/**
 * The contract behind the **Image** and **PDF** buttons under one of Avalon's
 * messages. The renderer turns the message's markdown into HTML with the same
 * component the feed uses; the main process lays that HTML out on a card,
 * renders it with Chromium, and writes the file the person chose.
 *
 * [`docs/message-export.md`](../../../../docs/message-export.md) owns the design.
 */

export type MessageExportFormat = 'image' | 'pdf';

export interface MessageExportRequest {
  format: MessageExportFormat;
  /**
   * The message's markdown, already rendered to HTML by `MarkdownBody`. It is
   * sent as HTML rather than as markdown because there is exactly one markdown
   * renderer in Avalon and it lives in the renderer process — see
   * [`docs/markdown-rendering.md`](../../../../docs/markdown-rendering.md).
   * It never carries script: `react-markdown` renders markup in its input as
   * text, and the export window runs the document under a policy that forbids
   * script anyway.
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
   * The Avalon mark as a `data:image/png;base64,…` URL, read by the renderer out
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

/** The extension, dialog filter name, and MIME type each format is written as. */
export const MESSAGE_EXPORT_FILE_TYPES: Record<MessageExportFormat, { extension: string; label: string }> = {
  image: { extension: 'jpg', label: 'JPEG image' },
  pdf: { extension: 'pdf', label: 'PDF document' },
};

/** Bounds every `fileName` the main process will accept. */
export const MESSAGE_EXPORT_FILE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,79}$/u;

/**
 * Turns a message's text into the file name stem offered in the save dialog:
 * the first line that carries words, stripped of markdown punctuation and
 * slugified. Falls back to `avalon-message`, which is also what an image made
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
  return `${slug || 'avalon-message'}-${savedOn}`;
}
