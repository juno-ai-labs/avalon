import { describe, expect, it } from 'vitest';
import { asSpaceId, type SpaceSummary } from '@rally/contracts';

import { mergeAudience, mergeLabel, mergeTargetFor } from './conversation-surface';

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
    ], threadPrivate: false });
    expect(mergeLabel(target!)).toBe('Merge to GTM');
  });

  it('reads the directory’s placements over a detail that carries none', () => {
    expect(mergeTargetFor({
      parentKind: 'workstream', substreamId: '0', guest: false, thread: { ...thread, spaceIds: [] },
      placements: [BOARD], spaces: [space(GTM, 'GTM', 'organization'), space(BOARD, 'Board', 'participant')],
    })).toEqual({ kind: 'channel', channels: [{ id: BOARD, name: 'Board', scope: 'workspace' }], threadPrivate: false });
  });

  it('leads with the server’s default, earliest placement first, once it has read it', () => {
    const target = mergeTargetFor({
      parentKind: 'workstream', substreamId: '0', guest: false, thread, eligible: [BOARD, GTM],
      spaces: [space(GTM, 'GTM', 'organization'), space(BOARD, 'Board', 'participant')],
    });
    expect(target).toEqual({ kind: 'channel', channels: [
      { id: BOARD, name: 'Board', scope: 'workspace' },
      { id: GTM, name: 'GTM', scope: 'workspace' },
    ], threadPrivate: false });
    expect(mergeLabel(target!)).toBe('Merge to Board');
  });

  it('offers a private thread its Channels too, marked private', () => {
    expect(mergeTargetFor({
      parentKind: 'workstream', substreamId: '0', guest: false, thread: { ...thread, scope: 'personal' },
      spaces: [space(GTM, 'GTM', 'organization')],
    })).toEqual({ kind: 'channel', channels: [{ id: GTM, name: 'GTM', scope: 'workspace' }], threadPrivate: true });
  });

  it('offers Merge to GTM from the server when a private Thread has no cached placements', () => {
    const target = mergeTargetFor({
      parentKind: 'workstream', substreamId: '0', guest: false,
      thread: { title: 'Private thread', scope: 'personal', spaceIds: [] },
      placements: [], eligible: [GTM], spaces: [space(GTM, 'GTM', 'organization')],
    });
    expect(target).toEqual({ kind: 'channel', channels: [
      { id: GTM, name: 'GTM', scope: 'workspace' },
    ], threadPrivate: true });
    expect(mergeLabel(target!)).toBe('Merge to GTM');
  });

  it('drops stale cached targets when the server lists different eligible Channels or none', () => {
    const input: MergeInput = {
      parentKind: 'workstream', substreamId: '0', guest: false, thread,
      placements: [GTM], spaces: [space(GTM, 'GTM', 'organization'), space(BOARD, 'Board', 'participant')],
    };
    expect(mergeTargetFor({ ...input, eligible: [BOARD] })).toEqual({
      kind: 'channel', channels: [{ id: BOARD, name: 'Board', scope: 'workspace' }], threadPrivate: false,
    });
    expect(mergeTargetFor({ ...input, eligible: [] })).toBeNull();
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

describe('who a merge reaches, as the composer says it', () => {
  it('counts a thread’s people and names what it embeds', () => {
    const thread = { kind: 'thread', threadTitle: 'Cold Outreach' } as const;
    expect(mergeAudience(thread, null, 6, ['Sequence B'])).toBe('The 6 people in Cold Outreach will see this and can open Sequence B.');
    expect(mergeAudience(thread, null, 1, [])).toBe('The 1 person in Cold Outreach will see this.');
    expect(mergeAudience(thread, null, null, ['A', 'B', 'C'])).toBe('Everyone in Cold Outreach will see this and can open 3 artifacts.');
  });

  it('shares a Channel merge’s artifacts with the Channel’s readers, private Channel or not', () => {
    const target: Parameters<typeof mergeAudience>[0] = { kind: 'channel', channels: [], threadPrivate: false };
    expect(mergeAudience(target, { name: 'GTM', scope: 'workspace' }, null, ['Deck', 'Model']))
      .toBe('Everyone in GTM will see this and can open Deck and Model.');
    expect(mergeAudience(target, { name: 'Board', scope: 'personal' }, null, ['Deck']))
      .toBe('People in Board will see this and can open Deck.');
  });

  it('says a private thread’s name stays hidden, and its artifacts go to the Channel', () => {
    const target: Parameters<typeof mergeAudience>[0] = { kind: 'channel', channels: [], threadPrivate: true };
    expect(mergeAudience(target, { name: 'Sales', scope: 'workspace' }, null, ['Discount policy v2']))
      .toBe('Everyone in Sales will see this and can open Discount policy v2, but not the thread’s name.');
    expect(mergeAudience(target, { name: 'Board', scope: 'personal' }, null, []))
      .toBe('People in Board will see this, but not the thread’s name.');
  });
});
