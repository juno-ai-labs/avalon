import { describe, expect, it } from 'vitest';
import { asSpaceId, type SpaceSummary } from '@rally/contracts';

import { mergeLabel, mergeTargetFor } from './conversation-surface';

type MergeInput = Parameters<typeof mergeTargetFor>[0];
const GTM = '00000000-0000-7000-8000-0000000000a1';
const PRICING = '00000000-0000-7000-8000-0000000000a2';
const BOARD = '00000000-0000-7000-8000-0000000000a3';
const thread = {
  title: 'Launch', scope: 'workspace', spaceIds: [asSpaceId(GTM), asSpaceId(PRICING), asSpaceId(BOARD)],
} satisfies NonNullable<MergeInput['thread']>;
const space = (id: string, name: string, reach: SpaceSummary['reach']) =>
  ({ id: asSpaceId(id), name, scope: 'workspace', reach }) satisfies MergeInput['spaces'][number];

describe('where a conversation merges', () => {
  it('offers a Thread only the Channels its reader can post in, the first as the label', () => {
    const target = mergeTargetFor({
      parentKind: 'workstream', substreamId: '0', guest: false, thread,
      spaces: [space(GTM, 'GTM', 'organization'), space(PRICING, 'Pricing', 'through_channel'), space(BOARD, 'Board', 'participant')],
    });
    expect(target).toEqual({ kind: 'channel', channels: [
      { id: GTM, name: 'GTM', scope: 'workspace' },
      { id: BOARD, name: 'Board', scope: 'workspace' },
    ] });
    expect(mergeLabel(target!)).toBe('Merge to GTM');
  });

  it('reads the directory’s placements over a detail that carries none', () => {
    expect(mergeTargetFor({
      parentKind: 'workstream', substreamId: '0', guest: false, thread: { ...thread, spaceIds: [] },
      placements: [BOARD], spaces: [space(GTM, 'GTM', 'organization'), space(BOARD, 'Board', 'participant')],
    })).toEqual({ kind: 'channel', channels: [{ id: BOARD, name: 'Board', scope: 'workspace' }] });
  });

  it('offers nothing when every Channel is read-only to the reader, and a Breakout its Thread', () => {
    expect(mergeTargetFor({
      parentKind: 'workstream', substreamId: '0', guest: false, thread,
      spaces: [space(PRICING, 'Pricing', 'through_channel')],
    })).toBeNull();
    expect(mergeTargetFor({ parentKind: 'workstream', substreamId: 'b1', guest: true, thread, spaces: [] }))
      .toEqual({ kind: 'thread', threadTitle: 'Launch' });
  });
});
