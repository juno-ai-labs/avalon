import { uuidToBase58 } from '@rally/contracts/uuid-base58';
import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BrowserEntry } from '../../../../browser/src/entry';
import { cookieClientSession } from '../../../../browser/src/session';
import BrowserShell from '../../../../browser/src/shell';

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
