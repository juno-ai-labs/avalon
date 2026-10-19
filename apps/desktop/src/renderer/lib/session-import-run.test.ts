import { describe, expect, it, vi } from 'vitest';
import { assemblePreview, startSessionImportRun, type SessionImportApi, type SessionImportMode, type SessionImportStep } from './session-import-run';
import { DesktopActionStore } from '../../common/desktop-actions/store';
import type { RallyDesktopBridge } from '../../common/desktop';

const actionPhases = vi.hoisted(() => [] as Array<{ actionId: string; phase: string; elapsedMs: number }>);
// The main-owned telemetry transport cannot run in jsdom; execution is real.
vi.mock('./telemetry', () => ({ reportTelemetryProductIntent: (intent: { actionId: string; phase: string; elapsedMs: number }) => actionPhases.push(intent) }));

/** One fake feed socket per run: records what this window sent and when it closed. */
const sockets = vi.hoisted(() => [] as Array<{ log: string[]; sent: unknown[]; dropNextSend: boolean; emit(type: string, data?: string): void }>);
vi.mock('./realtime-socket', () => ({
  createRealtimeSocket: () => {
    const listeners = new Map<string, Array<(event: { data?: string }) => void>>();
    const socket = {
      log: [] as string[],
      /** Every frame this window sent, parsed. */
      sent: [] as unknown[],
      readyState: 1,
      /** The next send meets a socket between connections, as a real one throws. */
      dropNextSend: false,
      addEventListener(type: string, listener: (event: { data?: string }) => void) {
        listeners.set(type, [...(listeners.get(type) ?? []), listener]);
      },
      send(data: string) {
        if (socket.dropNextSend) { socket.dropNextSend = false; throw new Error('Realtime socket is not open'); }
        socket.log.push(`send ${(JSON.parse(data) as { type: string }).type}`);
        socket.sent.push(JSON.parse(data));
      },
      close() { socket.log.push('close'); },
      emit(type: string, data?: string) { for (const listener of listeners.get(type) ?? []) listener({ data }); },
    };
    sockets.push(socket);
    return socket;
  },
}));

/** A feed frame as the room sends it: sequenced, timestamped, and whole. */
function wire(type: string, fields: Record<string, unknown>): string {
  return JSON.stringify({ type, sequence: 1, occurredAt: '2026-10-01T00:00:00.000Z', ...fields });
}

/** A tool row as the harness reports it; only what a test names differs. */
function invocation(fields: Record<string, unknown>) {
  return {
    id: '01900000-0000-7000-8000-000000000001', harnessRunId: '01900000-0000-7000-8000-000000000002',
    toolCallId: 'c0', toolName: 'browser_evaluate', activityName: null, connectionId: null, plugin: null,
    status: 'completed', inputSummary: '', outputSummary: null, startedAt: null, completedAt: null, error: null,
    ...fields,
  };
}

const verification = {
  checks: [{ name: "page content", passed: true, basis: "Compared every displayed turn." }],
  branch: { complete: true as const, basis: 'Selected leaf reaches the root.' },
  page: { messageCount: 2, firstSourceMessageId: 'm0', lastSourceMessageId: 'm1', sampledSourceMessageIds: ['m1'], basis: 'Both rendered turns compared.' },
  fileCount: 0,
};

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
  function started(
    onSteps?: (steps: readonly SessionImportStep[]) => void,
    options: {
      reservation?: Promise<{ workstreamId: string; substreamId: string }>;
      onStarted?: (run: { workstreamId: string; substreamId: string }) => void;
      bridge?: Pick<RallyDesktopBridge, 'getEmbeddedBrowserState' | 'commandEmbeddedBrowser'>;
      completeSessionImport?: SessionImportApi['completeSessionImport'];
      breakout?: Pick<SessionImportApi, 'startBreakoutImport' | 'completeBreakoutImport'>;
      mode?: SessionImportMode;
    } = {},
  ) {
    const discards: string[] = [];
    const discardBodies: unknown[] = [];
    const abandons: unknown[] = [];
    const unused = async (): Promise<never> => { throw new Error('not used by this run'); };
    const api = {
      startSessionImport: () => options.reservation ?? Promise.resolve({ workstreamId: 'w1', substreamId: 's1' }),
      confirmSocketTicket: vi.fn(),
      getSocketTicket: async () => ({ url: 'wss://rally.test/feed', ticket: 't', protocols: ['rally', 't'] as [string, string] }),
      discardSessionImport: async (workstreamId: string, body: unknown) => { discards.push(workstreamId); discardBodies.push(body); },
      abandonSessionImport: async (body: unknown) => { abandons.push(body); },
      startSessionImportUpdate: unused,
      startBreakoutImport: options.breakout?.startBreakoutImport ?? unused,
      completeBreakoutImport: options.breakout?.completeBreakoutImport ?? unused,
      completeSessionImport: options.completeSessionImport ?? unused,
      updateImportedSession: unused,
      importedSessionSource: unused,
    } satisfies SessionImportApi;
    const bridge = options.bridge ?? { getEmbeddedBrowserState: async () => ({ tabs: [] }), commandEmbeddedBrowser: async () => undefined } as never;
    const run = startSessionImportRun({
      api, bridge, tabId: 't1', sourceUrl: source.url,
      mode: options.mode ?? { kind: 'create', title: 'Garden plan', spaceIds: [], clientMessageId: 'c1' },
      ...(onSteps ? { onSteps } : {}),
      ...(options.onStarted ? { onStarted: options.onStarted } : {}),
    });
    return { run, discards, discardBodies, abandons, api };
  }

  it('imports into a new Breakout of the thread and ends naming it', async () => {
    sockets.length = 0;
    const startBreakoutImport = vi.fn(async () => ({ workstreamId: 'thread', substreamId: 'agent' }));
    const completeBreakoutImport = vi.fn(async () => 'breakout-1');
    const data = JSON.stringify([{ role: 'user', text: 'Question', sourceMessageId: 'm0' },
      { role: 'assistant', text: 'Answer', sourceMessageId: 'm1' }]);
    const bridge = {
      getEmbeddedBrowserState: async () => ({ tabs: [{ id: 't1', url: source.url, title: 'Chat' }] }),
      commandEmbeddedBrowser: async () => ({ kind: 'value' as const, value: { ok: true, value: 1,
        url: source.url, title: 'Chat', stored: [{ handle: 'messages', kind: 'json', name: 'messages',
          mimeType: 'application/json', size: data.length, data }] } }),
    } as never;
    const { run } = started(undefined, { bridge, breakout: { startBreakoutImport, completeBreakoutImport },
      mode: { kind: 'breakout', workstreamId: 'thread', title: 'Watering notes', clientMessageId: 'c2' } });
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    expect(startBreakoutImport).toHaveBeenCalledWith('thread', { sourceUrl: source.url, title: 'Watering notes', clientMessageId: 'c2' });
    const socket = sockets[0]!;
    socket.emit('open');
    socket.emit('message', wire('harness_status_changed', { status: 'running' }));
    socket.emit('message', wire('desktop_action_requested', { request: { id: 'read', action: { kind: 'browser.evaluate', script: 'return 1' } } }));
    socket.emit('message', wire('desktop_action_requested', { request: { id: 'finish', action: { kind: 'session_import.finish',
      title: 'Chat', messages: 'messages', verification } } }));
    await vi.waitFor(() => expect(completeBreakoutImport).toHaveBeenCalledOnce());
    expect(completeBreakoutImport).toHaveBeenCalledWith('thread', expect.objectContaining({ title: 'Watering notes' }), { clientMessageId: 'c2' });
    socket.emit('message', wire('harness_status_changed', { status: 'completed' }));
    await expect(run.done).resolves.toEqual({ kind: 'imported', workstreamId: 'thread', substreamId: 'breakout-1' });
  });

  it('cancels a Breakout import’s reservation, not a thread’s', async () => {
    sockets.length = 0;
    const { run, discardBodies } = started(undefined, {
      breakout: { startBreakoutImport: async () => ({ workstreamId: 'thread', substreamId: 'agent' }), completeBreakoutImport: async () => 'b' },
      mode: { kind: 'breakout', workstreamId: 'thread', title: 'Watering notes', clientMessageId: 'c3' },
    });
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    await run.cancel();
    expect(discardBodies).toEqual([{ substreamId: 'agent', clientMessageId: 'c3', breakout: true }]);
  });

  it('confirms recovery only after a valid import feed frame', async () => {
    sockets.length = 0;
    const { run, api } = started();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    const socket = sockets[0]!;
    socket.emit('open');
    socket.emit('message', 'not JSON');
    socket.emit('message', JSON.stringify({ type: 'harness_status_changed', status: 'invalid' }));
    expect(api.confirmSocketTicket).not.toHaveBeenCalled();
    socket.emit('message', wire('harness_status_changed', { status: 'running' }));
    expect(api.confirmSocketTicket).toHaveBeenCalledWith({ url: 'wss://rally.test/feed', ticket: 't', protocols: ['rally', 't'] });
    await run.cancel();
  });

  it('refuses failed page checks before saving and accepts a repaired comparison', async () => {
    sockets.length = 0;
    const complete = vi.fn(async () => 'w1');
    const data = JSON.stringify([{ role: 'user', text: 'Question', sourceMessageId: 'm0' },
      { role: 'assistant', text: 'Answer', sourceMessageId: 'm1' }]);
    const bridge = {
      getEmbeddedBrowserState: async () => ({ tabs: [{ id: 't1', url: source.url, title: 'Chat' }] }),
      commandEmbeddedBrowser: async () => ({ kind: 'value' as const, value: { ok: true, value: 1,
        url: source.url, title: 'Chat', stored: [{ handle: 'messages', kind: 'json', name: 'messages',
          mimeType: 'application/json', size: data.length, data }] } }),
    } as never;
    const { run } = started(undefined, { bridge, completeSessionImport: complete });
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    const socket = sockets[0]!;
    socket.emit('open');
    socket.emit('message', wire('harness_status_changed', { status: 'running' }));
    socket.emit('message', wire('desktop_action_requested', { request: { id: 'read', action: { kind: 'browser.evaluate', script: 'return 1' } } }));
    socket.emit('message', wire('desktop_action_requested', { request: { id: 'failed-check', action: { kind: 'session_import.finish',
      title: 'Chat', messages: 'messages', verification: { ...verification,
        checks: [{ name: 'user text', passed: false, basis: 'The full text comparison returned false.' }] } } } }));
    await vi.waitFor(() => expect(socket.sent).toHaveLength(3));
    expect(socket.sent[2]).toMatchObject({ type: 'answer_desktop_action',
      outcome: { ok: false, code: 'invalid_conversation', message: expect.stringContaining('verification.checks[0].passed') } });
    expect(complete).not.toHaveBeenCalled();
    socket.emit('message', wire('desktop_action_requested', { request: { id: 'repaired', action: { kind: 'session_import.finish',
      title: 'Chat', messages: 'messages', verification } } }));
    await vi.waitFor(() => expect(complete).toHaveBeenCalledOnce());
    socket.emit('message', wire('harness_status_changed', { status: 'completed' }));
    await expect(run.done).resolves.toEqual({ kind: 'imported', workstreamId: 'w1' });
  });

  it('ends a failed run while its browser command is blocked, skips queued work, and traces the boundary', async () => {
    sockets.length = 0;
    actionPhases.length = 0;
    const entered = Promise.withResolvers<void>();
    const command = Promise.withResolvers<Awaited<ReturnType<RallyDesktopBridge['commandEmbeddedBrowser']>>>();
    const bridge = {
      getEmbeddedBrowserState: async () => ({ activeTabId: 't1', tabs: [{
        id: 't1', url: source.url, title: 'Chat', loading: false, canGoBack: false, canGoForward: false, favicon: null,
      }] }),
      commandEmbeddedBrowser: async () => { entered.resolve(); return await command.promise; },
    } satisfies Pick<RallyDesktopBridge, 'getEmbeddedBrowserState' | 'commandEmbeddedBrowser'>;
    const { run, discards } = started(undefined, { bridge });
    await vi.waitFor(() => expect(sockets).toHaveLength(1), { timeout: 5_000 });
    const socket = sockets[0]!;
    socket.emit('open');
    socket.emit('message', wire('harness_status_changed', { status: 'running' }));
    socket.emit('message', wire('desktop_action_requested', { request: { id: 'a0', action: { kind: 'browser.evaluate', script: 'return 1' } } }));
    await entered.promise;
    socket.emit('message', wire('desktop_action_requested', { request: { id: 'a1', action: { kind: 'session_import.fail', reason: 'unreadable' } } }));
    const ended = vi.fn();
    void run.done.then(ended);
    socket.emit('message', wire('harness_status_changed', { status: 'failed' }));
    await vi.waitFor(() => expect(ended).toHaveBeenCalledWith({ kind: 'unfinished' }), { timeout: 5_000 });
    expect(socket.log).toEqual(['send subscribe', 'close']);
    expect(discards).toEqual(['w1']);
    expect(actionPhases.filter(p => p.actionId === 'a0').map(p => p.phase)).toEqual([
      'received', 'execution_started', 'browser_state_requested', 'browser_state_received', 'browser_command_requested', 'run_ended',
    ]);
    command.resolve({ kind: 'value', value: { ok: true, value: 1, stored: [], url: source.url, title: 'Chat' } });
    await vi.waitFor(() => expect(actionPhases.some(p => p.actionId === 'a0' && p.phase === 'execution_completed')).toBe(true), { timeout: 5_000 });
    expect(socket.log).toEqual(['send subscribe', 'close']);
    expect(actionPhases.filter(p => p.actionId === 'a1').map(p => p.phase)).toEqual(['received', 'run_ended']);
  });

  it('waits only for an import commit already in flight when the server run ends', async () => {
    sockets.length = 0;
    const entered = Promise.withResolvers<void>();
    const commit = Promise.withResolvers<string>();
    const data = JSON.stringify([{ role: 'assistant', text: 'Ready.', sourceMessageId: 'm1' }]);
    const bridge = {
      getEmbeddedBrowserState: async () => ({ activeTabId: 't1', tabs: [{
        id: 't1', url: source.url, title: 'Chat', loading: false, canGoBack: false, canGoForward: false, favicon: null,
      }] }),
      commandEmbeddedBrowser: async () => ({ kind: 'value' as const, value: { ok: true, value: null, url: source.url, title: 'Chat', stored: [
        { handle: 'messages', kind: 'json', name: 'messages', mimeType: 'application/json', size: data.length, data },
      ] } }),
    } satisfies Pick<RallyDesktopBridge, 'getEmbeddedBrowserState' | 'commandEmbeddedBrowser'>;
    const { run, discards } = started(undefined, { bridge, completeSessionImport: async () => { entered.resolve(); return await commit.promise; } });
    await vi.waitFor(() => expect(sockets).toHaveLength(1), { timeout: 5_000 });
    const socket = sockets[0]!;
    socket.emit('open');
    socket.emit('message', wire('harness_status_changed', { status: 'running' }));
    socket.emit('message', wire('desktop_action_requested', { request: { id: 'a0', action: { kind: 'browser.evaluate', script: 'return 1' } } }));
    socket.emit('message', wire('desktop_action_requested', { request: { id: 'a1', action: { kind: 'session_import.finish', title: 'Chat', messages: 'messages', verification: { ...verification, page: { ...verification.page, messageCount: 1, firstSourceMessageId: 'm1' } } } } }));
    await entered.promise;
    const ended = vi.fn();
    void run.done.then(ended);
    socket.emit('message', wire('harness_status_changed', { status: 'failed' }));
    await Promise.resolve();
    expect(ended).not.toHaveBeenCalled();
    expect(discards).toEqual([]);
    commit.resolve('w1');
    await expect(run.done).resolves.toEqual({ kind: 'imported', workstreamId: 'w1' });
    expect(discards).toEqual([]);
    expect(socket.log).toEqual(['send subscribe', 'send answer_desktop_action', 'send answer_desktop_action', 'close']);
  });

  it('answers the agent’s fail before closing its socket, and discards the Channel that will not open', async () => {
    sockets.length = 0;
    const { run, discards } = started();
    await vi.waitFor(() => expect(sockets).toHaveLength(1), { timeout: 5_000 });
    const socket = sockets[0]!;
    socket.emit('open');
    socket.emit('message', wire('desktop_action_requested', { request: { id: 'a1', action: { kind: 'session_import.fail', reason: 'page_unavailable' } } }));
    await vi.waitFor(() => expect(socket.log).toEqual(['send subscribe', 'send answer_desktop_action']), { timeout: 5_000 });
    // The room has the answer once the tool completes; only then does the run end.
    socket.emit('message', wire('tool_completed', { invocation: invocation({ toolCallId: 'c9', toolName: 'import_fail', status: 'completed' }) }));
    await expect(run.done).resolves.toEqual({ kind: 'failed', reason: 'page_unavailable' });
    expect(socket.log).toEqual(['send subscribe', 'send answer_desktop_action', 'close']);
    await vi.waitFor(() => expect(discards).toEqual(['w1']), { timeout: 5_000 });
  });

  it('answers a re-offered action again when its first answer never reached the room', async () => {
    sockets.length = 0;
    const { run } = started();
    await vi.waitFor(() => expect(sockets).toHaveLength(1), { timeout: 5_000 });
    const socket = sockets[0]!;
    socket.emit('open');
    const request = wire('desktop_action_requested', { request: { id: 'a1', action: { kind: 'session_import.fail', reason: 'page_unavailable' } } });
    socket.dropNextSend = true;
    socket.emit('message', request);
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    expect(socket.log).toEqual(['send subscribe']);
    // The room never got it, so it offers the action again; the same answer goes.
    socket.emit('message', request);
    await vi.waitFor(() => expect(socket.log).toEqual(['send subscribe', 'send answer_desktop_action']), { timeout: 5_000 });
    socket.emit('message', wire('tool_completed', { invocation: invocation({ toolCallId: 'c9', toolName: 'import_fail', status: 'completed' }) }));
    await expect(run.done).resolves.toEqual({ kind: 'failed', reason: 'page_unavailable' });
  });

  it('lists each step in the harness’s words, then in what the tool did, once each', async () => {
    sockets.length = 0;
    const reported: Array<readonly SessionImportStep[]> = [];
    const { run } = started((steps) => reported.push(steps));
    await vi.waitFor(() => expect(sockets).toHaveLength(1), { timeout: 5_000 });
    const socket = sockets[0]!;
    socket.emit('open');
    const frame = (type: string, fields: Record<string, unknown>) => socket.emit('message', wire(type, { invocation: invocation(fields) }));
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
    await vi.waitFor(() => expect(sockets).toHaveLength(1), { timeout: 5_000 });
    const socket = sockets[0]!;
    socket.emit('open');
    const status = (value: string) => socket.emit('message', wire('harness_status_changed', { status: value }));
    status('idle');
    const pending = Symbol('pending');
    await expect(Promise.race([run.done, new Promise((resolve) => { setTimeout(() => resolve(pending), 50); })])).resolves.toBe(pending);
    status('running');
    status('completed');
    await expect(run.done).resolves.toEqual({ kind: 'unfinished' });
    await vi.waitFor(() => expect(discards).toEqual(['w1']), { timeout: 5_000 });
  });

  it('ends a cancelled import as cancelled, after discarding its Channel', async () => {
    sockets.length = 0;
    const { run, discards } = started();
    await vi.waitFor(() => expect(sockets).toHaveLength(1), { timeout: 5_000 });
    await run.cancel();
    await expect(run.done).resolves.toEqual({ kind: 'cancelled' });
    expect(discards).toEqual(['w1']);
  });

  it('never reports a Channel whose import was cancelled before its reservation came back, and discards it', async () => {
    sockets.length = 0;
    let reserve!: (value: { workstreamId: string; substreamId: string }) => void;
    const reported: string[] = [];
    const { run, discards } = started(undefined, {
      reservation: new Promise((resolve) => { reserve = resolve; }),
      onStarted: ({ workstreamId }) => reported.push(workstreamId),
    });
    await run.cancel();
    await expect(run.done).resolves.toEqual({ kind: 'cancelled' });
    reserve({ workstreamId: 'w1', substreamId: 's1' });
    await vi.waitFor(() => expect(discards).toEqual(['w1']), { timeout: 5_000 });
    expect(reported).toEqual([]);
    expect(sockets).toHaveLength(0);
  });

  it('takes back by its create key a new import whose start failed, since no ids came back to discard', async () => {
    sockets.length = 0;
    const { run, discards, abandons } = started(undefined, { reservation: Promise.reject(new Error('Network connection lost')) });
    await expect(run.done).resolves.toEqual({ kind: 'error', message: 'Network connection lost' });
    await vi.waitFor(() => expect(abandons).toEqual([{ clientMessageId: 'c1' }]));
    expect(discards).toEqual([]);
    expect(sockets).toHaveLength(0);
  });

  it('abandons nothing when a Breakout import’s start fails, which lists nothing to take back', async () => {
    sockets.length = 0;
    const { run, abandons } = started(undefined, {
      breakout: { startBreakoutImport: async () => { throw new Error('Forbidden'); }, completeBreakoutImport: async () => 'b' },
      mode: { kind: 'breakout', workstreamId: 'thread', title: 'Watering notes', clientMessageId: 'c4' },
    });
    await expect(run.done).resolves.toEqual({ kind: 'error', message: 'Forbidden' });
    expect(abandons).toEqual([]);
  });

  it('reports the reserved Channel and the agent’s conversation once the API answers', async () => {
    sockets.length = 0;
    const reported: unknown[] = [];
    const { run } = started(undefined, { onStarted: (reservation) => reported.push(reservation) });
    await vi.waitFor(() => expect(reported).toEqual([{ workstreamId: 'w1', substreamId: 's1' }]));
    await run.cancel();
  });

  it('keeps an import that opened its Channel as imported when the agent gives up afterwards', async () => {
    sockets.length = 0;
    const discards: string[] = [];
    const unused = async (): Promise<never> => { throw new Error('not used by this run'); };
    const api = {
      startSessionImport: async () => ({ workstreamId: 'w1', substreamId: 's1' }),
      confirmSocketTicket: vi.fn(),
      getSocketTicket: async () => ({ url: 'wss://rally.test/feed', ticket: 't', protocols: ['rally', 't'] as [string, string] }),
      discardSessionImport: async (workstreamId: string) => { discards.push(workstreamId); },
      abandonSessionImport: async () => undefined,
      completeSessionImport: async () => 'w1',
      startSessionImportUpdate: unused,
      startBreakoutImport: unused,
      completeBreakoutImport: unused,
      updateImportedSession: unused,
      importedSessionSource: unused,
    } satisfies SessionImportApi;
    const messages = [{ role: 'user', text: 'Plan the beds' }, { role: 'assistant', text: 'Two rows of tomatoes.' }]
      .map((message, at) => ({ ...message, sourceMessageId: `m${at}` }));
    // The page's script stores the messages it read, as `rally.store` reports them.
    const data = JSON.stringify(messages);
    const bridge = {
      getEmbeddedBrowserState: async () => ({ tabs: [{ id: 't1', url: source.url, title: 'Garden plan' }] }),
      commandEmbeddedBrowser: async () => ({ kind: 'value', value: { ok: true, value: 1, url: source.url, title: 'Garden plan', stored: [
        { handle: 'messages', kind: 'json', name: 'messages', mimeType: 'application/json', size: data.length, data },
      ] } }),
    } as never;
    const run = startSessionImportRun({
      api, bridge, tabId: 't1', sourceUrl: source.url,
      mode: { kind: 'create', title: 'Garden plan', spaceIds: [], clientMessageId: 'c1' },
    });
    await vi.waitFor(() => expect(sockets).toHaveLength(1), { timeout: 5_000 });
    const socket = sockets[0]!;
    socket.emit('open');
    socket.emit('message', wire('desktop_action_requested', { request: { id: 'a0', action: { kind: 'browser.evaluate', script: 'return 1' } } }));
    await vi.waitFor(() => expect(socket.log).toContain('send answer_desktop_action'), { timeout: 5_000 });
    socket.emit('message', wire('desktop_action_requested', { request: { id: 'a1', action: { kind: 'session_import.finish', title: 'Garden plan', messages: 'messages', verification } } }));
    socket.emit('message', wire('desktop_action_requested', { request: { id: 'a2', action: { kind: 'session_import.fail', reason: 'page_unavailable' } } }));
    await vi.waitFor(() => expect(socket.log.filter((entry) => entry === 'send answer_desktop_action')).toHaveLength(3), { timeout: 5_000 });
    socket.emit('message', wire('tool_completed', { invocation: invocation({ toolCallId: 'c9', toolName: 'import_fail', status: 'completed' }) }));
    await expect(run.done).resolves.toEqual({ kind: 'imported', workstreamId: 'w1' });
    expect(discards).toEqual([]);
  });

  it('answers a retried finish as the first, and ends imported when the run ends without the finish’s tool row', async () => {
    sockets.length = 0;
    const completions: string[] = [];
    const unused = async (): Promise<never> => { throw new Error('not used by this run'); };
    const api = {
      startSessionImport: async () => ({ workstreamId: 'w1', substreamId: 's1' }),
      confirmSocketTicket: vi.fn(),
      getSocketTicket: async () => ({ url: 'wss://rally.test/feed', ticket: 't', protocols: ['rally', 't'] as [string, string] }),
      discardSessionImport: async () => undefined,
      abandonSessionImport: async () => undefined,
      completeSessionImport: async (workstreamId: string) => { completions.push(workstreamId); return workstreamId; },
      startSessionImportUpdate: unused,
      startBreakoutImport: unused,
      completeBreakoutImport: unused,
      updateImportedSession: unused,
      importedSessionSource: unused,
    } satisfies SessionImportApi;
    const data = JSON.stringify([{ role: 'user', text: 'Plan the beds', sourceMessageId: 'm0' }, { role: 'assistant', text: 'Two rows.', sourceMessageId: 'm1' }]);
    const bridge = {
      getEmbeddedBrowserState: async () => ({ tabs: [{ id: 't1', url: source.url, title: 'Garden plan' }] }),
      commandEmbeddedBrowser: async () => ({ kind: 'value', value: { ok: true, value: 1, url: source.url, title: 'Garden plan', stored: [
        { handle: 'messages', kind: 'json', name: 'messages', mimeType: 'application/json', size: data.length, data },
      ] } }),
    } as never;
    const run = startSessionImportRun({
      api, bridge, tabId: 't1', sourceUrl: source.url,
      mode: { kind: 'create', title: 'Garden plan', spaceIds: [], clientMessageId: 'c1' },
    });
    await vi.waitFor(() => expect(sockets).toHaveLength(1), { timeout: 5_000 });
    const socket = sockets[0]!;
    socket.emit('open');
    socket.emit('message', wire('harness_status_changed', { status: 'running' }));
    socket.emit('message', wire('desktop_action_requested', { request: { id: 'a0', action: { kind: 'browser.evaluate', script: 'return 1' } } }));
    const finish = (id: string) => wire('desktop_action_requested', { request: { id, action: { kind: 'session_import.finish', title: 'Garden plan', messages: 'messages', verification } } });
    socket.emit('message', wire('desktop_action_requested', { request: { id: 'bad', action: {
      kind: 'session_import.finish', title: 'Garden plan', messages: 'messages',
      verification: { ...verification, page: { ...verification.page, messageCount: 3 } },
    } } }));
    await vi.waitFor(() => expect(socket.sent).toContainEqual({ type: 'answer_desktop_action', actionId: 'bad', outcome: {
      ok: false, code: 'invalid_conversation', message: 'verification.page.messageCount does not match the stored messages. Resolve missing messages or explain and account for grouped turns before finishing.',
    } }), { timeout: 5_000 });
    expect(completions).toEqual([]);
    socket.emit('message', finish('a1'));
    // The tool timed out on the server before the first answer landed, and the agent tried again.
    socket.emit('message', finish('a2'));
    const finishAnswers = () => socket.sent.filter((frame) => ['a1', 'a2'].includes((frame as { actionId?: string }).actionId ?? ''));
    await vi.waitFor(() => expect(finishAnswers()).toHaveLength(2), { timeout: 5_000 });
    expect(finishAnswers()).toEqual([
      { type: 'answer_desktop_action', actionId: 'a1', outcome: { ok: true, result: { workstreamId: 'w1', messages: 2 } } },
      { type: 'answer_desktop_action', actionId: 'a2', outcome: { ok: true, result: { workstreamId: 'w1', messages: 2 } } },
    ]);
    expect(completions).toEqual(['w1']);
    socket.emit('message', wire('harness_status_changed', { status: 'completed' }));
    await expect(run.done).resolves.toEqual({ kind: 'imported', workstreamId: 'w1' });
  });

  it('ends a run whose finish Rally refused with Rally’s last reason', async () => {
    sockets.length = 0;
    const unused = async (): Promise<never> => { throw new Error('not used by this run'); };
    const api = {
      startSessionImport: async () => ({ workstreamId: 'w1', substreamId: 's1' }),
      confirmSocketTicket: vi.fn(),
      getSocketTicket: async () => ({ url: 'wss://rally.test/feed', ticket: 't', protocols: ['rally', 't'] as [string, string] }),
      discardSessionImport: async () => undefined,
      abandonSessionImport: async () => undefined,
      completeSessionImport: async () => { throw new Error('This import key belongs to another thread'); },
      startSessionImportUpdate: unused,
      startBreakoutImport: unused,
      completeBreakoutImport: unused,
      updateImportedSession: unused,
      importedSessionSource: unused,
    } satisfies SessionImportApi;
    const data = JSON.stringify([{ role: 'user', text: 'Plan the beds', sourceMessageId: 'm0' }, { role: 'assistant', text: 'Two rows.', sourceMessageId: 'm1' }]);
    const bridge = {
      getEmbeddedBrowserState: async () => ({ tabs: [{ id: 't1', url: source.url, title: 'Garden plan' }] }),
      commandEmbeddedBrowser: async () => ({ kind: 'value', value: { ok: true, value: 1, url: source.url, title: 'Garden plan', stored: [
        { handle: 'messages', kind: 'json', name: 'messages', mimeType: 'application/json', size: data.length, data },
      ] } }),
    } as never;
    const run = startSessionImportRun({
      api, bridge, tabId: 't1', sourceUrl: source.url,
      mode: { kind: 'create', title: 'Garden plan', spaceIds: [], clientMessageId: 'c1' },
    });
    await vi.waitFor(() => expect(sockets).toHaveLength(1), { timeout: 5_000 });
    const socket = sockets[0]!;
    socket.emit('open');
    socket.emit('message', wire('harness_status_changed', { status: 'running' }));
    socket.emit('message', wire('desktop_action_requested', { request: { id: 'a0', action: { kind: 'browser.evaluate', script: 'return 1' } } }));
    socket.emit('message', wire('desktop_action_requested', { request: { id: 'a1', action: { kind: 'session_import.finish', title: 'Garden plan', messages: 'messages', verification } } }));
    await vi.waitFor(() => expect(socket.log.filter((entry) => entry === 'send answer_desktop_action')).toHaveLength(2), { timeout: 5_000 });
    socket.emit('message', wire('harness_status_changed', { status: 'completed' }));
    await expect(run.done).resolves.toEqual({ kind: 'unfinished', refusal: 'This import key belongs to another thread' });
  });
});
