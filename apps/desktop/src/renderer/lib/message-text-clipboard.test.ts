import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cloneMessageHtml,
  restoreMessageSelection,
  serializedPlainText,
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
    expect(snapshot.html).toContain('<strong>');
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

  it('strips copy chrome and keeps citation labels in a whole-body clone', () => {
    const root = mount(
      '<p>See <button type="button" class="citation-chip"><span class="citation-chip-label">the Q3 plan</span></button> for details.</p>'
      + '<button type="button" data-clipboard-exclude="" aria-label="Copy code">Copy code</button>',
    );
    const cloned = cloneMessageHtml(root);
    expect(cloned.plain).toBe('See the Q3 plan for details.');
    expect(cloned.html).toContain('the Q3 plan');
    expect(cloned.html).not.toContain('Copy code');
    expect(cloned.html).not.toContain('data-clipboard-exclude');
  });

  it('puts paragraph and list breaks into whole-body plain text', () => {
    const root = mount('<p>First para.</p><p>Second para.</p><ul><li>a</li><li>b</li></ul>');
    expect(cloneMessageHtml(root).plain).toBe('First para.\nSecond para.\na\nb');
    const withBreak = mount('<p>One</p><p>Two<br>Three</p>');
    expect(cloneMessageHtml(withBreak).plain).toBe('One\nTwo\nThree');
  });

  it('decodes entities when the HTML fallback has to supply plain text', async () => {
    const write = vi.fn<(items: ClipboardItemStub[]) => Promise<void>>(async () => undefined);
    class ClipboardItemStub {
      readonly items: Record<string, Blob>;
      constructor(items: Record<string, Blob>) {
        this.items = items;
      }
    }
    vi.stubGlobal('ClipboardItem', ClipboardItemStub);
    vi.stubGlobal('navigator', { clipboard: { write, writeText: vi.fn() } });

    await writeFormattedClipboard('<p>A &amp; B</p>', '');
    const item = write.mock.calls[0]?.[0]?.[0];
    expect(await item!.items['text/plain']!.text()).toBe('A & B');
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

  it('serializes a detached tree the same way cloneMessageHtml does', () => {
    const root = mount('<p>Keep me</p>');
    expect(serializedPlainText(root)).toBe('Keep me');
  });
});
