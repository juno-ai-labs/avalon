import { uuidToBase58 } from '@rally/contracts/uuid-base58';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BrowserEntry } from '../../../../browser/src/entry';
import { cookieClientSession } from '../../../../browser/src/session';
import BrowserShell from '../../../../browser/src/shell';
import { MOBILE_COMMAND_EVENT } from '../../../../mobile/src/protocol';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const user={id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',email:'guest@example.test',name:'Guest',avatarUrl:null,timezone:'UTC',createdAt:'2026-09-17T00:00:00.000Z'};
const workspace={id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',name:'Design team',slug:'design',region:'global' as const,accessClass:'guest' as const,role:null,timezone:'UTC',createdAt:'2026-09-17T00:00:00.000Z'};
const parent='cccccccc-cccc-4ccc-8ccc-cccccccccccc',child='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const at='2026-09-17T00:00:00.000Z';
const snapshot={type:'snapshot',reason:'initial',sequence:1,occurredAt:at,workstream:{id:parent,workspaceId:workspace.id,title:'Shared child conversation',objective:'Collaborate in the shared child',createdByUserId:null,harnessStatus:'completed',latestAttentionSequenceNumber:0,readThroughSequenceNumber:0,manualUnreadFromSequenceNumber:null,manualUnreadGeneration:0,hasUnread:false,firstUnreadSequenceNumber:null,lastActivityAt:at,createdAt:at,updatedAt:at,archivedAt:null,participants:[{user,participationReason:'explicit',joinedAt:at}],viewers:[],resources:[],connections:[],openElicitations:[],latestHarnessRunId:null},transcript:{snapshotId:'00000000-0000-7000-8000-000000000777',snapshotThrough:0,eventSequence:0,snapshotAtUtc:at,unreadAnchorSequence:null,unreadReason:'no_unread',ranges:[],activities:[],activeActivities:[],pluginRuns:[],activeTurns:[],pendingInputs:[]},pendingInputChunkCount:0,activeStreams:[],activeCompaction:null};

class BrowserSocket extends EventTarget {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSED = 3;
  static instances: BrowserSocket[] = [];
  readyState = 0;
  sent: { type: string }[] = [];
  constructor(readonly url: string) { super(); BrowserSocket.instances.push(this); }
  send(raw: string) {
    if (raw === 'ping') return;
    const frame = JSON.parse(raw) as { type: string };
    this.sent.push(frame);
    if (frame.type === 'subscribe' || frame.type === 'request_snapshot') {
      this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(snapshot) }));
    }
  }
  open() { this.readyState = 1; this.dispatchEvent(new Event('open')); }
  close() { this.readyState = 3; this.dispatchEvent(Object.assign(new Event('close'), { code: 1000 })); }
}

let fetchHandler: (input: string, init?: RequestInit) => Promise<Response>;

/** The conversation feed sockets, apart from the tab's one workspace socket. */
const feedSockets = () => BrowserSocket.instances.filter((socket) => socket.url.includes('/socket/conversations/'));
const workspaceSockets = () => BrowserSocket.instances.filter((socket) => socket.url.includes('/socket/workspaces/'));
const workspaceTicket = () => Response.json({ url: `wss://api.rallywith.ai/socket/workspaces/${workspace.id}`, ticket: 'workspace-ticket' });

beforeEach(() => {
  BrowserSocket.instances = [];
  fetchHandler = async (input) => Response.json({ error: { message: `Unexpected request: ${input}` } }, { status: 404 });
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  vi.stubGlobal('WebSocket', BrowserSocket);
  vi.stubGlobal('fetch', vi.fn((input: string, init?: RequestInit) => fetchHandler(input, init)));
});

afterEach(() => {
  history.replaceState(null, '', '/');
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

it('reopens mobile hosted sites with fresh access and follows live resource heads', async () => {
  const siteA = '00000000-0000-7000-8000-0000000000a1';
  const siteB = '00000000-0000-7000-8000-0000000000a2';
  const versions = new Map([[siteA, 1], [siteB, 1]]);
  const opens: string[] = [];
  let detailReads = 0;
  let published = false;
  let failAccess = false;
  const metadataReads: string[] = [];
  const artifact = (id: string) => ({ resourceId: id, title: id === siteA ? 'Site A' : 'Site B', kind: 'site', mimeType: 'text/html', version: versions.get(id), updatedAt: at });
  const canvas = { id: parent, title: 'Mobile Canvas', createdByUserId: user.id, createdAt: at, updatedAt: at,
    lastEditor: null, writerSidekickId: null, visibility: 'participants', participantUserIds: [user.id], canManage: false };
  fetchHandler = async (input) => {
    const path = new URL(String(input), 'http://localhost').pathname;
    if (path.endsWith('/workspace/socket')) return workspaceTicket();
    if (path.endsWith(`/canvases/${parent}`)) { detailReads++; return Response.json({ ...canvas, artifacts: published ? [artifact(siteA), artifact(siteB)] : [] }); }
    if (path.endsWith('/socket')) return Response.json({ url: `wss://api.rallywith.ai/socket/conversations/${parent}/0`, ticket: 'conversation-ticket' });
    for (const id of [siteA, siteB]) {
      if (path.endsWith(`/resources/${id}/artifact/open`)) {
        opens.push(id);
        if (failAccess) return Response.json({ error: { message: 'Artifact unavailable' } }, { status: 404 });
        return Response.json({ openUrl: `https://${id}.rallyusercontent.com/open#code-${opens.length}`, canonicalUrl: `https://${id}.rallyusercontent.com/`, artifactId: id, mode: 'static', stateful: false });
      }
      if (path.endsWith(`/resources/${id}`)) {
        metadataReads.push(id);
        return Response.json({ error: { message: 'Hosted sites must open from the canvas descriptor' } }, { status: 404 });
      }
    }
    return Response.json({ error: { message: 'Unexpected request: ' + path } }, { status: 404 });
  };
  const events: Array<{ event: { type: string; artifact?: { openUrl: string; version: number }; snapshot?: { view: string; artifactId: string | null } } }> = [];
  vi.stubGlobal('__RALLY_MOBILE_BRIDGE_TOKEN__', 'test-capability');
  vi.stubGlobal('ReactNativeWebView', { postMessage: (raw: string) => events.push(JSON.parse(raw)) });
  history.replaceState(null, '', `/app/global/${uuidToBase58(workspace.id)}/cv/${uuidToBase58(parent)}?mobile=1`);
  const view = render(<BrowserShell region="global" session={cookieClientSession('global', { user, workspace, expiresAt: new Date(Date.now() + 3_600_000).toISOString() })} onSignOut={() => undefined} onRevalidate={() => undefined} />);
  const access = () => events.filter(({ event }) => event.type === 'artifact').at(-1)?.event.artifact;
  try {
    await waitFor(() => expect(location.hash).toContain('view=chat'));
    expect(screen.queryByRole('button', { name: 'View canvas' })).not.toBeInTheDocument();
    await waitFor(() => expect(workspaceSockets()).toHaveLength(1));
    const socket = workspaceSockets()[0]!;
    act(() => socket.open());
    published = true;
    const row = { ...canvas, artifactKind: 'site', unread: false, presentUserIds: [], pinnedPosition: null, sharedWithMe: true };
    act(() => socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'workspace_canvas_list', occurredAt: at, waterline: 1, items: [row] }) })));
    fireEvent.click(await screen.findByRole('button', { name: 'View canvas' }));
    // The native host answers open-canvas by selecting this destination.
    act(() => window.dispatchEvent(new CustomEvent(MOBILE_COMMAND_EVENT, { detail: { type: 'open', id: parent, pinned: false } })));
    await waitFor(() => expect(access()?.openUrl).toContain('code-1'));
    expect(location.hash).toBe(`#/canvases/${parent}`);
    expect(location.search).toBe('?mobile=1');
    const picker = await screen.findByRole('combobox', { name: 'Choose artifact' });
    fireEvent.change(picker, { target: { value: siteB } });
    await waitFor(() => expect(access()?.openUrl).toContain('code-2'));
    fireEvent.change(picker, { target: { value: siteA } });
    await waitFor(() => expect(access()?.openUrl).toContain('code-3'));
    expect(opens).toEqual([siteA, siteB, siteA]);
    const head = (version: number) => ({ type: 'workspace_resource_versions', occurredAt: at, resources: [{ resourceId: siteA, version, title: 'Site A', mimeType: 'text/html', updatedAt: at, contentAvailable: true, sizeBytes: 42 }] });
    versions.set(siteA, 2);
    act(() => socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(head(2)) })));
    await waitFor(() => expect(access()?.version).toBe(2));
    expect(opens).toEqual([siteA, siteB, siteA, siteA]);
    // Presence changes with the same publication timestamp do not refetch.
    const reads = detailReads;
    act(() => socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'workspace_canvas_list', occurredAt: at, waterline: 2, items: [{ ...row, presentUserIds: [user.id], pinnedPosition: null }] }) })));
    await act(async () => { await Promise.resolve(); });
    expect(detailReads).toBe(reads);
    act(() => { location.hash = `#/canvases/${parent}?view=chat`; window.dispatchEvent(new HashChangeEvent('hashchange')); });
    await waitFor(() => expect(events.filter(({ event }) => event.type === 'snapshot').at(-1)?.event.snapshot?.view).toBe('conversation'));
    fireEvent.click(await screen.findByRole('button', { name: 'View canvas' }));
    act(() => window.dispatchEvent(new CustomEvent(MOBILE_COMMAND_EVENT, { detail: { type: 'open', id: parent, pinned: false } })));
    await waitFor(() => expect(events.filter(({ event }) => event.type === 'snapshot').at(-1)?.event.snapshot).toMatchObject({ view: 'artifact', artifactId: siteA }));
    expect(metadataReads).toEqual([]);
    failAccess = true;
    act(() => socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(head(3)) })));
    await waitFor(() => expect(events.some(({ event }) => event.type === 'artifact-unavailable')).toBe(true));
    expect(await screen.findByText('This canvas couldn’t open')).toBeInTheDocument();
  } finally { view.unmount(); }
});

it('keeps creation drafts during submission and reuses the canvas after an edited retry', async () => {
  const memberWorkspace = { ...workspace, accessClass: 'member' as const, role: 'member' as const };
  const maya = { ...user, id: '00000000-0000-7000-8000-0000000000a2', name: 'Maya Lin', email: 'maya@example.test' };
  const createdIds: string[] = [];
  const sent: Array<{ text: string; clientMessageId: string; confirmedParticipantUserIds: string[]; mentions: Array<{ userId: string }> }> = [];
  const sends: Array<ReturnType<typeof deferred<Response>>> = [];
  fetchHandler = async (input, init) => {
    const path = new URL(String(input), 'http://localhost').pathname;
    if (path.endsWith('/workspace/socket')) return workspaceTicket();
    if (path.endsWith('/workspace/members')) return Response.json({ items: [user, maya].map((person) => ({ user: person, role: 'member', status: 'active', joinedAt: at })) });
    if (path.endsWith('/canvases') && init?.method === 'POST') {
      const { canvasId } = JSON.parse(String(init.body));
      createdIds.push(canvasId);
      return Response.json({ canvasId, turnId: null });
    }
    if (path.endsWith('/messages')) {
      sent.push(JSON.parse(String(init?.body)));
      const pending = deferred<Response>();
      sends.push(pending);
      return pending.promise;
    }
    return Response.json({ error: { message: 'Unexpected request: ' + path } }, { status: 404 });
  };
  history.replaceState(null, '', `/app/workspaces/global/${workspace.id}?mobile=1#/canvases`);
  const view = render(<BrowserShell region="global" session={cookieClientSession('global', { user, workspace: memberWorkspace, expiresAt: new Date(Date.now() + 3_600_000).toISOString() })} onSignOut={() => undefined} onRevalidate={() => undefined} />);
  const refuse = () => Response.json({ error: { message: 'Try again later' } }, { status: 400 });
  try {
    act(() => window.dispatchEvent(new CustomEvent(MOBILE_COMMAND_EVENT, { detail: { type: 'create' } })));
    const input = await screen.findByRole('textbox', { name: 'Describe your canvas' });
    fireEvent.change(input, { target: { value: 'Please ask @Maya Lin' } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Create canvas' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Create canvas' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Add and mention' }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.confirmedParticipantUserIds).toEqual([maya.id]);
    expect(sent[0]!.mentions.map((mention) => mention.userId)).toEqual([maya.id]);
    fireEvent.change(input, { target: { value: 'A second thought' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(input).toHaveValue('A second thought');
    expect(sent).toHaveLength(1);
    await act(async () => sends[0]!.resolve(refuse()));
    fireEvent.click(await screen.findByRole('button', { name: 'OK' }));
    fireEvent.change(input, { target: { value: 'An edited retry' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Create canvas' }));
    await waitFor(() => expect(sent).toHaveLength(2));
    expect(createdIds).toHaveLength(2);
    expect(createdIds[1]).toBe(createdIds[0]);
    expect(sent[1]!.text).toBe('An edited retry');
    expect(sent[1]!.clientMessageId).not.toBe(sent[0]!.clientMessageId);
    await act(async () => sends[1]!.resolve(refuse()));
  } finally { for (const send of sends) send.resolve(refuse()); view.unmount(); }
});

/**
 * The route families that refuse a guest, with the exceptions the API makes
 * under `/workspace` (the profile, the roster and the socket ticket). Copied from the
 * `protectedApi` mounts in `apps/api/src/app.ts`; a family added there belongs
 * here too.
 */
const MEMBER_ONLY = /\/browser\/api\/[^/]+\/(workspace\/(?!socket$|members$|me\/device-timezone$)|workspaces|workstreams|work-opportunities|projects|spaces(?!\/[^/]+\/channels)|digest|connections|favicons|realtime)/u;

// Full entry, the shell members use, API and socket hooks. Only browser
// transport boundaries are substituted, so a guest exercises the same tree.
it('opens a guest in the shared shell without asking for anything a guest is refused', async () => {
  let selections = 0;
  const requested: string[] = [];
  const unexpected: string[] = [];
  fetchHandler = async (input: string) => {
    const path = new URL(String(input), 'http://localhost').pathname;
    requested.push(path);
    const metadata = { user, workspace: null, expiresAt: new Date(Date.now() + 3_600_000).toISOString() };
    if (path.endsWith('/session') || path.endsWith('/session/renew')) return Response.json(metadata);
    if (path.endsWith('/browser/workspaces')) return Response.json({ workspaces: [workspace] });
    if (path.endsWith('/workspace/select')) { selections++; return Response.json({ ...metadata, workspace }); }
    if (path.endsWith(`/api/${workspace.id}/workspace`)) return Response.json(workspace);
    if (path.endsWith('/onboarding/account')) return Response.json({ revision: 1, eligible: true, introduced: false, presentation: null });
    if (path.endsWith('/sharing/navigation')) return Response.json({ spaces: [{
      id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', name: 'Guest space', iconKey: 'briefcase', colorKey: 'blue', scope: 'personal', workstreamIds: [parent],
    }], workstreams: [{ parentId: parent, title: 'Shared parent', scope: 'personal', archived: false,
      conversations: [{ substreamId: child, title: 'Shared child conversation', scope: 'personal', archived: false }] }] });
    if (path.endsWith('/workspace/socket')) return workspaceTicket();
    if (path.endsWith('/socket')) {
      const substream = /\/substreams\/([^/]+)\/socket$/u.exec(path)?.[1] ?? '0';
      return Response.json({ url: 'wss://api.rallywith.ai/socket/conversations/' + parent + '/' + substream, ticket: 'fixture-ticket' });
    }
    if (path.endsWith('/sidekicks') || path.endsWith('/recommended-sidekicks')) return Response.json({ items: [] });
    if (path.endsWith('/navigation/threads')) return Response.json({ items: [], pinned: [], nextCursor: null });
    if (path.endsWith('/feature-flags')) return Response.json({});
    if (path.endsWith(`/canvases/${parent}`)) return Response.json({
      id: parent, title: 'Shared Canvas', createdByUserId: '00000000-0000-7000-8000-0000000000a1', createdAt: '2026-11-07T09:00:00.000Z',
      updatedAt: '2026-11-07T09:00:00.000Z', lastEditor: null, writerSidekickId: null, visibility: 'participants',
      participantUserIds: [user.id], canManage: false, artifacts: [],
    });
    unexpected.push(path);
    return Response.json({ error: { message: 'Unexpected request: ' + path } }, { status: 404 });
  };
  // A Canvas shared with the guest, opened from its link.
  history.replaceState(null, '', `/app/global/${uuidToBase58(workspace.id)}/cv/${uuidToBase58(parent)}/`);
  const view = render(<BrowserEntry renderCollaboration={(region, session, onSignOut, onRevalidate) =>
    <BrowserShell region="global" session={cookieClientSession(region, session)} onSignOut={onSignOut} onRevalidate={onRevalidate} />} />);
  try {
    // The Canvas's Chat is the one feed held open.
    const live = () => feedSockets().filter((socket) => socket.readyState !== BrowserSocket.CLOSED);
    await waitFor(() => expect(live().map((socket) => new URL(socket.url).pathname.split('/').slice(-2))).toEqual([[parent, '0']]));
    const opened = live()[0];
    expect(opened, `unexpected requests: ${unexpected.join(', ')}`).toBeDefined();
    const socket = opened!;
    await act(async () => { socket.open(); });
    const previousSelections = selections;
    fireEvent.focus(window);
    await waitFor(() => expect(selections).toBeGreaterThan(previousSelections));
    await act(async () => { await Promise.resolve(); });
    expect(socket.readyState).toBe(BrowserSocket.OPEN);
    expect(live()).toEqual([socket]);
    expect(workspaceSockets()).toHaveLength(1);
    // The Organization's setup does not stand in front of a guest, and
    // nothing they are refused was asked for.
    expect(requested.filter((path) => MEMBER_ONLY.test(path))).toEqual([]);
  } finally { view.unmount(); }
});

it('prepares hosted pins through Home and opens fresh access without another browser session', async () => {
  const site = '00000000-0000-7000-8000-0000000000a1';
  const canvas = { id: parent, title: 'Shopping', createdByUserId: user.id, createdAt: at, updatedAt: at,
    lastEditor: null, writerSidekickId: null, visibility: 'participants', participantUserIds: [user.id], canManage: false };
  let opens = 0;
  let fail = false;
  const events: Array<{ event: { type: string; canvas?: unknown; requestId?: string; artifact?: unknown } }> = [];
  fetchHandler = async (input) => {
    const path = new URL(String(input), 'http://localhost').pathname;
    if (path.endsWith('/workspace/socket')) return workspaceTicket();
    if (path.endsWith('/socket')) return Response.json({ url: `wss://api.rallywith.ai/socket/conversations/${parent}/0`, ticket: 'conversation-ticket' });
    if (path.endsWith(`/canvases/${parent}`)) return Response.json({ ...canvas, artifacts: [{ resourceId: site, title: 'Groceries', kind: 'site', mimeType: 'text/html', version: 1, updatedAt: at }] });
    if (path.endsWith(`/resources/${site}/artifact/open`)) {
      opens++;
      if (fail) return Response.json({ error: { message: 'Access unavailable' } }, { status: 403 });
      return Response.json({ openUrl: `https://${site}.rallyusercontent.com/open#code-${opens}`, canonicalUrl: `https://${site}.rallyusercontent.com/`, artifactId: site, mode: 'static', stateful: false });
    }
    return Response.json({ error: { message: 'Unexpected request: ' + path } }, { status: 404 });
  };
  vi.stubGlobal('__RALLY_MOBILE_BRIDGE_TOKEN__', 'test-capability');
  vi.stubGlobal('ReactNativeWebView', { postMessage: (raw: string) => events.push(JSON.parse(raw)) });
  history.replaceState(null, '', `/app/workspaces/global/${workspace.id}?mobile=1#/canvases`);
  const view = render(<BrowserShell region="global" session={cookieClientSession('global', { user, workspace, expiresAt: new Date(Date.now() + 3_600_000).toISOString() })} onSignOut={() => undefined} onRevalidate={() => undefined} />);
  const command = (requestId: string, userId = user.id) => act(() => window.dispatchEvent(new CustomEvent(MOBILE_COMMAND_EVENT, { detail: { type: 'open-prepared-artifact', requestId, userId, workspaceId: workspace.id, canvas: { canvasId: parent, resourceId: site, version: 1, title: 'Shopping' } } })));
  try {
    await waitFor(() => expect(workspaceSockets()).toHaveLength(1));
    const socket = workspaceSockets()[0]!;
    act(() => socket.open());
    const row = { ...canvas, artifactKind: 'site', unread: false, presentUserIds: [], pinnedPosition: 0, sharedWithMe: true };
    act(() => socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'workspace_canvas_list', occurredAt: at, waterline: 1, items: [row] }) })));
    await waitFor(() => expect(events.find(({ event }) => event.type === 'prepared-canvas')?.event.canvas).toEqual({ canvasId: parent, resourceId: site, version: 1, title: 'Shopping' }));
    expect(opens).toBe(0); // Do not cache an expiring single-use access URL.
    command('wrong-account', child);
    command('first');
    await waitFor(() => expect(events.find(({ event }) => event.requestId === 'first')?.event.artifact).toMatchObject({ openUrl: `https://${site}.rallyusercontent.com/open#code-1` }));
    command('retry');
    await waitFor(() => expect(events.find(({ event }) => event.requestId === 'retry')?.event.artifact).toMatchObject({ openUrl: `https://${site}.rallyusercontent.com/open#code-2` }));
    expect(events.some(({ event }) => event.requestId === 'wrong-account')).toBe(false);
    expect(workspaceSockets()).toHaveLength(1);
    expect(feedSockets()).toHaveLength(0);
    expect(location.hash).toBe('#/canvases');
    fail = true;
    command('denied');
    await waitFor(() => expect(events.find(({ event }) => event.requestId === 'denied')?.event.artifact).toBeNull());
    act(() => { location.hash = `#/canvases/${parent}?view=chat`; window.dispatchEvent(new HashChangeEvent('hashchange')); });
    await screen.findByRole('button', { name: 'View canvas' });
    act(() => socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'workspace_resource_versions', occurredAt: at, resources: [{ resourceId: site, version: 2, title: 'Groceries', mimeType: 'text/html', updatedAt: at, contentAvailable: true, sizeBytes: 42 }] }) })));
    await waitFor(() => expect(events.filter(({ event }) => event.type === 'prepared-canvas').at(-1)?.event.canvas).toMatchObject({ version: 2 }));
  } finally { view.unmount(); }
});
