import type { SharedNavigationDirectory } from '@rally/contracts/scope-grants';
import type { SubstreamId } from '@rally/contracts';
import { describe, expect, it } from 'vitest';
import { mainReachable } from './conversation-directory';

const channel = '00000000-0000-7000-8000-0000000000a1';
const breakoutOnly: SharedNavigationDirectory = {
  spaces: [],
  workstreams: [{
    parentId: channel, title: 'Launch', scope: 'personal', archived: false,
    conversations: [{ substreamId: '00000000-0000-7000-8000-0000000000a2' as SubstreamId, title: 'Pricing', scope: 'personal', archived: false }],
  }],
};

describe('mainReachable', () => {
  it('says no when the row or the conversation directory withholds Main', () => {
    expect(mainReachable({ mainWithheld: true }, undefined, channel)).toBe(false);
    expect(mainReachable(undefined, breakoutOnly, channel)).toBe(false);
  });

  it('says yes once either has spoken without withholding it, and does not know before', () => {
    expect(mainReachable({}, undefined, channel)).toBe(true);
    expect(mainReachable(undefined, { spaces: [], workstreams: [] }, channel)).toBe(true);
    expect(mainReachable(undefined, undefined, channel)).toBeUndefined();
  });
});
