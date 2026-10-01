import { describe, expect, it, vi } from 'vitest';
import type { EmbeddedBrowserCommand, EmbeddedBrowserResult, EmbeddedBrowserState, EmbeddedBrowserTab } from '../../common/embedded-browser';
import { browserConversation, loadThroughTab, readBrowserConversation } from './browser-conversation-import';

const tab = (id: string, title: string, url: string): EmbeddedBrowserTab => ({
  id, title, url, loading: false, canGoBack: false, canGoForward: false, favicon: null,
});

const sharedChatGptConversation = () => ({
  conversation_id: '6ab43c03-6b2c-83e8-9eba-f1c51fa1e7a0',
  current_node: 'node-a',
  title: 'Branch · Launch Email management',
  mapping: {
    'node-a': {
      id: 'node-a',
      parent: null,
      message: { id: 'node-a', author: { role: 'assistant' }, content: { content_type: 'text', parts: ['hello'] } },
    },
  },
});

const chatgptLocation = (url: string) => {
  const parsed = new URL(url);
  return { origin: parsed.origin, pathname: parsed.pathname, href: url };
};

function jsonResponse(body: unknown, failed = false) {
  return { ok: !failed, json: async () => body ?? {} };
}

function turboStreamEnqueue(value: unknown): string {
  const hole = { hole: true };
  const values: unknown[] = [];
  const intern = (node: unknown): number => {
    if (node === undefined) return -5;
    if (typeof node === 'string' || typeof node === 'boolean' || node === null) {
      const existing = values.indexOf(node);
      if (existing >= 0) return existing;
      values.push(node);
      return values.length - 1;
    }
    const idx = values.length;
    values.push(hole);
    if (Array.isArray(node)) {
      values[idx] = node.map(intern);
      return idx;
    }
    if (node && typeof node === 'object') {
      const encoded: Record<string, number> = {};
      for (const [key, val] of Object.entries(node as Record<string, unknown>)) encoded[`_${intern(key)}`] = intern(val);
      values[idx] = encoded;
      return idx;
    }
    values[idx] = node;
    return idx;
  };
  intern(value);
  return `window.__reactRouterContext.streamController.enqueue(${JSON.stringify(JSON.stringify(values))});`;
}

async function generatedReader(url: string): Promise<string> {
  const commandEmbeddedBrowser = vi.fn(async (): Promise<EmbeddedBrowserResult> => ({ kind: 'value', value: { text: '{}' } }));
  const bridge = { getEmbeddedBrowserState: vi.fn().mockResolvedValue({ activeTabId: 't', tabs: [tab('t', 'Chat', url)] }), commandEmbeddedBrowser };
  await readBrowserConversation(bridge, url);
  return (commandEmbeddedBrowser.mock.calls[0] as unknown as [{ expression: string }])[0].expression;
}

async function runGeneratedReader(
  expression: string,
  extras: {
    fetch: (input: string, init?: RequestInit) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;
    location: { origin: string; pathname: string; href: string };
    document: { querySelectorAll: (selector: string) => Array<{ textContent: string }> };
    window: { __reactRouterContext?: unknown };
  },
) {
  const run = new Function('fetch', 'location', 'document', 'window', `return ${expression}`);
  return run(extras.fetch, extras.location, extras.document, extras.window) as Promise<{ text?: string; error?: string | null }>;
}

function expectImportedConversation(result: { text?: string; error?: string | null }, conversation: ReturnType<typeof sharedChatGptConversation>) {
  expect(result.error ?? null).toBeNull();
  const parsed = JSON.parse(result.text ?? '');
  expect(parsed).toMatchObject({
    conversation_id: conversation.conversation_id,
    current_node: conversation.current_node,
    title: conversation.title,
    mapping: { 'node-a': { message: { content: { parts: ['hello'] } } } },
  });
}

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
      if (url.includes('chatgpt.com/share/')) {
        expect(expression).toContain('streamController.enqueue(');
        expect(expression).toContain('/backend-api/share/');
      }
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

  it('imports a shared ChatGPT conversation from the page when the share API refuses', async () => {
    const url = 'https://chatgpt.com/share/6ab43c03-6b2c-83e8-9eba-f1c51fa1e7a0';
    const conversation = sharedChatGptConversation();
    const fetch = vi.fn(async (input: string) => jsonResponse(String(input).includes('/api/auth/session') ? {} : null, !String(input).includes('/api/auth/session')));
    const expression = await generatedReader(url);
    const fromScript = await runGeneratedReader(expression, {
      fetch, location: chatgptLocation(url), window: {},
      document: { querySelectorAll: () => [{ textContent: turboStreamEnqueue({ loaderData: { 'routes/share.$shareId.($action)': { serverResponse: { type: 'data', data: conversation } } } }) }] },
    });
    expectImportedConversation(fromScript, conversation);
    expect(fetch.mock.calls.some(([input]) => String(input).includes('/backend-anon/share/') || String(input).includes('/backend-api/share/'))).toBe(false);

    const fromContext = await runGeneratedReader(expression, {
      fetch, location: chatgptLocation(url), document: { querySelectorAll: () => [] },
      window: { __reactRouterContext: { state: { loaderData: { 'routes/share.$shareId.($action)': { serverResponse: { data: conversation } } } } } },
    });
    expectImportedConversation(fromContext, conversation);
  });

  it('falls back to ChatGPT’s share API, then reports the page’s refusal', async () => {
    const url = 'https://chatgpt.com/share/6ab43c03-6b2c-83e8-9eba-f1c51fa1e7a0';
    const conversation = sharedChatGptConversation();
    const expression = await generatedReader(url);
    const page = { fetch: vi.fn(async (input: string) => {
      const path = String(input);
      if (path.includes('/api/auth/session')) return jsonResponse({ accessToken: 'tok' });
      if (path.includes('/backend-api/share/')) return jsonResponse(conversation);
      return jsonResponse(null, true);
    }), location: chatgptLocation(url), document: { querySelectorAll: () => [] }, window: {} };
    expectImportedConversation(await runGeneratedReader(expression, page), conversation);
    expect(page.fetch).toHaveBeenCalledWith('/backend-anon/share/6ab43c03-6b2c-83e8-9eba-f1c51fa1e7a0', expect.objectContaining({ credentials: 'include' }));
    expect(page.fetch).toHaveBeenCalledWith('/backend-api/share/6ab43c03-6b2c-83e8-9eba-f1c51fa1e7a0', expect.objectContaining({
      credentials: 'include', headers: { Authorization: 'Bearer tok' },
    }));

    const refused = { fetch: vi.fn(async () => jsonResponse(null, true)), location: chatgptLocation(url), document: { querySelectorAll: () => [] }, window: {} };
    await expect(runGeneratedReader(expression, refused)).resolves.toEqual({ error: 'ChatGPT could not return this conversation.' });
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
