import { describe, expect, it, vi } from 'vitest';
import type { EmbeddedBrowserCommand, EmbeddedBrowserResult, EmbeddedBrowserState, EmbeddedBrowserTab } from '../../common/embedded-browser';
import { browserConversation, readBrowserConversation } from './browser-conversation-import';

const tab = (id: string, title: string, url: string): EmbeddedBrowserTab => ({
  id, title, url, loading: false, canGoBack: false, canGoForward: false,
});

describe('browser conversation import', () => {
  it('recognizes only signed-in ChatGPT and Claude conversation routes', () => {
    expect(browserConversation(tab('a', 'Chat', 'https://example.com/research-note/')))
      .toEqual({ provider: 'chatgpt', id: '6ab43c03-6b2c-83e8-9eba-f1c51fa1e7a0', url: 'https://example.com/research-note', title: 'Chat', shared: false });
    expect(browserConversation(tab('b', '', 'https://claude.ai/chat/4f2b7c1e-9a3d-4e8b-b1c2-0d9e8f7a6b5c?x=1')))
      .toMatchObject({ provider: 'claude', url: 'https://claude.ai/chat/4f2b7c1e-9a3d-4e8b-b1c2-0d9e8f7a6b5c', title: 'Claude conversation' });
    expect(browserConversation(tab('c', 'Share', 'https://example.com/research-note')))
      .toMatchObject({ provider: 'chatgpt', shared: true, url: 'https://example.com/research-note' });
    expect(browserConversation(tab('s', '', 'https://claude.ai/share/f027df6e-0004-460c-8ec7-0666310a2ee2')))
      .toMatchObject({ provider: 'claude', shared: true, title: 'Shared Claude conversation' });
    expect(browserConversation(tab('d', 'Wrong host', 'https://claude.ai/c/6ab43c03-6b2c-83e8-9eba-f1c51fa1e7a0'))).toBeNull();
    expect(browserConversation(tab('e', 'Home', 'https://claude.ai/new'))).toBeNull();
  });

  it('reads the exact tab showing the conversation and reports the page’s own failure', async () => {
    const selected = tab('00000000-0000-7000-8000-000000000002', 'Selected chat', 'https://example.com/research-note');
    const other = tab('00000000-0000-7000-8000-000000000001', 'Other chat', 'https://example.com/research-note');
    const commandEmbeddedBrowser = vi.fn()
      .mockResolvedValueOnce({ kind: 'value', value: { text: '{"title":"Selected chat"}' } })
      .mockResolvedValueOnce({ kind: 'value', value: { error: 'Sign in to ChatGPT, then try again.' } });
    const bridge = { getEmbeddedBrowserState: vi.fn().mockResolvedValue({ activeTabId: other.id, tabs: [other, selected] }), commandEmbeddedBrowser };
    await expect(readBrowserConversation(bridge, selected.url)).resolves.toEqual({ provider: 'chatgpt', text: '{"title":"Selected chat"}' });
    expect(commandEmbeddedBrowser).toHaveBeenCalledWith(expect.objectContaining({ action: 'evaluate', tabId: selected.id }));
    await expect(readBrowserConversation(bridge, selected.url)).rejects.toThrow('Sign in to ChatGPT, then try again.');
    await expect(readBrowserConversation(bridge, 'https://example.com/research-note'))
      .rejects.toThrow('Open this conversation');
    expect(commandEmbeddedBrowser).toHaveBeenCalledTimes(2);
  });

  it('hands the page scripts that parse, for both providers', async () => {
    // The readers are source text inside template literals; an escape that
    // survives TypeScript can still break, or silently change, the page script.
    for (const url of ['https://example.com/research-note', 'https://claude.ai/chat/4f2b7c1e-9a3d-4e8b-b1c2-0d9e8f7a6b5c',
      'https://example.com/research-note', 'https://claude.ai/share/f027df6e-0004-460c-8ec7-0666310a2ee2']) {
      const commandEmbeddedBrowser = vi.fn(async (): Promise<EmbeddedBrowserResult> => ({ kind: 'value', value: { text: '{}' } }));
      const bridge = { getEmbeddedBrowserState: vi.fn().mockResolvedValue({ activeTabId: 't', tabs: [tab('t', 'Chat', url)] }), commandEmbeddedBrowser };
      await readBrowserConversation(bridge, url);
      const expression = (commandEmbeddedBrowser.mock.calls[0] as unknown as [{ expression: string }])[0].expression;
      expect(() => new Function(`return ${expression}`)).not.toThrow();
      expect(expression).not.toMatch(/\[\^\)s\]/u);
      expect(expression).toContain(url.includes('/share/') ? (url.includes('chatgpt') ? '/backend-anon/share/' : '/api/chat_snapshots/')
        : url.includes('chatgpt') ? String.raw`/\]\((sandbox:[^)\s]+)\)/g` : 'wiggle/download-file');
    }
  });

  it('opens a closed source for the read and closes that tab afterwards', async () => {
    const url = 'https://claude.ai/chat/4f2b7c1e-9a3d-4e8b-b1c2-0d9e8f7a6b5c';
    const existing = tab('00000000-0000-7000-8000-000000000001', 'New tab', 'about:blank');
    const opened = tab('00000000-0000-7000-8000-000000000003', 'Claude', url);
    const before: EmbeddedBrowserState = { activeTabId: existing.id, tabs: [existing] };
    const commandEmbeddedBrowser = vi.fn(async (command: EmbeddedBrowserCommand): Promise<EmbeddedBrowserResult> => command.action === 'open'
      ? { kind: 'state', state: { activeTabId: opened.id, tabs: [existing, opened] } }
      : command.action === 'evaluate' ? { kind: 'value', value: { text: '{"uuid":"x"}' } }
        : { kind: 'state', state: before });
    const bridge = { getEmbeddedBrowserState: vi.fn().mockResolvedValue(before), commandEmbeddedBrowser };
    await expect(readBrowserConversation(bridge, url, { openIfMissing: true })).resolves.toEqual({ provider: 'claude', text: '{"uuid":"x"}' });
    expect(commandEmbeddedBrowser.mock.calls.map(([command]) => command)).toEqual([
      { action: 'open', url },
      expect.objectContaining({ action: 'evaluate', tabId: opened.id }),
      { action: 'close', tabId: opened.id },
    ]);
  });
});
