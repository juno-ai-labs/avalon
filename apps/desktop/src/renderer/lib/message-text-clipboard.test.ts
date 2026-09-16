import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cloneMessageHtml,
  restoreMessageSelection,
  snapshotMessageSelection,
  writeFormattedClipboard,
} from './message-text-clipboard';

function mount(html: string): HTMLElement {
  const root = document.createElement('div');
  root.innerHTML = html;
  document.body.append(root);
  return root;
}

afterEach(() => {
  document.body.replaceChildren();
  window.getSelection()?.removeAllRanges();
  vi.unstubAllGlobals();
});

describe('message text clipboard', () => {
  it('snapshots a selection inside the body and restores that range', () => {
    const root = mount('<p>Hello <strong>there</strong></p>');
    const strong = root.querySelector('strong')!;
    const range = document.createRange();
    range.selectNodeContents(strong);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    const snapshot = snapshotMessageSelection(root);
    expect(snapshot.plain).toBe('there');
    expect(snapshot.html).toContain('there');
    selection.removeAllRanges();
    expect(window.getSelection()?.toString()).toBe('');

    restoreMessageSelection(snapshot.range);
    expect(window.getSelection()?.toString()).toBe('there');
  });

  it('ignores a selection that lives outside the body', () => {
    const root = mount('<p>Inside</p>');
    const outside = mount('<p>Outside</p>');
    const range = document.createRange();
    range.selectNodeContents(outside);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    expect(snapshotMessageSelection(root)).toEqual({ html: '', plain: '', range: null });
  });

  it('strips copy buttons from a whole-body clone', () => {
    const root = mount('<p>Body copy</p><button type="button">Copy code</button>');
    const cloned = cloneMessageHtml(root);
    expect(cloned.plain).toContain('Body copy');
    expect(cloned.html).not.toContain('Copy code');
    expect(cloned.html).toContain('Body copy');
  });

  it('writes HTML and plain text together when ClipboardItem is available', async () => {
    const write = vi.fn<(items: ClipboardItemStub[]) => Promise<void>>(async () => undefined);
    class ClipboardItemStub {
      readonly items: Record<string, Blob>;
      constructor(items: Record<string, Blob>) {
        this.items = items;
      }
    }
    vi.stubGlobal('ClipboardItem', ClipboardItemStub);
    vi.stubGlobal('navigator', { clipboard: { write, writeText: vi.fn() } });

    await writeFormattedClipboard('<p>Hi</p>', 'Hi');

    expect(write).toHaveBeenCalledOnce();
    const item = write.mock.calls[0]?.[0]?.[0];
    expect(item).toBeDefined();
    expect(item!.items['text/html']).toBeInstanceOf(Blob);
    expect(item!.items['text/plain']).toBeInstanceOf(Blob);
    expect(await item!.items['text/html']!.text()).toBe('<p>Hi</p>');
    expect(await item!.items['text/plain']!.text()).toBe('Hi');
  });
});
