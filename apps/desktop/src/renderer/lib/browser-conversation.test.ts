import { describe, expect, it, vi } from 'vitest';
import type { EmbeddedBrowserCommand, EmbeddedBrowserResult, EmbeddedBrowserTab } from '../../common/embedded-browser';
import { browserConversation, loadThroughTab, providerSiteAllows } from './browser-conversation';

const tab = (id: string, title: string, url: string): EmbeddedBrowserTab => ({
  id, title, url, loading: false, canGoBack: false, canGoForward: false, favicon: null,
});

describe('browser conversations', () => {
  it('recognizes only signed-in and shared ChatGPT and Claude conversation routes', () => {
    expect(browserConversation(tab('a', 'Chat', 'https://chatgpt.com/c/6ab43c03-6b2c-83e8-9eba-f1c51fa1e7a0/')))
      .toEqual({ provider: 'chatgpt', id: '6ab43c03-6b2c-83e8-9eba-f1c51fa1e7a0', url: 'https://chatgpt.com/c/6ab43c03-6b2c-83e8-9eba-f1c51fa1e7a0', title: 'Chat', shared: false });
    expect(browserConversation(tab('b', '', 'https://claude.ai/chat/4f2b7c1e-9a3d-4e8b-b1c2-0d9e8f7a6b5c?x=1')))
      .toMatchObject({ provider: 'claude', url: 'https://claude.ai/chat/4f2b7c1e-9a3d-4e8b-b1c2-0d9e8f7a6b5c', title: 'Claude conversation' });
    expect(browserConversation(tab('c', 'Share', 'https://chatgpt.com/share/6ab43c03-6b2c-83e8-9eba-f1c51fa1e7a0')))
      .toMatchObject({ provider: 'chatgpt', shared: true });
    expect(browserConversation(tab('d', 'Wrong route', 'https://claude.ai/c/6ab43c03-6b2c-83e8-9eba-f1c51fa1e7a0'))).toBeNull();
    expect(browserConversation(tab('e', 'Home', 'https://claude.ai/new'))).toBeNull();
  });

  it('allows an import only its own provider’s sites, over HTTPS', () => {
    expect(providerSiteAllows('chatgpt', 'https://chatgpt.com/c/x')).toBe(true);
    expect(providerSiteAllows('chatgpt', 'https://files.oaiusercontent.com/f')).toBe(true);
    expect(providerSiteAllows('chatgpt', 'https://claude.ai/chat/x')).toBe(false);
    expect(providerSiteAllows('claude', 'https://x.frame.claudeusercontent.com/a.html')).toBe(true);
    expect(providerSiteAllows('claude', 'https://evilclaude.ai/')).toBe(false);
    expect(providerSiteAllows('claude', 'http://claude.ai/')).toBe(false);
    expect(providerSiteAllows('claude', 'not a url')).toBe(false);
  });

  it('stops loading a file through the tab once it passes the byte budget, and closes the stream', async () => {
    const chunks = [btoa('12345'), btoa('67890'), btoa('abcde')];
    const commandEmbeddedBrowser = vi.fn(async (command: EmbeddedBrowserCommand): Promise<EmbeddedBrowserResult> => {
      if (command.action !== 'cdp') return { kind: 'value', value: null };
      if (command.method === 'Page.getFrameTree') return { kind: 'value', value: { frameTree: { frame: { id: 'f' } } } };
      if (command.method === 'Network.loadNetworkResource') {
        return { kind: 'value', value: { resource: { success: true, httpStatusCode: 200, stream: 's1', headers: { 'Content-Type': 'text/html; charset=utf-8' } } } };
      }
      if (command.method === 'IO.read') return { kind: 'value', value: { data: chunks.shift(), base64Encoded: true, eof: chunks.length === 0 } };
      return { kind: 'value', value: {} };
    });
    const bridge = { commandEmbeddedBrowser };
    await expect(loadThroughTab(bridge, 't', 'https://x.frame.claudeusercontent.com/_f/v/a.html', 8)).resolves.toBe('too_large');
    expect(commandEmbeddedBrowser.mock.calls.filter(([command]) => command.action === 'cdp' && command.method === 'IO.read')).toHaveLength(2);
    expect(commandEmbeddedBrowser).toHaveBeenLastCalledWith({ action: 'cdp', tabId: 't', method: 'IO.close', params: { handle: 's1' } });
    chunks.splice(0, chunks.length, btoa('12345'));
    await expect(loadThroughTab(bridge, 't', 'https://x.frame.claudeusercontent.com/_f/v/a.html', 8))
      .resolves.toEqual({ data: btoa('12345'), contentType: 'text/html; charset=utf-8' });
  });
});
