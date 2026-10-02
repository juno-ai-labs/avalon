import { describe, expect, it, vi } from 'vitest';
import { assemblePreview, startSessionImportRun, type SessionImportApi, type SessionImportStep } from './session-import-run';
import { DesktopActionStore } from './desktop-actions/store';

/** One fake feed socket per run: records what this window sent and when it closed. */
const sockets = vi.hoisted(() => [] as Array<{ log: string[]; dropNextSend: boolean; emit(type: string, data?: string): void }>);
vi.mock('./realtime-socket', () => ({
  createRealtimeSocket: () => {
    const listeners = new Map<string, Array<(event: { data?: string }) => void>>();
    const socket = {
      log: [] as string[],
      readyState: 1,
      /** The next send meets a socket between connections, as a real one throws. */
      dropNextSend: false,
      addEventListener(type: string, listener: (event: { data?: string }) => void) {
        listeners.set(type, [...(listeners.get(type) ?? []), listener]);
      },
      send(data: string) {
        if (socket.dropNextSend) { socket.dropNextSend = false; throw new Error('Realtime socket is not open'); }
        socket.log.push(`send ${(JSON.parse(data) as { type: string }).type}`);
      },
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
    const reply = { role: 'assistant', text: 'b', sourceMessageId: 'r' };
    expect(at([{ role: 'user', text: 'a', sourceMessageId: 'm', files: [{ handle: 'gone' }] }, reply])).toThrow('file handle gone');
    expect(at([{ role: 'user', text: ' ', sourceMessageId: 'm' }, reply])).toThrow('Message 1 has no text and no files.');
    // A chat with no reply is never what a provider shows.
    expect(at([{ role: 'user', text: 'a', sourceMessageId: 'm' }, { role: 'user', text: 'b', sourceMessageId: 'n' }]))
      .toThrow('The stored messages have no assistant reply.');
  });
});

describe('running an import', () => {
  function started(onSteps?: (steps: readonly SessionImportStep[]) => void) {
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
      ...(onSteps ? { onSteps } : {}),
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
    await vi.waitFor(() => expect(socket.log).toEqual(['send subscribe', 'send answer_desktop_action']));
    // The room has the answer once the tool completes; only then does the run end.
    socket.emit('message', JSON.stringify({ type: 'tool_completed', invocation: { toolCallId: 'c9', toolName: 'import_fail', status: 'completed' } }));
    await expect(run.done).resolves.toEqual({ kind: 'failed', reason: 'page_unavailable' });
    expect(socket.log).toEqual(['send subscribe', 'send answer_desktop_action', 'close']);
    await vi.waitFor(() => expect(discards).toEqual(['w1']));
  });

  it('answers a re-offered action again when its first answer never reached the room', async () => {
    sockets.length = 0;
    const { run } = started();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    const socket = sockets[0]!;
    socket.emit('open');
    const request = JSON.stringify({ type: 'desktop_action_requested', request: { id: 'a1', action: { kind: 'session_import.fail', reason: 'page_unavailable' } } });
    socket.dropNextSend = true;
    socket.emit('message', request);
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    expect(socket.log).toEqual(['send subscribe']);
    // The room never got it, so it offers the action again; the same answer goes.
    socket.emit('message', request);
    await vi.waitFor(() => expect(socket.log).toEqual(['send subscribe', 'send answer_desktop_action']));
    socket.emit('message', JSON.stringify({ type: 'tool_completed', invocation: { toolCallId: 'c9', toolName: 'import_fail', status: 'completed' } }));
    await expect(run.done).resolves.toEqual({ kind: 'failed', reason: 'page_unavailable' });
  });

  it('lists each step in the harness’s words, then in what the tool did, once each', async () => {
    sockets.length = 0;
    const reported: Array<readonly SessionImportStep[]> = [];
    const { run } = started((steps) => reported.push(steps));
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    const socket = sockets[0]!;
    socket.emit('open');
    const frame = (type: string, invocation: Record<string, unknown>) => socket.emit('message', JSON.stringify({ type, invocation }));
    frame('tool_started', { toolCallId: 'c1', activityName: 'Reading the page outline', status: 'started' });
    frame('tool_completed', { toolCallId: 'c1', activityName: 'Reading the page outline', outputSummary: 'Read the page outline', status: 'completed' });
    frame('tool_started', { toolCallId: 'c2', activityName: null, status: 'started' });
    frame('tool_completed', { toolCallId: 'c2', outputSummary: null, status: 'failed' });
    // A resubscribed socket replays a step already listed.
    frame('tool_started', { toolCallId: 'c1', activityName: 'Reading the page outline', status: 'started' });
    expect(reported.at(-1)).toEqual([
      { id: 'c1', label: 'Read the page outline', status: 'done' },
      { id: 'c2', label: 'Working', status: 'failed' },
    ]);
    expect(reported[0]).toEqual([{ id: 'c1', label: 'Reading the page outline', status: 'running' }]);
    await run.cancel();
  });

  it('ends a run that stops without importing as unfinished, even with no steps, but not on the idle status it opens on', async () => {
    sockets.length = 0;
    const { run, discards } = started();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    const socket = sockets[0]!;
    socket.emit('open');
    const status = (value: string) => socket.emit('message', JSON.stringify({ type: 'harness_status_changed', status: value }));
    status('idle');
    const pending = Symbol('pending');
    await expect(Promise.race([run.done, new Promise((resolve) => { setTimeout(() => resolve(pending), 50); })])).resolves.toBe(pending);
    status('running');
    status('completed');
    await expect(run.done).resolves.toEqual({ kind: 'unfinished' });
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
