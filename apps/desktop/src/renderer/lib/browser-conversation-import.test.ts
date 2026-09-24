import { describe, expect, it, vi } from 'vitest';
import type { EmbeddedBrowserCommand, EmbeddedBrowserResult, EmbeddedBrowserState, EmbeddedBrowserTab } from '../../common/embedded-browser';
import { browserConversation, loadThroughTab, readBrowserConversation } from './browser-conversation-import';

const tab = (id: string, title: string, url: string): EmbeddedBrowserTab => ({
  id, title, url, loading: false, canGoBack: false, canGoForward: false, favicon: null,
});

describe('browser conversation import', () => {
  it('recognizes only signed-in ChatGPT and Claude conversation routes', () => {
    expect(browserConversation(tab('a', 'Chat', 'https://chatgpt.com/c/6ab43c03-6b2c-83e8-9eba-f1c51fa1e7a0/')))
      .toEqual({ provider: 'chatgpt', id: '6ab43c03-6b2c-83e8-9eba-f1c51fa1e7a0', url: 'https://chatgpt.com/c/6ab43c03-6b2c-83e8-9eba-f1c51fa1e7a0', title: 'Chat', shared: false });
    expect(browserConversation(tab('b', '', 'https://claude.ai/chat/4f2b7c1e-9a3d-4e8b-b1c2-0d9e8f7a6b5c?x=1')))
      .toMatchObject({ provider: 'claude', url: 'https://claude.ai/chat/4f2b7c1e-9a3d-4e8b-b1c2-0d9e8f7a6b5c', title: 'Claude conversation' });
    expect(browserConversation(tab('c', 'Share', 'https://chatgpt.com/share/6ab43c03-6b2c-83e8-9eba-f1c51fa1e7a0')))
      .toMatchObject({ provider: 'chatgpt', shared: true, url: 'https://chatgpt.com/share/6ab43c03-6b2c-83e8-9eba-f1c51fa1e7a0' });
    expect(browserConversation(tab('s', '', 'https://claude.ai/share/f027df6e-0004-460c-8ec7-0666310a2ee2')))
      .toMatchObject({ provider: 'claude', shared: true, title: 'Shared Claude conversation' });
    expect(browserConversation(tab('d', 'Wrong host', 'https://claude.ai/c/6ab43c03-6b2c-83e8-9eba-f1c51fa1e7a0'))).toBeNull();
    expect(browserConversation(tab('e', 'Home', 'https://claude.ai/new'))).toBeNull();
  });

  it('reads the exact tab showing the conversation and reports the page’s own failure', async () => {
    const selected = tab('00000000-0000-7000-8000-000000000002', 'Selected chat', 'https://chatgpt.com/c/6ab43c03-6b2c-83e8-9eba-f1c51fa1e7a0');
    const other = tab('00000000-0000-7000-8000-000000000001', 'Other chat', 'https://chatgpt.com/c/6ab29fab-bb30-83e8-adcb-94f600c79a08');
    const commandEmbeddedBrowser = vi.fn()
      .mockResolvedValueOnce({ kind: 'value', value: { text: '{"title":"Selected chat"}' } })
      .mockResolvedValueOnce({ kind: 'value', value: { error: 'Sign in to ChatGPT, then try again.' } });
    const bridge = { getEmbeddedBrowserState: vi.fn().mockResolvedValue({ activeTabId: other.id, tabs: [other, selected] }), commandEmbeddedBrowser };
    await expect(readBrowserConversation(bridge, selected.url)).resolves.toEqual({ provider: 'chatgpt', text: '{"title":"Selected chat"}' });
    expect(commandEmbeddedBrowser).toHaveBeenCalledWith(expect.objectContaining({ action: 'evaluate', tabId: selected.id }));
    await expect(readBrowserConversation(bridge, selected.url)).rejects.toThrow('Sign in to ChatGPT, then try again.');
    await expect(readBrowserConversation(bridge, 'https://chatgpt.com/c/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'))
      .rejects.toThrow('Open this conversation');
    expect(commandEmbeddedBrowser).toHaveBeenCalledTimes(2);
  });

  it('hands the page scripts that parse, for both providers', async () => {
    // The readers are source text inside template literals; an escape that
    // survives TypeScript can still break, or silently change, the page script.
    for (const url of ['https://chatgpt.com/c/6ab43c03-6b2c-83e8-9eba-f1c51fa1e7a0', 'https://claude.ai/chat/4f2b7c1e-9a3d-4e8b-b1c2-0d9e8f7a6b5c',
      'https://chatgpt.com/share/6ab43c03-6b2c-83e8-9eba-f1c51fa1e7a0', 'https://claude.ai/share/f027df6e-0004-460c-8ec7-0666310a2ee2']) {
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

  it('stops loading a file through the tab once it passes the byte budget, and closes the stream', async () => {
    const chunks = [btoa('12345'), btoa('67890'), btoa('abcde')];
    const commandEmbeddedBrowser = vi.fn(async (command: EmbeddedBrowserCommand): Promise<EmbeddedBrowserResult> => {
      if (command.action !== 'cdp') return { kind: 'value', value: null };
      if (command.method === 'Network.loadNetworkResource') return { kind: 'value', value: { resource: { success: true, httpStatusCode: 200, stream: 's1' } } };
      if (command.method === 'IO.read') return { kind: 'value', value: { data: chunks.shift(), base64Encoded: true, eof: chunks.length === 0 } };
      return { kind: 'value', value: {} };
    });
    const bridge = { getEmbeddedBrowserState: vi.fn(), commandEmbeddedBrowser };
    await expect(loadThroughTab(bridge, 't', 'f', 'https://x.frame.claudeusercontent.com/_f/v/a.html', 8)).resolves.toBeNull();
    expect(commandEmbeddedBrowser.mock.calls.filter(([command]) => command.action === 'cdp' && command.method === 'IO.read')).toHaveLength(2);
    expect(commandEmbeddedBrowser).toHaveBeenLastCalledWith({ action: 'cdp', tabId: 't', method: 'IO.close', params: { handle: 's1' } });
    chunks.splice(0, chunks.length, btoa('12345'));
    await expect(loadThroughTab(bridge, 't', 'f', 'https://x.frame.claudeusercontent.com/_f/v/a.html', 8)).resolves.toBe(btoa('12345'));
  });

  it('reads the tab the person is looking at when several show the conversation', async () => {
    const url = 'https://chatgpt.com/c/6ab43c03-6b2c-83e8-9eba-f1c51fa1e7a0';
    const background = tab('00000000-0000-7000-8000-000000000001', 'Chat', url);
    const active = tab('00000000-0000-7000-8000-000000000002', 'Chat', url);
    const commandEmbeddedBrowser = vi.fn(async (): Promise<EmbeddedBrowserResult> => ({ kind: 'value', value: { text: '{}' } }));
    const bridge = { getEmbeddedBrowserState: vi.fn().mockResolvedValue({ activeTabId: active.id, tabs: [background, active] }), commandEmbeddedBrowser };
    await readBrowserConversation(bridge, url);
    expect(commandEmbeddedBrowser).toHaveBeenCalledWith(expect.objectContaining({ action: 'evaluate', tabId: active.id }));
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
