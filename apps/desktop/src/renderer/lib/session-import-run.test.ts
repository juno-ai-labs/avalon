import { describe, expect, it, vi } from 'vitest';
import { assemblePreview, startSessionImportRun, type SessionImportApi } from './session-import-run';
import { DesktopActionStore } from './desktop-actions/store';

/** One fake feed socket per run: records what this window sent and when it closed. */
const sockets = vi.hoisted(() => [] as Array<{ log: string[]; emit(type: string, data?: string): void }>);
vi.mock('./realtime-socket', () => ({
  createRealtimeSocket: () => {
    const listeners = new Map<string, Array<(event: { data?: string }) => void>>();
    const socket = {
      log: [] as string[],
      readyState: 1,
      addEventListener(type: string, listener: (event: { data?: string }) => void) {
        listeners.set(type, [...(listeners.get(type) ?? []), listener]);
      },
      send(data: string) { socket.log.push(`send ${(JSON.parse(data) as { type: string }).type}`); },
      close() { socket.log.push('close'); },
      emit(type: string, data?: string) { for (const listener of listeners.get(type) ?? []) listener({ data }); },
    };
    sockets.push(socket);
    return socket;
  },
}));

const source = { provider: 'claude' as const, url: 'https://claude.ai/chat/4f2b7c1e-9a3d-4e8b-b1c2-0d9e8f7a6b5c', sessionId: '4f2b7c1e-9a3d-4e8b-b1c2-0d9e8f7a6b5c' };

function stored(messages: unknown) {
  const store = new DesktopActionStore();
  store.add({ ref: { handle: 'messages', kind: 'json', name: 'messages', mimeType: 'application/json', size: 0 }, data: JSON.stringify(messages) });
  store.add({ ref: { handle: 'chart', kind: 'file', name: 'chart', mimeType: 'image/png', size: 3 }, data: btoa('png') });
  return store;
}

describe('assembling an import from what the agent stored', () => {
  it('turns handles into inline files, named for their type, kinded by who added them', () => {
    const preview = assemblePreview(stored([
      { role: 'user', text: 'Plot it', sourceMessageId: 'u1', files: [{ unavailable: { name: 'data.xlsx', reason: 'Expired' } }] },
      { role: 'assistant', text: 'Here.', sourceMessageId: 'a1', files: [{ handle: 'chart' }] },
    ]), { title: 'Charts', messagesHandle: 'messages', source });
    expect(preview).toEqual({ title: 'Charts', source, content: { messages: [
      { role: 'user', text: 'Plot it', sourceMessageId: 'u1', files: [{ name: 'data.xlsx', mimeType: 'application/octet-stream', kind: 'attachment',
        source: { kind: 'unavailable', reference: 'data.xlsx', reason: 'Expired' } }] },
      { role: 'assistant', text: 'Here.', sourceMessageId: 'a1', files: [{ name: 'chart.png', mimeType: 'image/png', kind: 'artifact',
        source: { kind: 'inline', encoding: 'base64', data: btoa('png') } }] },
    ] } });
  });

  it('names what is wrong, so the agent can fix it', () => {
    const at = (messages: unknown, handle = 'messages') => () => assemblePreview(stored(messages), { title: 't', messagesHandle: handle, source });
    expect(at([], 'missing')).toThrow('No stored value has the handle missing.');
    expect(at([], 'chart')).toThrow('chart is a file');
    expect(at([{ role: 'user', text: 'x' }])).toThrow('sourceMessageId');
    expect(at([{ role: 'user', text: 'a', sourceMessageId: 'm' }, { role: 'assistant', text: 'b', sourceMessageId: 'm' }]))
      .toThrow('sourceMessageId m appears more than once.');
    expect(at([{ role: 'user', text: 'a', sourceMessageId: 'm', files: [{ handle: 'gone' }] }])).toThrow('file handle gone');
    expect(at([{ role: 'user', text: ' ', sourceMessageId: 'm' }])).toThrow('Message 1 has no text and no files.');
  });
});

describe('running an import', () => {
  function started() {
    const discards: string[] = [];
    const unused = async (): Promise<never> => { throw new Error('not used by this run'); };
    const api = {
      startSessionImport: async () => ({ workstreamId: 'w1', substreamId: 's1' }),
      getSocketTicket: async () => ({ url: 'wss://rally.test/feed', ticket: 't', protocols: ['rally', 't'] as [string, string] }),
      discardSessionImport: async (workstreamId: string) => { discards.push(workstreamId); },
      startSessionImportUpdate: unused,
      completeSessionImport: unused,
      updateImportedSession: unused,
      importedSessionSource: unused,
    } satisfies SessionImportApi;
    const bridge = { getEmbeddedBrowserState: async () => ({ tabs: [] }), commandEmbeddedBrowser: async () => undefined } as never;
    const run = startSessionImportRun({
      api, bridge, tabId: 't1', sourceUrl: source.url,
      mode: { kind: 'create', title: 'Garden plan', spaceIds: [], clientMessageId: 'c1' },
    });
    return { run, discards };
  }

  it('answers the agent’s fail before closing its socket, and discards the Channel that will not open', async () => {
    sockets.length = 0;
    const { run, discards } = started();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    const socket = sockets[0]!;
    socket.emit('open');
    socket.emit('message', JSON.stringify({ type: 'desktop_action_requested', request: { id: 'a1', action: { kind: 'session_import.fail', reason: 'page_unavailable' } } }));
    await expect(run.done).resolves.toEqual({ kind: 'failed', reason: 'page_unavailable' });
    expect(socket.log).toEqual(['send subscribe', 'send answer_desktop_action', 'close']);
    await vi.waitFor(() => expect(discards).toEqual(['w1']));
  });

  it('ends a cancelled import as cancelled, after discarding its Channel', async () => {
    sockets.length = 0;
    const { run, discards } = started();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    await run.cancel();
    await expect(run.done).resolves.toEqual({ kind: 'cancelled' });
    expect(discards).toEqual(['w1']);
  });
});
