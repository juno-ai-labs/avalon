import { describe, expect, it, vi } from 'vitest';
import { artifactPinActions, combineResourceActions } from './artifact-pin-actions';

const artifact = { id: 'summary', direction: 'artifact' as const };
const source = { id: 'brief', direction: 'source' as const };

describe('artifactPinActions', () => {
  it('pins an artifact the thread\'s Main holds, under that thread', () => {
    const setPinned = vi.fn();
    const actions = artifactPinActions({ pinnedIds: new Set(), setPinned, threadId: 'launch', threadResources: [artifact, source] })('summary');
    expect(actions?.map((action) => [action.label, action.icon])).toEqual([['Pin', 'pin']]);
    actions![0]!.onSelect();
    expect(setPinned).toHaveBeenCalledWith('summary', true, 'launch');
  });

  it('unpins one already pinned', () => {
    const setPinned = vi.fn();
    const actions = artifactPinActions({ pinnedIds: new Set(['summary']), setPinned, threadId: 'launch', threadResources: [artifact] })('summary');
    expect(actions?.map((action) => action.label)).toEqual(['Unpin']);
    actions![0]!.onSelect();
    expect(setPinned).toHaveBeenCalledWith('summary', false, 'launch');
  });

  it('offers nothing for a source or a resource Main does not hold', () => {
    const actions = artifactPinActions({ pinnedIds: new Set(), setPinned: vi.fn(), threadId: 'launch', threadResources: [source] });
    expect(actions('brief')).toBeUndefined();
    expect(actions('elsewhere')).toBeUndefined();
  });
});

describe('combineResourceActions', () => {
  it('lists every host\'s actions in order, and none when no host offers any', () => {
    const attach = { id: 'attach', label: 'Attach to thread', onSelect: vi.fn() };
    const pin = { id: 'pin', label: 'Pin', onSelect: vi.fn() };
    const combined = combineResourceActions((id) => (id === 'a' ? [attach] : undefined), undefined, () => [pin])!;
    expect(combined('a')?.map((action) => action.id)).toEqual(['attach', 'pin']);
    expect(combined('b')?.map((action) => action.id)).toEqual(['pin']);
    expect(combineResourceActions(undefined, undefined)).toBeUndefined();
    expect(combineResourceActions(() => undefined, () => [])!('a')).toBeUndefined();
  });
});
