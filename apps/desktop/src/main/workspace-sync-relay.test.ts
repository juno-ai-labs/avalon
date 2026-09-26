import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceSyncRelayEvent } from '../common/workspace-sync-relay';
import { WorkspaceSyncRelay } from './workspace-sync-relay';

const workspaceId = '00000000-0000-7000-8000-000000000001';
const otherWorkspaceId = '00000000-0000-7000-8000-000000000009';

function relay(): { relay: WorkspaceSyncRelay; delivered: WorkspaceSyncRelayEvent[] } {
  const delivered: WorkspaceSyncRelayEvent[] = [];
  return { relay: new WorkspaceSyncRelay((event) => delivered.push(event)), delivered };
}

describe('WorkspaceSyncRelay', () => {
  it('starts with nobody publishing', () => {
    expect(relay().relay.snapshot()).toEqual({ revision: 0, source: null });
  });

  it('attaches the publisher on its state and relays its news', () => {
    const { relay: subject, delivered } = relay();
    subject.publish({ type: 'state', workspaceId, state: 'connecting' });
    subject.publish({ type: 'state', workspaceId, state: 'connected' });
    // Unchanged: not an event, and not a new revision.
    subject.publish({ type: 'state', workspaceId, state: 'connected' });
    subject.publish({ type: 'topics', workspaceId, waterline: 4, topics: ['member_directory'] });
    expect(delivered).toEqual([
      { type: 'source', revision: 1, source: { workspaceId, state: 'connecting' } },
      { type: 'source', revision: 2, source: { workspaceId, state: 'connected' } },
      { type: 'topics', workspaceId, waterline: 4, topics: ['member_directory'] },
    ]);
    expect(subject.snapshot()).toEqual({ revision: 2, source: { workspaceId, state: 'connected' } });
  });

  it('relays nothing about an Organization nobody is attached for', () => {
    const { relay: subject, delivered } = relay();
    subject.publish({ type: 'topics', workspaceId, waterline: 4, topics: ['member_directory'] });
    subject.publish({ type: 'state', workspaceId, state: 'connected' });
    subject.publish({ type: 'topics', workspaceId: otherWorkspaceId, waterline: 4, topics: ['notes'] });
    expect(delivered).toEqual([{ type: 'source', revision: 1, source: { workspaceId, state: 'connected' } }]);
  });

  it('tells the consumer when the publisher is gone, once', () => {
    const { relay: subject, delivered } = relay();
    subject.publish({ type: 'state', workspaceId, state: 'connected' });
    subject.release();
    subject.release();
    expect(delivered.at(-1)).toEqual({ type: 'source', revision: 2, source: null });
    expect(delivered).toHaveLength(2);
  });

  it('keeps the publisher across a token refresh and drops it when the session changes Organization', () => {
    const { relay: subject } = relay();
    subject.publish({ type: 'state', workspaceId, state: 'connected' });
    subject.releaseUnless(workspaceId);
    expect(subject.snapshot().source).toEqual({ workspaceId, state: 'connected' });
    subject.releaseUnless(otherWorkspaceId);
    expect(subject.snapshot()).toEqual({ revision: 2, source: null });
  });

  it('refuses a malformed publication, naming the field, and delivers nothing', () => {
    const deliver = vi.fn();
    const subject = new WorkspaceSyncRelay(deliver);
    expect(() => subject.publish({ type: 'state', workspaceId, state: 'open' }))
      .toThrow('Blocked workspace sync publication: invalid state');
    expect(() => subject.publish({ type: 'topics', workspaceId, waterline: 1, topics: ['secrets'] }))
      .toThrow('invalid topics');
    expect(deliver).not.toHaveBeenCalled();
  });
});
