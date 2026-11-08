import { WORKSPACE_SYNC_TOPICS } from '@rally/contracts';
import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceSyncRelayEvent } from '../common/workspace-sync-relay';
import { WorkspaceSyncRelay } from './workspace-sync-relay';

const workspaceId = '00000000-0000-7000-8000-000000000001';
const otherWorkspaceId = '00000000-0000-7000-8000-000000000009';
const region = 'global';

function relay(): { relay: WorkspaceSyncRelay; delivered: WorkspaceSyncRelayEvent[] } {
  const delivered: WorkspaceSyncRelayEvent[] = [];
  return { relay: new WorkspaceSyncRelay((event) => delivered.push(event)), delivered };
}

describe('WorkspaceSyncRelay', () => {
  it('starts with nobody publishing', () => {
    expect(relay().relay.snapshot()).toEqual({ revision: 0, source: null });
  });

  it('attaches the publisher on its state and relays its news, every topic the contract names and the usage meter', () => {
    const { relay: subject, delivered } = relay();
    subject.publish({ type: 'state', region, workspaceId, state: 'connecting' });
    subject.publish({ type: 'state', region, workspaceId, state: 'connected' });
    // Unchanged: not an event, and not a new revision.
    subject.publish({ type: 'state', region, workspaceId, state: 'connected' });
    subject.publish({ type: 'topics', region, workspaceId, waterline: 4, topics: [...WORKSPACE_SYNC_TOPICS] });
    subject.publish({ type: 'topics', region, workspaceId, waterline: 4, topics: ['usage'] });
    expect(delivered).toEqual([
      { type: 'source', revision: 1, source: { region, workspaceId, state: 'connecting' } },
      { type: 'source', revision: 2, source: { region, workspaceId, state: 'connected' } },
      { type: 'topics', region, workspaceId, waterline: 4, topics: [...WORKSPACE_SYNC_TOPICS] },
      { type: 'topics', region, workspaceId, waterline: 4, topics: ['usage'] },
    ]);
    expect(subject.snapshot()).toEqual({ revision: 2, source: { region, workspaceId, state: 'connected' } });
  });

  it('relays nothing about an Organization nobody is attached for, the same UUID in another region included', () => {
    const { relay: subject, delivered } = relay();
    subject.publish({ type: 'topics', region, workspaceId, waterline: 4, topics: ['member_directory'] });
    subject.publish({ type: 'state', region, workspaceId, state: 'connected' });
    subject.publish({ type: 'topics', region, workspaceId: otherWorkspaceId, waterline: 4, topics: ['automations'] });
    subject.publish({ type: 'topics', region: 'enterprise', workspaceId, waterline: 4, topics: ['automations'] });
    expect(delivered).toEqual([{ type: 'source', revision: 1, source: { region, workspaceId, state: 'connected' } }]);
  });

  it('hands over between the same UUID in two regions as a change of source', () => {
    const { relay: subject, delivered } = relay();
    subject.publish({ type: 'state', region, workspaceId, state: 'connected' });
    subject.publish({ type: 'state', region: 'enterprise', workspaceId, state: 'connected' });
    // The first region's late detach is stale: it does not end the second's.
    subject.publish({ type: 'detach', region, workspaceId });
    subject.publish({ type: 'topics', region: 'enterprise', workspaceId, waterline: 2, topics: ['automations'] });
    expect(delivered).toEqual([
      { type: 'source', revision: 1, source: { region, workspaceId, state: 'connected' } },
      { type: 'source', revision: 2, source: { region: 'enterprise', workspaceId, state: 'connected' } },
      { type: 'topics', region: 'enterprise', workspaceId, waterline: 2, topics: ['automations'] },
    ]);
  });

  it('ends the source on its own detach, and on release, once', () => {
    const { relay: subject, delivered } = relay();
    subject.publish({ type: 'state', region, workspaceId, state: 'connected' });
    subject.publish({ type: 'detach', region, workspaceId });
    expect(subject.snapshot()).toEqual({ revision: 2, source: null });
    subject.publish({ type: 'detach', region, workspaceId });
    subject.publish({ type: 'state', region, workspaceId, state: 'connected' });
    subject.release();
    subject.release();
    expect(delivered).toEqual([
      { type: 'source', revision: 1, source: { region, workspaceId, state: 'connected' } },
      { type: 'source', revision: 2, source: null },
      { type: 'source', revision: 3, source: { region, workspaceId, state: 'connected' } },
      { type: 'source', revision: 4, source: null },
    ]);
  });

  it('refuses a malformed or open publication, naming the field, and delivers nothing', () => {
    const deliver = vi.fn();
    const subject = new WorkspaceSyncRelay(deliver);
    expect(() => subject.publish({ type: 'state', region, workspaceId, state: 'open' }))
      .toThrow('workspace_sync_publication_invalid:state:invalid_value');
    expect(() => subject.publish({ type: 'state', workspaceId, state: 'connected' }))
      .toThrow('workspace_sync_publication_invalid:region:');
    expect(() => subject.publish({ type: 'state', region, workspaceId: 'nope', state: 'connected' }))
      .toThrow('workspace_sync_publication_invalid:workspaceId:');
    expect(() => subject.publish({ type: 'topics', region, workspaceId, waterline: 1, topics: ['secrets'] }))
      .toThrow('workspace_sync_publication_invalid:topics.0:');
    expect(() => subject.publish({ type: 'topics', region, workspaceId, waterline: -1, topics: ['automations'] }))
      .toThrow('workspace_sync_publication_invalid:waterline:');
    expect(() => subject.publish({ type: 'topics', region, workspaceId, waterline: 1, topics: [] }))
      .toThrow('workspace_sync_publication_invalid:topics:');
    // Closed: a field the relay does not carry is refused, not dropped.
    expect(() => subject.publish({ type: 'state', region, workspaceId, state: 'connected', url: 'wss://x' }))
      .toThrow('workspace_sync_publication_invalid:-root-:unrecognized_keys');
    expect(() => subject.publish({ type: 'feature_flags', region, workspaceId, flags: {} }))
      .toThrow('workspace_sync_publication_invalid:type:');
    expect(deliver).not.toHaveBeenCalled();
  });
});
