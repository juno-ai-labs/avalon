import { describe, expect, it } from 'vitest';
import type { WorkstreamDetail, WorkstreamSummary } from '../lib/types';
import { openWorkstreamId, staleHarnessStatusWorkstreamId } from './app-shell';

const workstreamId = '00000000-0000-7000-8000-000000000001';

function summary(harnessStatus: WorkstreamSummary['harnessStatus']): WorkstreamSummary {
  return {
    id: workstreamId,
    title: 'Draft the reply',
    origin: 'ad_hoc',
    scope: 'workspace',
    harnessStatus,
    latestAttentionSequenceNumber: 0,
    readThroughSequenceNumber: 0,
    manualUnreadFromSequenceNumber: null,
    manualUnreadGeneration: 0,
    hasUnread: false,
    firstUnreadSequenceNumber: null,
    lastActivityAt: '2026-08-11T10:00:00.000Z',
  };
}

function detail(
  harnessStatus: WorkstreamDetail['harnessStatus'],
  dataUpdatedAt: number,
): { data?: WorkstreamDetail; dataUpdatedAt: number } {
  return { data: { id: workstreamId, harnessStatus } as WorkstreamDetail, dataUpdatedAt };
}

describe('openWorkstreamId', () => {
  it('names the work stream the route has open', () => {
    expect(openWorkstreamId(`/workstreams/${workstreamId}`)).toBe(workstreamId);
  });

  it('decodes an escaped segment, and survives a malformed one', () => {
    expect(openWorkstreamId('/workstreams/a%20b')).toBe('a b');
    expect(() => openWorkstreamId('/workstreams/%')).not.toThrow();
    expect(openWorkstreamId('/workstreams/%')).toBe('%');
  });

  it('has none for the composer, other screens, or a nested route', () => {
    expect(openWorkstreamId('/workstreams/new')).toBeNull();
    expect(openWorkstreamId('/automations/abc')).toBeNull();
    expect(openWorkstreamId(`/workstreams/${workstreamId}/settings`)).toBeNull();
  });
});

describe('staleHarnessStatusWorkstreamId', () => {
  it('catches a detail left behind by a status the poll already has', () => {
    expect(staleHarnessStatusWorkstreamId(
      workstreamId,
      [summary('needs_input')],
      2_000,
      detail('running', 1_000),
    )).toBe(workstreamId);
  });

  it('leaves a detail written after the poll alone, so a push is not undone', () => {
    expect(staleHarnessStatusWorkstreamId(
      workstreamId,
      [summary('needs_input')],
      1_000,
      detail('running', 2_000),
    )).toBeNull();
  });

  it('stays quiet while the two agree', () => {
    expect(staleHarnessStatusWorkstreamId(
      workstreamId,
      [summary('running')],
      2_000,
      detail('running', 1_000),
    )).toBeNull();
  });

  it('stays quiet with no work stream open, no list yet, or no detail yet', () => {
    expect(staleHarnessStatusWorkstreamId(null, [summary('needs_input')], 2_000, detail('running', 1_000))).toBeNull();
    expect(staleHarnessStatusWorkstreamId(workstreamId, undefined, 2_000, detail('running', 1_000))).toBeNull();
    expect(staleHarnessStatusWorkstreamId(workstreamId, [summary('needs_input')], 2_000, undefined)).toBeNull();
    expect(staleHarnessStatusWorkstreamId(workstreamId, [], 2_000, detail('running', 1_000))).toBeNull();
  });
});
