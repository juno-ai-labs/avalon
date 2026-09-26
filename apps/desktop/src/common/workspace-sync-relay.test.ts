import { ClientFeatureFlagsSchema, WORKSPACE_SYNC_TOPICS } from '@rally/contracts';
import { describe, expect, it, vi } from 'vitest';
import {
  createWorkspaceSyncRelayInbox,
  parseWorkspaceSyncPublication,
  parseWorkspaceSyncRelayEvent,
  parseWorkspaceSyncSourceSnapshot,
  type WorkspaceSyncRelayEvent,
} from './workspace-sync-relay';

const workspaceId = '00000000-0000-7000-8000-000000000001';
const otherWorkspaceId = '00000000-0000-7000-8000-000000000009';
const flags = ClientFeatureFlagsSchema.parse({});

describe('parseWorkspaceSyncPublication', () => {
  it('accepts every publication shape, including every topic the contract names', () => {
    for (const state of ['connecting', 'connected', 'reconnecting', 'unavailable'] as const) {
      expect(parseWorkspaceSyncPublication({ type: 'state', workspaceId, state }))
        .toEqual({ ok: true, value: { type: 'state', workspaceId, state } });
    }
    const topics = [...WORKSPACE_SYNC_TOPICS];
    expect(parseWorkspaceSyncPublication({ type: 'topics', workspaceId, waterline: 7, topics }))
      .toEqual({ ok: true, value: { type: 'topics', workspaceId, waterline: 7, topics } });
    expect(parseWorkspaceSyncPublication({ type: 'feature_flags', workspaceId, flags }))
      .toEqual({ ok: true, value: { type: 'feature_flags', workspaceId, flags } });
  });

  it('names the field it rejected', () => {
    expect(parseWorkspaceSyncPublication({ type: 'state', workspaceId: 'nope', state: 'connected' }))
      .toEqual({ ok: false, field: 'workspaceId' });
    expect(parseWorkspaceSyncPublication({ type: 'state', workspaceId, state: 'open' }))
      .toEqual({ ok: false, field: 'state' });
    expect(parseWorkspaceSyncPublication({ type: 'topics', workspaceId, waterline: -1, topics: ['notes'] }))
      .toEqual({ ok: false, field: 'waterline' });
    expect(parseWorkspaceSyncPublication({ type: 'topics', workspaceId, waterline: 1, topics: ['secrets'] }))
      .toEqual({ ok: false, field: 'topics' });
    expect(parseWorkspaceSyncPublication({ type: 'topics', workspaceId, waterline: 1, topics: [] }))
      .toEqual({ ok: false, field: 'topics' });
    expect(parseWorkspaceSyncPublication({ type: 'feature_flags', workspaceId, flags: { ...flags, extra: true } }))
      .toEqual({ ok: false, field: 'flags' });
    expect(parseWorkspaceSyncPublication({ type: 'feature_flags', workspaceId, flags: { ...flags, digestsEnabled: 1 } }))
      .toEqual({ ok: false, field: 'flags' });
    expect(parseWorkspaceSyncPublication({ type: 'sidebar', workspaceId }))
      .toEqual({ ok: false, field: 'type' });
    expect(parseWorkspaceSyncPublication({ type: 'state', workspaceId, state: 'connected', url: 'wss://x' }))
      .toEqual({ ok: false, field: 'state' });
  });
});

describe('parseWorkspaceSyncRelayEvent', () => {
  it('accepts a source, including none, and news', () => {
    expect(parseWorkspaceSyncRelayEvent({ type: 'source', revision: 2, source: { workspaceId, state: 'connected' } }))
      .toEqual({ type: 'source', revision: 2, source: { workspaceId, state: 'connected' } });
    expect(parseWorkspaceSyncRelayEvent({ type: 'source', revision: 3, source: null }))
      .toEqual({ type: 'source', revision: 3, source: null });
    expect(parseWorkspaceSyncRelayEvent({ type: 'topics', workspaceId, waterline: 4, topics: ['member_directory'] }))
      .toEqual({ type: 'topics', workspaceId, waterline: 4, topics: ['member_directory'] });
  });

  it('refuses a state event, which only ever travels toward main, and malformed ones', () => {
    for (const event of [
      { type: 'state', workspaceId, state: 'connected' },
      { type: 'source', revision: -1, source: null },
      { type: 'source', revision: 1, source: { workspaceId, state: 'connected', extra: 1 } },
      { type: 'topics', workspaceId: 'x', waterline: 1, topics: ['notes'] },
      null,
      'topics',
    ]) expect(parseWorkspaceSyncRelayEvent(event)).toBeNull();
  });

  it('reads a snapshot the way it reads a source event', () => {
    expect(parseWorkspaceSyncSourceSnapshot({ revision: 0, source: null })).toEqual({ revision: 0, source: null });
    expect(parseWorkspaceSyncSourceSnapshot({ revision: 0 })).toBeNull();
  });
});

describe('createWorkspaceSyncRelayInbox', () => {
  it('holds news that arrives before a listener, folded, and hands it to the first one', async () => {
    const inbox = createWorkspaceSyncRelayInbox();
    inbox.receive({ type: 'topics', workspaceId, waterline: 3, topics: ['member_directory'] });
    inbox.receive({ type: 'topics', workspaceId, waterline: 5, topics: ['workspace_profile', 'member_directory'] });
    inbox.receive({ type: 'feature_flags', workspaceId, flags: { ...flags, developerSettings: true } });
    inbox.receive({ type: 'feature_flags', workspaceId, flags });
    inbox.receive({ type: 'source', revision: 1, source: { workspaceId, state: 'connected' } });

    const received: WorkspaceSyncRelayEvent[] = [];
    inbox.subscribe((event) => received.push(event));
    await Promise.resolve();
    expect(received).toEqual([
      { type: 'topics', workspaceId, waterline: 5, topics: ['member_directory', 'workspace_profile'] },
      { type: 'feature_flags', workspaceId, flags },
    ]);

    // Handed over once: a second listener gets only what arrives from now on.
    const later = vi.fn();
    inbox.subscribe(later);
    await Promise.resolve();
    expect(later).not.toHaveBeenCalled();
    inbox.receive({ type: 'topics', workspaceId, waterline: 6, topics: ['notes'] });
    expect(later).toHaveBeenCalledWith({ type: 'topics', workspaceId, waterline: 6, topics: ['notes'] });
    expect(received.at(-1)).toEqual({ type: 'topics', workspaceId, waterline: 6, topics: ['notes'] });
  });

  it('drops held news about an Organization the session has left', async () => {
    const inbox = createWorkspaceSyncRelayInbox();
    inbox.receive({ type: 'topics', workspaceId: otherWorkspaceId, waterline: 9, topics: ['notes'] });
    inbox.receive({ type: 'topics', workspaceId, waterline: 2, topics: ['member_directory'] });
    const listener = vi.fn();
    inbox.subscribe(listener);
    await Promise.resolve();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({ type: 'topics', workspaceId, waterline: 2, topics: ['member_directory'] });
  });
});
