import { describe, expect, it, vi } from 'vitest';
import {
  createWorkspaceSyncRelayInbox,
  isWorkspaceSyncRelayEvent,
  type WorkspaceSyncRelayEvent,
} from './workspace-sync-relay';

const workspaceId = '00000000-0000-7000-8000-000000000001';
const otherWorkspaceId = '00000000-0000-7000-8000-000000000009';
const region = 'global';

describe('isWorkspaceSyncRelayEvent', () => {
  it('admits the structure the inbox reads and nothing that would throw inside it', () => {
    expect(isWorkspaceSyncRelayEvent({ type: 'source', revision: 2, source: null })).toBe(true);
    expect(isWorkspaceSyncRelayEvent({ type: 'topics', region, workspaceId, waterline: 4, topics: ['resources'] })).toBe(true);
    for (const event of [
      { type: 'state', region, workspaceId, state: 'connected' },
      { type: 'source' },
      { type: 'topics', region, workspaceId, waterline: 1, topics: 'notes' },
      null,
      'topics',
    ]) expect(isWorkspaceSyncRelayEvent(event)).toBe(false);
  });
});

describe('createWorkspaceSyncRelayInbox', () => {
  it('holds news that arrives before a listener, folded, and hands it to the first one', async () => {
    const inbox = createWorkspaceSyncRelayInbox();
    inbox.receive({ type: 'topics', region, workspaceId, waterline: 3, topics: ['member_directory'] });
    inbox.receive({ type: 'topics', region, workspaceId, waterline: 5, topics: ['workspace_profile', 'member_directory'] });
    inbox.receive({ type: 'source', revision: 1, source: { region, workspaceId, state: 'connected' } });

    const received: WorkspaceSyncRelayEvent[] = [];
    inbox.subscribe((event) => received.push(event));
    await Promise.resolve();
    expect(received).toEqual([
      { type: 'topics', region, workspaceId, waterline: 5, topics: ['member_directory', 'workspace_profile'] },
    ]);

    // Handed over once: a second listener gets only what arrives from now on.
    const later = vi.fn();
    inbox.subscribe(later);
    await Promise.resolve();
    expect(later).not.toHaveBeenCalled();
    inbox.receive({ type: 'topics', region, workspaceId, waterline: 6, topics: ['resources'] });
    expect(later).toHaveBeenCalledWith({ type: 'topics', region, workspaceId, waterline: 6, topics: ['resources'] });
    expect(received.at(-1)).toEqual({ type: 'topics', region, workspaceId, waterline: 6, topics: ['resources'] });
  });

  it('keeps held news for the listener that replaces one unsubscribed before it could take it', async () => {
    // StrictMode's setup, cleanup, setup in one synchronous pass.
    const inbox = createWorkspaceSyncRelayInbox();
    inbox.receive({ type: 'topics', region, workspaceId, waterline: 2, topics: ['member_directory'] });
    const first = vi.fn();
    const unsubscribe = inbox.subscribe(first);
    unsubscribe();
    const replacement = vi.fn();
    inbox.subscribe(replacement);
    await Promise.resolve();
    await Promise.resolve();
    expect(first).not.toHaveBeenCalled();
    expect(replacement).toHaveBeenCalledTimes(1);
    expect(replacement).toHaveBeenCalledWith({ type: 'topics', region, workspaceId, waterline: 2, topics: ['member_directory'] });
  });

  it('drops held news about an Organization the session has left, telling regions apart', async () => {
    const inbox = createWorkspaceSyncRelayInbox();
    inbox.receive({ type: 'topics', region, workspaceId: otherWorkspaceId, waterline: 9, topics: ['resources'] });
    // The same UUID in another region is another Organization.
    inbox.receive({ type: 'topics', region: 'enterprise', workspaceId, waterline: 8, topics: ['automations'] });
    inbox.receive({ type: 'topics', region, workspaceId, waterline: 2, topics: ['member_directory'] });
    const listener = vi.fn();
    inbox.subscribe(listener);
    await Promise.resolve();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({ type: 'topics', region, workspaceId, waterline: 2, topics: ['member_directory'] });
  });
});
