/**
 * Snapshot and write the formatted contents of a message body.
 *
 * The Radix context menu can clear the live selection once it opens, so Copy
 * and Look Up have to read the range from the `contextmenu` event, not from
 * the item click that follows. Buttons inside the clone (code-block copy)
 * are chrome, not the message, and are stripped before anything is written.
 */

const INTERACTIVE_SELECTOR = 'button, [role="button"]';

export interface MessageTextSnapshot {
  html: string;
  plain: string;
  range: Range | null;
}

export const EMPTY_MESSAGE_TEXT_SNAPSHOT: MessageTextSnapshot = {
  html: '',
  plain: '',
  range: null,
};

function stripInteractive(root: ParentNode): void {
  for (const node of root.querySelectorAll(INTERACTIVE_SELECTOR)) node.remove();
}

export function snapshotMessageSelection(root: HTMLElement): MessageTextSnapshot {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return EMPTY_MESSAGE_TEXT_SNAPSHOT;
  }
  const range = selection.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) return EMPTY_MESSAGE_TEXT_SNAPSHOT;
  const holder = document.createElement('div');
  holder.appendChild(range.cloneContents());
  stripInteractive(holder);
  return {
    html: holder.innerHTML,
    plain: selection.toString(),
    range: range.cloneRange(),
  };
}

export function cloneMessageHtml(root: HTMLElement): { html: string; plain: string } {
  const clone = root.cloneNode(true) as HTMLElement;
  stripInteractive(clone);
  return {
    html: clone.innerHTML,
    plain: clone.innerText || clone.textContent || '',
  };
}

export function restoreMessageSelection(range: Range | null): void {
  if (!range) return;
  const selection = window.getSelection();
  if (!selection) return;
  selection.removeAllRanges();
  selection.addRange(range);
}

export async function writeFormattedClipboard(html: string, plain: string): Promise<void> {
  const text = plain.length > 0 ? plain : html.replace(/<[^>]+>/gu, '');
  if (text.length === 0) return;
  if (typeof ClipboardItem !== 'undefined' && typeof navigator.clipboard.write === 'function') {
    await navigator.clipboard.write([
      new ClipboardItem({
        'text/html': new Blob([html], { type: 'text/html' }),
        'text/plain': new Blob([text], { type: 'text/plain' }),
      }),
    ]);
    return;
  }
  await navigator.clipboard.writeText(text);
}
