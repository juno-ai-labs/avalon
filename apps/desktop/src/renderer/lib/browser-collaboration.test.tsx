import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { BrowserEntry } from '../../../../browser/src/entry';
import { cookieClientSession } from '../../../../browser/src/session';
import BrowserConversation from '../../../../browser/src/conversation';

const user={id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',email:'guest@example.test',name:'Guest',avatarUrl:null,timezone:'UTC',createdAt:'2026-09-17T00:00:00.000Z'};
const workspace={id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',name:'Design team',slug:'design',region:'global' as const,accessClass:'guest' as const,role:null,timezone:'UTC',createdAt:'2026-09-17T00:00:00.000Z'};
const parent='cccccccc-cccc-4ccc-8ccc-cccccccccccc',child='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
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
      this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(snapshot) }));
    }
  }
  open() { this.readyState = 1; this.dispatchEvent(new Event('open')); }
  close() { this.readyState = 3; this.dispatchEvent(Object.assign(new Event('close'), { code: 1000 })); }
}

// Full entry, collaboration surface, API and socket hook. Only browser transport
// boundaries are substituted, so session reconciliation exercises their wiring.
it('keeps the live collaboration socket across a focus session refresh', async () => {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  BrowserSocket.instances = [];
  vi.stubGlobal('WebSocket', BrowserSocket);
  let selections = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    const path = new URL(String(input), 'http://localhost').pathname;
    const metadata = { user, workspace: null, expiresAt: new Date(Date.now() + 3_600_000).toISOString() };
    if (path.endsWith('/session') || path.endsWith('/session/renew')) return Response.json(metadata);
    if (path.endsWith('/workspaces')) return Response.json({ workspaces: [workspace] });
    if (path.endsWith('/workspace/select')) { selections++; return Response.json({ ...metadata, workspace }); }
    if (path.endsWith('/sharing/directory')) return Response.json({ workstreams: [{ parentId: parent, title: 'Shared parent', archived: false,
      conversations: [{ substreamId: child, title: 'Shared child conversation', archived: false }] }] });
    if (path.endsWith('/socket')) return Response.json({ url: 'wss://api.rallywith.ai/socket/conversations/' + parent + '/' + child, ticket: 'fixture-ticket' });
    if (path.endsWith('/sidekicks') || path.endsWith('/recommended-sidekicks')) return Response.json({ items: [] });
    if (path.endsWith('/feature-flags')) return Response.json({ liveArtifactsEnabled: false });
    return Response.json({ error: { message: 'Unexpected request: ' + path } }, { status: 404 });
  }));
  history.replaceState(null, '', '/app/workspaces/global/' + workspace.id + '/workstreams/' + parent + '/substreams/' + child);
  const view = render(<BrowserEntry renderCollaboration={(region, session, onSignOut) =>
    <BrowserConversation session={cookieClientSession(region, session)} onSignOut={onSignOut} />} />);
  try {
    await waitFor(() => expect(BrowserSocket.instances).toHaveLength(1));
    const socket = BrowserSocket.instances[0]!;
    await act(async () => { socket.open(); });
    await screen.findByRole('heading', { name: 'Shared child conversation' });
    const previousSelections = selections;
    fireEvent.focus(window);
    await waitFor(() => expect(selections).toBeGreaterThan(previousSelections));
    await act(async () => { await Promise.resolve(); });
    expect(socket.readyState).toBe(BrowserSocket.OPEN);
    expect(BrowserSocket.instances).toHaveLength(1);
    expect(screen.getByRole('heading', { name: 'Shared child conversation' })).toBeInTheDocument();
  } finally { view.unmount(); history.replaceState(null, '', '/'); }
});
