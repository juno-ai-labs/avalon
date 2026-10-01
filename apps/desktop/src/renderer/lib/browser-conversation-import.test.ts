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

function jsonResponse(body: unknown, failed = false, malformed = false) {
  return {
    ok: !failed,
    json: async () => {
      if (malformed) throw new SyntaxError('Unexpected token');
      return body ?? {};
    },
  };
}

/**
 * Trimmed enqueue in the format ChatGPT's share HTML used on 2026-10-01
 * (`chatgpt.com/share/6ab55fb7-…`): objects as `{_<keyIdx>:<valueIdx>}`, `-5`
 * for null. Conversation fields reduced to one mapping node; ids match the
 * test share URL.
 */
const capturedShareEnqueue = 'streamController.enqueue("[{\\"_32\\":1,\\"_33\\":-5,\\"_34\\":-5},{\\"_31\\":2},{\\"_30\\":3},{\\"_29\\":4},{\\"_6\\":5,\\"_8\\":7,\\"_10\\":9,\\"_28\\":11},\\"6ab43c03-6b2c-83e8-9eba-f1c51fa1e7a0\\",\\"conversation_id\\",\\"node-a\\",\\"current_node\\",\\"Branch \\\\u00b7 Launch Email management\\",\\"title\\",{\\"_7\\":12},{\\"_13\\":7,\\"_14\\":-5,\\"_27\\":15},\\"id\\",\\"parent\\",{\\"_13\\":7,\\"_19\\":16,\\"_26\\":20},{\\"_18\\":17},\\"assistant\\",\\"role\\",\\"author\\",{\\"_22\\":21,\\"_25\\":23},\\"text\\",\\"content_type\\",[24],\\"hello\\",\\"parts\\",\\"content\\",\\"message\\",\\"mapping\\",\\"data\\",\\"serverResponse\\",\\"routes/share.$shareId.($action)\\",\\"loaderData\\",\\"actionData\\",\\"errors\\"]");';

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
  },
) {
  const run = new Function('fetch', 'location', 'document', `return ${expression}`);
  return run(extras.fetch, extras.location, extras.document) as Promise<{ text?: string; error?: string | null }>;
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
    const url = 'https://example.com/research-note';
    const background = tab('00000000-0000-7000-8000-000000000001', 'Chat', url);
    const active = tab('00000000-0000-7000-8000-000000000002', 'Chat', url);
    const commandEmbeddedBrowser = vi.fn(async (): Promise<EmbeddedBrowserResult> => ({ kind: 'value', value: { text: '{}' } }));
    const bridge = { getEmbeddedBrowserState: vi.fn().mockResolvedValue({ activeTabId: active.id, tabs: [background, active] }), commandEmbeddedBrowser };
    await readBrowserConversation(bridge, url);
    expect(commandEmbeddedBrowser).toHaveBeenCalledWith(expect.objectContaining({ action: 'evaluate', tabId: active.id }));
  });

  it('imports a shared ChatGPT conversation from the page when the share API refuses', async () => {
    const url = 'https://example.com/research-note';
    const conversation = sharedChatGptConversation();
    const fetch = vi.fn(async () => jsonResponse(null, true));
    const expression = await generatedReader(url);
    const fromScript = await runGeneratedReader(expression, {
      fetch, location: chatgptLocation(url),
      document: { querySelectorAll: () => [{ textContent: capturedShareEnqueue }] },
    });
    expectImportedConversation(fromScript, conversation);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('falls back to ChatGPT’s share API, then reports the page’s refusal', async () => {
    const url = 'https://example.com/research-note';
    const conversation = sharedChatGptConversation();
    const expression = await generatedReader(url);
    const emptyPage = { location: chatgptLocation(url), document: { querySelectorAll: () => [] } };
    const page = { fetch: vi.fn(async () => jsonResponse(conversation)), ...emptyPage };
    expectImportedConversation(await runGeneratedReader(expression, page), conversation);
    expect(page.fetch).toHaveBeenCalledWith('/backend-anon/share/6ab43c03-6b2c-83e8-9eba-f1c51fa1e7a0', expect.objectContaining({ credentials: 'include' }));
    expect(page.fetch.mock.calls.every(([input]) => !String(input).includes('/api/auth/session'))).toBe(true);

    const refused = { fetch: vi.fn(async () => jsonResponse(null, true)), ...emptyPage };
    await expect(runGeneratedReader(expression, refused)).resolves.toEqual({ error: 'ChatGPT could not return this conversation.' });

    const incomplete = { fetch: vi.fn(async () => jsonResponse({})), ...emptyPage };
    await expect(runGeneratedReader(expression, incomplete)).resolves.toEqual({ error: 'ChatGPT returned an incomplete conversation.' });

    const malformed = { fetch: vi.fn(async () => jsonResponse(null, false, true)), ...emptyPage };
    await expect(runGeneratedReader(expression, malformed)).resolves.toEqual({ error: 'ChatGPT returned an incomplete conversation.' });
  });

  it('tells a refused ChatGPT conversation apart from an incomplete one', async () => {
    const url = 'https://example.com/research-note';
    const expression = await generatedReader(url);
    const location = chatgptLocation(url);
    const document = { querySelectorAll: () => [] };
    const sessionThen = (conversation: unknown, failed = false) => vi.fn(async (input: string) => String(input).includes('/api/auth/session')
      ? jsonResponse({ accessToken: 'tok' })
      : jsonResponse(conversation, failed));
    await expect(runGeneratedReader(expression, { fetch: sessionThen(null, true), location, document }))
      .resolves.toEqual({ error: 'ChatGPT could not return this conversation.' });
    await expect(runGeneratedReader(expression, { fetch: sessionThen({}), location, document }))
      .resolves.toEqual({ error: 'ChatGPT returned an incomplete conversation.' });
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
