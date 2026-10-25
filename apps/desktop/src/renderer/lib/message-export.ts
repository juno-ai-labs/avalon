import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import markUrl from '@rally/ui/assets/rally-mark.png';
import type { MessageExportFormat, MessageExportResult, MessageExportScope } from '../../common/message-export';
import { desktopBridge } from './platform';

/**
 * The renderer's half of saving a message: it turns the message into HTML with
 * the feed's own markdown component and hands that to the main process, which
 * owns the card, Chromium, and the save dialog.
 * [`docs/message-export.md`](../../../../../docs/message-export.md) owns the design.
 */

/**
 * Renders `content` into a detached root and answers its markup.
 *
 * `MarkdownBody` is a React component and the only markdown renderer Rally has
 * — see [`docs/markdown-rendering.md`](../../../../../docs/markdown-rendering.md).
 * Rendering it here rather than passing markdown to the main process is what
 * keeps that true: the card shows the same DOM the feed does, and a fix to the
 * renderer reaches the exported picture without anyone remembering to.
 *
 * `flushSync` requires the content to render synchronously. `MarkdownBody`'s
 * `still` branch mounts no asynchronous Mermaid renderer (it keeps diagram
 * source as code), preview reader, `Suspense`, or `use()` — a suspended render
 * here would serialize a fallback into someone's file instead of showing one
 * on a screen where it would be noticed.
 *
 * The root is detached, so nothing about the current screen — its width, its
 * scroll position, the dark stylesheet around it — can reach the markup. The
 * effects that mount with it (a code block's copy button keeps state) run and
 * are torn down immediately; none of them changes what was serialized.
 */
export function renderToHtml(content: React.ReactElement): string {
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    flushSync(() => root.render(content));
    return container.innerHTML;
  } finally {
    root.unmount();
  }
}

let markDataUrl: Promise<string> | undefined;

/**
 * The Rally mark as a data URL, read once out of the renderer's own bundle.
 *
 * The main process cannot reach this file by path: Vite gives it a content
 * hash, and in a packaged build it lives inside the asar archive under that
 * hashed name. Sending the bytes with the request costs one fetch per session
 * and keeps the artwork in the one place it is already maintained.
 */
async function rallyMarkDataUrl(): Promise<string> {
  markDataUrl ??= (async () => {
    const response = await fetch(markUrl);
    const blob = await response.blob();
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.addEventListener('load', () => resolve(String(reader.result)));
      reader.addEventListener('error', () => reject(new Error('The Rally mark could not be read')));
      reader.readAsDataURL(blob);
    });
  })().catch((error: unknown) => {
    // A failed read must not poison every later export with the same rejection.
    markDataUrl = undefined;
    throw error;
  });
  return markDataUrl;
}

/**
 * Starts reading the mark now, for a save that still has its content to
 * gather, so the read runs beside that work instead of after it.
 */
export function prepareMessageExport(): void {
  void rallyMarkDataUrl().catch(() => undefined);
}

/** Saves content that is already HTML, rendered by `renderToHtml`. */
export async function saveRenderedExport(input: {
  contentHtml: string;
  fileName: string;
  format: MessageExportFormat;
  scope?: MessageExportScope;
}): Promise<MessageExportResult> {
  return await desktopBridge().exportMessage({
    contentHtml: input.contentHtml,
    fileName: input.fileName,
    format: input.format,
    ...(input.scope ? { scope: input.scope } : {}),
    logoDataUrl: await rallyMarkDataUrl(),
  });
}

export async function saveMessageExport(input: {
  content: React.ReactElement;
  fileName: string;
  format: MessageExportFormat;
}): Promise<MessageExportResult> {
  // The mark's read starts before the synchronous render, so the two overlap.
  prepareMessageExport();
  const { content, ...rest } = input;
  return await saveRenderedExport({ ...rest, contentHtml: renderToHtml(content) });
}
