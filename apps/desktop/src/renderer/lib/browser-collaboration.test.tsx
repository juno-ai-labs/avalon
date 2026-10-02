import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BrowserEntry } from '../../../../browser/src/entry';
import { cookieClientSession } from '../../../../browser/src/session';
import BrowserConversation from '../../../../browser/src/conversation';

const user={id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',email:'guest@example.test',name:'Guest',avatarUrl:null,timezone:'UTC',createdAt:'2026-09-17T00:00:00.000Z'};
const workspace={id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',name:'Design team',slug:'design',region:'global' as const,accessClass:'guest' as const,role:null,timezone:'UTC',createdAt:'2026-09-17T00:00:00.000Z'};
const parent='cccccccc-cccc-4ccc-8ccc-cccccccccccc',child='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const otherParent='11111111-1111-4111-8111-111111111111',otherChild='22222222-2222-4222-8222-222222222222';
const archivedParent='55555555-5555-4555-8555-555555555555',archivedChild='66666666-6666-4666-8666-666666666666';
const at='2026-09-17T00:00:00.000Z';
const snapshot={type:'snapshot',reason:'initial',sequence:1,occurredAt:at,workstream:{id:parent,workspaceId:workspace.id,title:'Shared child conversation',objective:'Collaborate in the shared child',createdByUserId:null,harnessStatus:'completed',latestAttentionSequenceNumber:0,readThroughSequenceNumber:0,manualUnreadFromSequenceNumber:null,manualUnreadGeneration:0,hasUnread:false,firstUnreadSequenceNumber:null,lastActivityAt:at,createdAt:at,updatedAt:at,archivedAt:null,participants:[{user,participationReason:'explicit',joinedAt:at}],viewers:[],resources:[],connections:[],openElicitations:[],latestHarnessRunId:null},transcript:{snapshotId:'00000000-0000-7000-8000-000000000777',snapshotThrough:0,eventSequence:0,snapshotAtUtc:at,unreadAnchorSequence:null,unreadReason:'no_unread',ranges:[],activities:[],activeActivities:[],pluginRuns:[],activeTurns:[],pendingInputs:[]},pendingInputChunkCount:0,initialContextChunkCount:0,activeStreams:[],activeCompaction:null};

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
      const currentParent = this.url.includes(otherParent) ? otherParent : parent;
      const currentTitle = currentParent === otherParent ? 'Channel Beta' : snapshot.workstream.title;
      this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({
        ...snapshot,
        workstream: { ...snapshot.workstream, id: currentParent, title: currentTitle },
      }) }));
    }
  }
  open() { this.readyState = 1; this.dispatchEvent(new Event('open')); }
  close() { this.readyState = 3; this.dispatchEvent(Object.assign(new Event('close'), { code: 1000 })); }
}

let fetchHandler: (input: string) => Promise<Response>;

/** The conversation feed sockets, apart from the tab's one workspace socket. */
const feedSockets = () => BrowserSocket.instances.filter((socket) => socket.url.includes('/socket/conversations/'));
const workspaceSockets = () => BrowserSocket.instances.filter((socket) => socket.url.includes('/socket/workspaces/'));
const workspaceTicket = () => Response.json({ url: `wss://api.rallywith.ai/socket/workspaces/${workspace.id}`, ticket: 'workspace-ticket' });

beforeEach(() => {
  BrowserSocket.instances = [];
  fetchHandler = async (input) => Response.json({ error: { message: `Unexpected request: ${input}` } }, { status: 404 });
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  vi.stubGlobal('WebSocket', BrowserSocket);
  vi.stubGlobal('fetch', vi.fn((input: string) => fetchHandler(input)));
});

afterEach(() => {
  history.replaceState(null, '', '/');
  vi.unstubAllGlobals();
});

// Full entry, collaboration surface, API and socket hook. Only browser transport
// boundaries are substituted, so session reconciliation exercises their wiring.
it('keeps the live collaboration socket across a focus session refresh', async () => {
  let selections = 0;
  fetchHandler = async (input: string) => {
    const path = new URL(String(input), 'http://localhost').pathname;
    const metadata = { user, workspace: null, expiresAt: new Date(Date.now() + 3_600_000).toISOString() };
    if (path.endsWith('/session') || path.endsWith('/session/renew')) return Response.json(metadata);
    if (path.endsWith('/workspaces')) return Response.json({ workspaces: [workspace] });
    if (path.endsWith('/workspace/select')) { selections++; return Response.json({ ...metadata, workspace }); }
    if (path.endsWith('/sharing/navigation')) return Response.json({ spaces: [{
      id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', name: 'Guest space', iconKey: 'briefcase', colorKey: 'blue', scope: 'personal', workstreamIds: [parent],
    }], workstreams: [{ parentId: parent, title: 'Shared parent', scope: 'personal', archived: false,
      conversations: [{ substreamId: child, title: 'Shared child conversation', scope: 'personal', archived: false }] }] });
    if (path.endsWith('/workspace/socket')) return workspaceTicket();
    if (path.endsWith('/socket')) return Response.json({ url: 'wss://api.rallywith.ai/socket/conversations/' + parent + '/' + child, ticket: 'fixture-ticket' });
    if (path.endsWith('/sidekicks') || path.endsWith('/recommended-sidekicks')) return Response.json({ items: [] });
    if (path.endsWith('/feature-flags')) return Response.json({ liveArtifactsEnabled: false });
    return Response.json({ error: { message: 'Unexpected request: ' + path } }, { status: 404 });
  };
  history.replaceState(null, '', '/app/workspaces/global/' + workspace.id + '/workstreams/' + parent + '/substreams/' + child);
  const view = render(<BrowserEntry renderCollaboration={(region, session, onSignOut) =>
    <BrowserConversation session={cookieClientSession(region, session)} onSignOut={onSignOut} />} />);
  try {
    // One feed: the directory lists only the Breakout, so Main is not this
    // guest's and no Main socket may be opened for it, even briefly.
    await waitFor(() => expect(feedSockets()).toHaveLength(1));
    const socket = feedSockets()[0]!;
    await act(async () => { socket.open(); });
    await screen.findByRole('button', { name: 'Breakout menu: Shared child conversation' });
    const previousSelections = selections;
    fireEvent.focus(window);
    await waitFor(() => expect(selections).toBeGreaterThan(previousSelections));
    await act(async () => { await Promise.resolve(); });
    expect(socket.readyState).toBe(BrowserSocket.OPEN);
    expect(feedSockets()).toHaveLength(1);
    // The membership socket is keyed by the workspace, not the session object,
    // so a focus-time session refresh does not reconnect it either.
    expect(workspaceSockets()).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Breakout menu: Shared child conversation' })).toBeInTheDocument();
  } finally { view.unmount(); }
});

it('groups a guest’s authorized Channels by Space and opens the shared Breakout', async () => {
  fetchHandler = async (input: string) => {
    const path = new URL(String(input), 'http://localhost').pathname;
    if (path.endsWith('/sharing/navigation')) return Response.json({
      spaces: [
        { id: '33333333-3333-4333-8333-333333333333', name: 'Product', iconKey: 'rocket', colorKey: 'violet', scope: 'personal', workstreamIds: [parent] },
        { id: '44444444-4444-4444-8444-444444444444', name: 'Research', iconKey: 'lightbulb', colorKey: 'teal', scope: 'workspace', workstreamIds: [archivedParent, otherParent, parent] },
      ],
      workstreams: [
        { parentId: parent, title: 'Channel Alpha', scope: 'personal', archived: false,
          conversations: [{ substreamId: child, title: 'Breakout Alpha', scope: 'personal', archived: false }] },
        { parentId: otherParent, title: 'Channel Beta', scope: 'workspace', archived: false,
          conversations: [{ substreamId: otherChild, title: 'Breakout Beta', scope: 'workspace', archived: false }] },
        { parentId: archivedParent, title: 'Archived channel', scope: 'personal', archived: true,
          conversations: [{ substreamId: archivedChild, title: 'Archived breakout', scope: 'personal', archived: true }] },
      ],
    });
    if (path.endsWith('/workspace/socket')) return workspaceTicket();
    if (path.endsWith('/socket')) return Response.json({ url: `wss://api.rallywith.ai/socket/conversations/${otherParent}/${otherChild}`, ticket: 'fixture-ticket' });
    if (path.endsWith('/sidekicks') || path.endsWith('/recommended-sidekicks')) return Response.json({ items: [] });
    if (path.endsWith('/feature-flags')) return Response.json({ liveArtifactsEnabled: false });
    return Response.json({ error: { message: 'Unexpected request: ' + path } }, { status: 404 });
  };
  history.replaceState(null, '', `/app/workspaces/global/${workspace.id}`);
  const session = cookieClientSession('global', { user, workspace, expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
  const view = render(<BrowserConversation session={session} onSignOut={vi.fn()} />);
  const pill = (name: string): HTMLElement => within(screen.getByRole('group', { name: 'Spaces' })).getByRole('button', { name });
  try {
    // All is every shared Channel; a pill filters the list and opens nothing.
    expect(await screen.findByRole('link', { name: 'Channel Alpha' })).toHaveAttribute('aria-description', 'Private channel');
    expect(pill('All')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('link', { name: 'Channel Beta' })).toHaveAttribute('aria-description', 'Public channel');
    expect(within(screen.getByRole('link', { name: 'Channel Alpha' })).getByText('Product, Research')).toBeInTheDocument();

    fireEvent.click(pill('Product'));
    expect(pill('Product')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('link', { name: 'Channel Alpha' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Channel Beta' })).not.toBeInTheDocument();
    expect(location.pathname).toBe(`/app/workspaces/global/${workspace.id}`);

    fireEvent.click(pill('Research'));
    fireEvent.click(await screen.findByRole('link', { name: 'Channel Beta' }));
    await waitFor(() => expect(location.pathname).toBe(`/app/workspaces/global/${workspace.id}/workstreams/${otherParent}/substreams/${otherChild}`));
    expect(pill('Research')).toHaveAttribute('aria-pressed', 'true');

    await waitFor(() => expect(feedSockets().length).toBeGreaterThan(0));
    await act(async () => { feedSockets().at(-1)!.open(); });
    // Main is not this guest's, so the shared Breakout opens alone.
    expect(await screen.findByRole('button', { name: /^Breakout menu: /u })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Close breakout' })).not.toBeInTheDocument();

    // A filter that would hide the open Channel widens the list to All.
    fireEvent.click(pill('Product'));
    await waitFor(() => expect(pill('All')).toHaveAttribute('aria-pressed', 'true'));
    expect(screen.getByRole('link', { name: 'Channel Beta' })).toBeInTheDocument();
  } finally { view.unmount(); }
});

it('keeps authorized Channels reachable when no visible Space contains them', async () => {
  fetchHandler = async (input: string) => {
    const path = new URL(String(input), 'http://localhost').pathname;
    if (path.endsWith('/sharing/navigation')) return Response.json({
      spaces: [],
      workstreams: [
        { parentId: parent, title: 'Channel Alpha', scope: 'personal', archived: false,
          conversations: [{ substreamId: child, title: 'Breakout Alpha', scope: 'personal', archived: false }] },
        { parentId: otherParent, title: 'Channel Beta', scope: 'workspace', archived: false,
          conversations: [{ substreamId: otherChild, title: 'Breakout Beta', scope: 'workspace', archived: false }] },
      ],
    });
    return Response.json({ error: { message: `Unexpected request: ${path}` } }, { status: 404 });
  };
  history.replaceState(null, '', `/app/workspaces/global/${workspace.id}`);
  const session = cookieClientSession('global', { user, workspace, expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
  const view = render(<BrowserConversation session={session} onSignOut={vi.fn()} />);
  try {
    expect(await screen.findByRole('link', { name: 'Channel Alpha' })).toHaveAttribute('aria-description', 'Private channel');
    expect(screen.getByRole('link', { name: 'Channel Beta' })).toHaveAttribute('aria-description', 'Public channel');
    // The Shared channels group is the only Space row, so its rail is hidden
    // and the Channels rail names it instead.
    expect(screen.queryByRole('complementary', { name: 'Spaces sidebar' })).not.toBeInTheDocument();
    expect(screen.getByRole('complementary', { name: 'Rally navigation' })).toHaveTextContent('Shared channels');
    expect(screen.queryByText(/Associated/u)).not.toBeInTheDocument();
  } finally { view.unmount(); }
});

it('opens a lone Channel with no hierarchy rails and keeps the account menu reachable', async () => {
  fetchHandler = async (input: string) => {
    const path = new URL(String(input), 'http://localhost').pathname;
    if (path.endsWith('/sharing/navigation')) return Response.json({
      spaces: [],
      workstreams: [{ parentId: parent, title: 'Channel Alpha', scope: 'personal', archived: true,
        conversations: [{ substreamId: child, title: 'Breakout Alpha', scope: 'personal', archived: true }] }],
    });
    return Response.json({ error: { message: `Unexpected request: ${path}` } }, { status: 404 });
  };
  history.replaceState(null, '', `/app/workspaces/global/${workspace.id}`);
  const session = cookieClientSession('global', { user, workspace, expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
  const view = render(<BrowserConversation session={session} onSignOut={vi.fn()} />);
  try {
    // An archived Channel mounts no Breakout rail, the other home for the menu.
    expect(await screen.findByRole('heading', { name: 'Archived channel' })).toBeVisible();
    expect(location.pathname).toBe(`/app/workspaces/global/${workspace.id}/workstreams/${parent}/substreams/${child}`);
    expect(screen.queryByRole('complementary', { name: 'Spaces sidebar' })).not.toBeInTheDocument();
    expect(screen.queryByRole('complementary', { name: 'Rally navigation' })).not.toBeInTheDocument();
    expect(view.container.querySelector('.browser-account-fallback')).toHaveTextContent('Design team');
    // No sidebar, so the main pane reserves no room for one.
    expect(view.container.querySelector<HTMLElement>('.browser-workspace')?.style.getPropertyValue('--av-cmp-sidebar-width')).toBe('0px');
  } finally { view.unmount(); }
});
