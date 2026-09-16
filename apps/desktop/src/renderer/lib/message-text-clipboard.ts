/**
 * Snapshot and write the formatted contents of a message body.
 *
 * The Radix context menu can clear the live selection once it opens, so Copy
 * and Look Up have to read the range from the `contextmenu` event, not from
 * the item click that follows. Chrome marked `data-clipboard-exclude` (the
 * code-block copy control, heading chevrons) is stripped; content-bearing
 * buttons such as citation chips are unwrapped so their labels survive.
 */

const CLIPBOARD_EXCLUDE_SELECTOR = '[data-clipboard-exclude]';
const INTERACTIVE_SELECTOR = 'button, [role="button"]';
const BLOCK_TAGS = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'BR', 'DD', 'DIV', 'DL', 'DT',
  'FIGCAPTION', 'FIGURE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HR', 'LI', 'OL',
  'P', 'PRE', 'SECTION', 'TABLE', 'TR', 'UL',
]);

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

function sanitizeClone(root: ParentNode): void {
  for (const node of [...root.querySelectorAll(CLIPBOARD_EXCLUDE_SELECTOR)]) node.remove();
  for (const node of [...root.querySelectorAll(INTERACTIVE_SELECTOR)]) {
    node.replaceWith(...node.childNodes);
  }
}

/**
 * `innerText` on a detached clone is `textContent` (no block breaks). Walk
 * the sanitized tree so whole-body Copy and Share get the same rendered
 * prose in jsdom and in Chromium.
 */
export function serializedPlainText(root: Node): string {
  const parts: string[] = [];
  const visit = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      parts.push(node.nodeValue ?? '');
      return;
    }
    if (!(node instanceof Element)) return;
    if (node.matches(CLIPBOARD_EXCLUDE_SELECTOR)) return;
    if (node.tagName === 'BR') {
      parts.push('\n');
      return;
    }
    if (node.tagName === 'SCRIPT' || node.tagName === 'STYLE') return;
    for (const child of node.childNodes) visit(child);
    if (BLOCK_TAGS.has(node.tagName)) parts.push('\n');
  };
  visit(root);
  return parts.join('').replace(/^\n+|\n+$/gu, '');
}

function cloneRangeContents(range: Range, root: HTMLElement): HTMLElement {
  const holder = document.createElement('div');
  let contents: Node = range.cloneContents();
  let ancestor: Node | null = range.commonAncestorContainer;
  if (ancestor.nodeType === Node.TEXT_NODE) ancestor = ancestor.parentNode;
  while (ancestor && ancestor !== root && ancestor instanceof Element) {
    const wrapper = ancestor.cloneNode(false);
    wrapper.appendChild(contents);
    contents = wrapper;
    ancestor = ancestor.parentElement;
  }
  holder.appendChild(contents);
  return holder;
}

export function snapshotMessageSelection(root: HTMLElement): MessageTextSnapshot {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return EMPTY_MESSAGE_TEXT_SNAPSHOT;
  }
  const range = selection.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) return EMPTY_MESSAGE_TEXT_SNAPSHOT;
  const holder = cloneRangeContents(range, root);
  sanitizeClone(holder);
  return {
    html: holder.innerHTML,
    plain: serializedPlainText(holder),
    range: range.cloneRange(),
  };
}

export function cloneMessageHtml(root: HTMLElement): { html: string; plain: string } {
  const clone = root.cloneNode(true) as HTMLElement;
  sanitizeClone(clone);
  return {
    html: clone.innerHTML,
    plain: serializedPlainText(clone),
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
  const holder = document.createElement('div');
  holder.innerHTML = html;
  const text = plain.length > 0 ? plain : serializedPlainText(holder);
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
