import { watchWorkspaceSocket, type ReachSocket } from '@rally/contracts/workspace-reach-watch';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChannelDirectoryWatch } from './channel-directory-watch';
import { menuBarContentFromDirectory } from './menu-bar-content';

type Listener = (event: never) => void;

class FakeSocket implements ReachSocket {
  sent: Array<Record<string, unknown>> = [];
  private listeners = new Map<string, Listener[]>();

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }

  close(): void {
    this.emit('close', { code: 1000 });
  }

  emit(type: string, event: unknown = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event as never);
  }

  message(body: unknown): void {
    this.emit('message', { data: JSON.stringify(body) });
  }

  requests(type: string): Array<Record<string, unknown>> {
    return this.sent.filter((frame) => frame['type'] === type);
  }
}

const workspaceId = '00000000-0000-7000-8000-0000000000a0';
const GENERAL = '00000000-0000-7000-8000-0000000000f0';
const HIRING = '00000000-0000-7000-8000-0000000000f2';
const ACME = '00000000-0000-7000-8000-000000000001';
const PRICING = '00000000-0000-7000-8000-000000000002';
const QUIET = '00000000-0000-7000-8000-000000000003';
const BREAKOUT = '00000000-0000-7000-8000-0000000000b1';
const USER = '00000000-0000-7000-8000-0000000000c1';

function row(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id, workspaceId, title: 'Channel', titleStatus: 'settled', objective: '',
    emailAddress: null, createdByUserId: null, harnessStatus: 'completed',
    latestAttentionSequenceNumber: 4, readThroughSequenceNumber: 4, manualUnreadFromSequenceNumber: null,
    manualUnreadGeneration: 0, hasUnread: false, youAreMentioned: false, firstUnreadSequenceNumber: null,
    lastActivityAt: '2026-10-06T10:00:00.000Z', createdAt: '2026-10-01T10:00:00.000Z',
    updatedAt: '2026-10-06T10:00:00.000Z', archivedAt: null, scope: 'workspace', systemKind: null,
    nextPendingWakeup: null, pinPosition: null, participantUserIds: [], participantExtraCount: 0, spaceIds: [GENERAL],
    ...extra,
  };
}

function version(commonWaterline: number, viewerWaterline = 4, authorityGeneration = 1): Record<string, unknown> {
  return {
    commonEventId: `00000000-0000-7000-8000-${commonWaterline.toString(16).padStart(12, '0')}`,
    viewerEventId: viewerWaterline === 0 ? null : `00000000-0000-7000-8001-${viewerWaterline.toString(16).padStart(12, '0')}`,
    authorityGeneration,
    commonWaterline,
    viewerWaterline,
  };
}

function space(id: string, name: string): Record<string, unknown> {
  return {
    id, name, iconKey: 'briefcase', colorKey: 'blue', scope: 'workspace', status: 'active',
    systemRole: id === GENERAL ? 'general' : null, revision: 1, reach: 'participant',
    participants: [{ userId: USER }], channelCount: 0, defaultResourceIds: [], defaultSidekickIds: [],
    createdAt: '2026-08-27T00:00:00.000Z', updatedAt: '2026-08-27T00:00:00.000Z',
  };
}

function subscribeAnswer(spaceIds: string[]): Record<string, unknown> {
  return {
    type: 'workspace_sync',
    eventId: '00000000-0000-7000-8000-000000000017',
    waterline: 4,
    occurredAt: '2026-10-06T10:00:00.000Z',
    topics: ['workstream_directory'],
    reason: 'initial',
    sidebar: {
      workstreams: { directoryWaterline: 7, nextCursor: null, stateVersions: [], items: [] },
      automations: { waterline: 1, items: [] },
      notes: { waterline: 1, items: [], nextCursor: null },
      spaces: {
        active: { waterline: 4, items: spaceIds.map((id) => space(id, id === GENERAL ? 'General' : 'Hiring')) },
        inactive: { waterline: 4, items: [] },
      },
      channelsBySpace: true,
    },
  };
}

function spaceAnswer(
  request: Record<string, unknown>,
  rows: Array<Record<string, unknown>>,
  nextAfter: string | null = null,
  commonWaterline = 7,
): Record<string, unknown> {
  return {
    type: 'workspace_space_channels',
    requestId: request['requestId'],
    directoryWaterline: 7,
    items: rows,
    stateVersions: rows.map((item) => ({ workstreamId: item['id'], ...version(commonWaterline) })),
    rails: [],
    nextAfter,
  };
}

function stateFrame(id: string, stateVersion: Record<string, unknown>, workstream: Record<string, unknown> | null) {
  return {
    type: 'workspace_workstream_state',
    occurredAt: '2026-10-06T11:00:00.000Z',
    workstreamId: id,
    stateVersion,
    workstream,
  };
}

const flush = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve); });

function harness() {
  const sockets: FakeSocket[] = [];
  const onChange = vi.fn();
  const logWarning = vi.fn();
  let nextRequest = 0;
  const watch = new ChannelDirectoryWatch({
    socket: (handlers) => watchWorkspaceSocket({
      ticket: () => Promise.resolve({ url: 'wss://api.rally.test/socket/workspaces/w', ticket: 'ticket' }),
      open: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      ...handlers,
    }),
    onChange,
    requestId: () => `00000000-0000-7000-8000-${(nextRequest += 1).toString(16).padStart(12, '0')}`,
    logWarning,
  });
  const connected = async (): Promise<FakeSocket> => {
    await flush();
    const socket = sockets.at(-1)!;
    socket.emit('open');
    return socket;
  };
  return { watch, sockets, onChange, logWarning, connected };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('channel directory watch', () => {
  it('walks every Space after subscribing and yields the sidebar\'s attention list and recent order', async () => {
    const subject = harness();
    subject.watch.start();
    const socket = await subject.connected();
    expect(socket.sent[0]).toEqual({ type: 'subscribe', afterWaterline: 0 });

    socket.message(subscribeAnswer([GENERAL, HIRING]));
    const [general, hiring] = socket.requests('space_channels');
    expect(general).toMatchObject({ spaceId: GENERAL, rails: false });
    expect(hiring).toMatchObject({ spaceId: HIRING, rails: false });
    expect(subject.watch.snapshot().complete).toBe(false);

    socket.message(spaceAnswer(general!, [
      // Unread Main: the attention ordinal is past the reader's read point.
      row(ACME, { title: 'Acme renewal', latestAttentionSequenceNumber: 6, lastActivityAt: '2026-10-06T09:00:00.000Z' }),
      // Caught-up Main, with one Breakout that mentions the reader.
      row(PRICING, {
        title: 'Pricing',
        lastActivityAt: '2026-10-06T11:00:00.000Z',
        breakoutAttentionCount: 1,
        privateChildren: [{
          substreamId: BREAKOUT, title: 'Discount call', youAreMentioned: true, createdByUserId: USER,
          createdAt: '2026-10-05T10:00:00.000Z', updatedAt: '2026-10-06T08:00:00.000Z',
          lastActivityAt: '2026-10-06T08:00:00.000Z',
        }],
      }),
    ]));
    socket.message(spaceAnswer(hiring!, [row(QUIET, { title: 'Quiet', lastActivityAt: '2026-10-06T10:00:00.000Z' })]));
    await flush();

    const snapshot = subject.watch.snapshot();
    expect(snapshot.complete).toBe(true);
    const content = menuBarContentFromDirectory(snapshot);
    expect(content.attention.map((item) => [item.title, item.substreamId, item.reason])).toEqual([
      ['Discount call', BREAKOUT, 'mentioned'],
      ['Acme renewal', null, 'unread'],
    ]);
    expect(content.recents.map((item) => item.title)).toEqual(['Pricing', 'Quiet', 'Acme renewal']);
    expect(subject.onChange).toHaveBeenCalled();
  });

  it('follows a Space\'s pages to the end before calling the list whole', async () => {
    const subject = harness();
    subject.watch.start();
    const socket = await subject.connected();
    socket.message(subscribeAnswer([GENERAL]));

    socket.message(spaceAnswer(socket.requests('space_channels')[0]!, [row(ACME)], ACME));
    await flush();
    expect(subject.watch.snapshot().complete).toBe(false);
    expect(socket.requests('space_channels')[1]).toMatchObject({ spaceId: GENERAL, after: ACME });

    socket.message(spaceAnswer(socket.requests('space_channels')[1]!, [row(PRICING)]));
    await flush();
    expect(subject.watch.snapshot().channels.map((channel) => channel.id)).toEqual([ACME, PRICING]);
    expect(subject.watch.snapshot().complete).toBe(true);
  });

  it('applies newer pushes, refuses older ones, and removes a Channel on its tombstone', async () => {
    const subject = harness();
    subject.watch.start();
    const socket = await subject.connected();
    socket.message(subscribeAnswer([GENERAL]));
    socket.message(spaceAnswer(socket.requests('space_channels')[0]!, [row(ACME, { title: 'Acme' }), row(PRICING)]));
    await flush();

    // A new message arrives: the common half moves and the reader has not read it.
    socket.message(stateFrame(ACME, version(8), row(ACME, { title: 'Acme', latestAttentionSequenceNumber: 9 })));
    expect(menuBarContentFromDirectory(subject.watch.snapshot()).attention.map((item) => item.title)).toEqual(['Acme']);

    // A push delayed behind it says the older state; it must not undo the unread.
    socket.message(stateFrame(ACME, version(6), row(ACME, { title: 'Stale title' })));
    const channels = subject.watch.snapshot().channels;
    expect(channels.find((channel) => channel.id === ACME)).toMatchObject({ title: 'Acme', hasUnread: true });

    socket.message(stateFrame(PRICING, version(8), null));
    expect(subject.watch.snapshot().channels.map((channel) => channel.id)).toEqual([ACME]);
  });

  it('is not whole again until a Space added after the walk has been read', async () => {
    const subject = harness();
    subject.watch.start();
    const socket = await subject.connected();
    socket.message(subscribeAnswer([GENERAL]));
    socket.message(spaceAnswer(socket.requests('space_channels')[0]!, [row(ACME)]));
    await flush();
    expect(subject.watch.snapshot().complete).toBe(true);

    socket.message({
      type: 'workspace_space_snapshot',
      occurredAt: '2026-10-06T11:00:00.000Z',
      spaces: {
        active: { waterline: 5, items: [space(GENERAL, 'General'), space(HIRING, 'Hiring')] },
        inactive: { waterline: 5, items: [] },
      },
      ordering: [],
      spacesReady: true,
    });
    const hiring = socket.requests('space_channels').find((frame) => frame['spaceId'] === HIRING);
    expect(hiring).toBeDefined();
    expect(subject.watch.snapshot().complete).toBe(false);

    socket.message(spaceAnswer(hiring!, [row(PRICING, { latestAttentionSequenceNumber: 6 })]));
    await flush();
    expect(subject.watch.snapshot().complete).toBe(true);
    expect(subject.watch.snapshot().channels.map((channel) => channel.id)).toEqual([ACME, PRICING]);
  });

  it('reads the list again on reconnect and drops what the new walk did not return', async () => {
    const subject = harness();
    subject.watch.start();
    const first = await subject.connected();
    first.message(subscribeAnswer([GENERAL]));
    first.message(spaceAnswer(first.requests('space_channels')[0]!, [row(ACME), row(PRICING)]));
    await flush();

    first.emit('close', { code: 1006 });
    await vi.runOnlyPendingTimersAsync();
    const second = await subject.connected();
    expect(second).not.toBe(first);
    second.message(subscribeAnswer([GENERAL]));
    expect(subject.watch.snapshot().complete).toBe(false);
    // Pricing left this reader while the socket was down; nothing replayed its tombstone.
    second.message(spaceAnswer(second.requests('space_channels')[0]!, [row(ACME)], null, 9));
    await flush();

    expect(subject.watch.snapshot().channels.map((channel) => channel.id)).toEqual([ACME]);
    expect(subject.watch.snapshot().complete).toBe(true);
  });

  it('forgets every row when stopped, so the next account starts empty', async () => {
    const subject = harness();
    subject.watch.start();
    const socket = await subject.connected();
    socket.message(subscribeAnswer([GENERAL]));
    socket.message(spaceAnswer(socket.requests('space_channels')[0]!, [row(ACME)]));
    await flush();

    subject.watch.stop();

    expect(subject.watch.running()).toBe(false);
    expect(subject.watch.snapshot()).toEqual({ channels: [], breakouts: {}, complete: false });
  });

  it('stays incomplete when the socket goes mid-walk, rather than calling a partial list whole', async () => {
    const subject = harness();
    subject.watch.start();
    const socket = await subject.connected();
    socket.message(subscribeAnswer([GENERAL, HIRING]));
    socket.message(spaceAnswer(socket.requests('space_channels')[0]!, [row(ACME)]));

    socket.emit('close', { code: 1006 });
    await flush();

    expect(subject.watch.snapshot().complete).toBe(false);
    expect(subject.watch.snapshot().channels.map((channel) => channel.id)).toEqual(['00000000-0000-7000-8000-000000000001']);
  });
});
