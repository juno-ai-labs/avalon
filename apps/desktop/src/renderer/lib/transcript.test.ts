import { describe, expect, it } from 'vitest';
import type { WorkstreamTranscriptSnapshot } from '@rally/contracts';
import type { Message } from './types';
import {
  createElicitationMessage,
  adjacentTranscriptRange,
  createTextMessage,
  createToolEventMessage,
  orderedTranscriptMessages,
  mergeRealtimeTranscriptActivity,
  mergeRealtimeTranscriptTurn,
  mergeTranscriptRange,
  transcriptCoverage,
  transcriptGaps,
  transientMessagesWithoutCanonicalMatch,
  removeTranscriptMessage,
  upsertTranscriptMessage,
} from './transcript';

const base = {
  id: 'message-one',
  workstreamId: 'workstream-one',
  sequenceNumber: 1,
  authorType: 'agent' as const,
  createdAt: '2026-08-05T12:00:00.000Z',
};

describe('transcript messages', () => {
  it('creates text, tool, and elicitation messages from the same base shape', () => {
    expect(createTextMessage({ ...base, text: 'Hello' })).toMatchObject({ messageType: 'text', text: 'Hello' });
    expect(createToolEventMessage({
      ...base,
      toolEvent: { id: 'tool-one', name: 'Search', status: 'started' },
    })).toMatchObject({ messageType: 'tool_event', toolEvent: { id: 'tool-one' } });
    expect(createElicitationMessage({
      ...base,
      elicitation: { id: 'question-one', prompt: 'Choose', responseType: 'single_select', status: 'open' },
    })).toMatchObject({ messageType: 'elicitation', elicitation: { id: 'question-one' } });
  });

  it('replaces logical client and persisted messages without moving their transcript position', () => {
    const optimistic = createTextMessage({
      ...base,
      id: 'client-one',
      clientMessageId: 'client-one',
      authorType: 'human',
      text: 'Hello',
    });
    const trailing = createTextMessage({ ...base, id: 'message-two', sequenceNumber: 2, text: 'After' });
    const persisted: Message = { ...optimistic, id: 'persisted-one', deliveryState: undefined };

    expect(upsertTranscriptMessage([optimistic, trailing], persisted)).toEqual([persisted, trailing]);
    expect(removeTranscriptMessage([persisted, trailing], persisted.id)).toEqual([trailing]);
  });
});

describe('ordered turn rendering', () => {
  it('keeps a routed opening turn until its canonical ordered turn exists', () => {
    const routed = createTextMessage({
      ...base,
      id: 'persisted-opening',
      clientMessageId: 'client-opening',
      authorType: 'human',
      author: { id: 'user-adam', name: 'Adam', email: 'adam@example.com', timezone: 'UTC' },
      text: 'Start this work stream',
    });

    expect(transientMessagesWithoutCanonicalMatch([], [routed])).toEqual([routed]);

    const canonical = createTextMessage({
      ...routed,
      id: 'persisted-opening:text:0',
      transcriptTurnId: 'persisted-opening',
      text: routed.text ?? '',
    });
    expect(transientMessagesWithoutCanonicalMatch([canonical], [routed])).toEqual([]);
  });

  it('orders and collapses an open elicitation with its durable answer', () => {
    const elicitation = {
      id: '00000000-0000-7000-8000-000000000111',
      workstreamId: '00000000-0000-7000-8000-000000000112',
      harnessRunId: '00000000-0000-7000-8000-000000000113',
      prompt: 'Choose', responseType: 'single_select' as const,
      options: [{ label: 'One', value: 'one', description: null }], minimumSelections: 1,
      maximumSelections: 1, targetUserId: null, createdAt: '2026-08-26T12:00:01.000Z',
    };
    const turn = (
      transcriptSequence: number,
      turnId: string,
      status: 'open' | 'answered',
      actor: 'assistant' | 'human',
    ) => ({
      transcriptSequence, turnId, entryKind: 'conversation' as const, actor,
      authorUserId: actor === 'human' ? 'user-adam' : null,
      clientMessageId: `${status}:${turnId}`, externalActor: null,
      attentionOrdinal: transcriptSequence,
      createdAtUtc: `2026-08-26T12:00:0${transcriptSequence}.000Z`, revision: 1,
      blocks: [{
        type: 'text' as const, blockId: `${turnId}:text:0`, blockIndex: 0,
        text: '', streaming: false, messageType: 'elicitation' as const,
        structuredContent: {
          elicitation: {
            ...elicitation,
            status,
            answer: status === 'answered' ? 'one' : null,
            answeredByUserId: status === 'answered'
              ? '00000000-0000-7000-8000-000000000114'
              : null,
            answeredAt: status === 'answered' ? '2026-08-26T12:00:03.000Z' : null,
          },
        },
      }],
      activityId: null, turnManifestRef: null, manifestByteLength: null, manifestSha256: null,
    });
    const snapshot: WorkstreamTranscriptSnapshot = {
      snapshotId: 'snapshot-elicitations', snapshotThrough: 3, eventSequence: 3,
      snapshotAtUtc: '2026-08-26T12:00:04.000Z', unreadAnchorSequence: null,
      unreadReason: 'no_unread',
      ranges: [{
        purpose: 'latest', requested: { startInclusive: 1, endExclusive: 4 },
        covered: { startInclusive: 1, endExclusive: 4 },
        turns: [
          {
            transcriptSequence: 1, turnId: 'opening', entryKind: 'conversation', actor: 'human',
            authorUserId: 'user-adam', attentionOrdinal: 1,
            createdAtUtc: '2026-08-26T12:00:01.000Z', revision: 1,
            blocks: [{ type: 'text', blockId: 'opening:text:0', blockIndex: 0, text: 'Start', streaming: false }],
            activityId: null, turnManifestRef: null, manifestByteLength: null, manifestSha256: null,
          },
          turn(2, 'question-open', 'open', 'assistant'),
          turn(3, 'question-answer', 'answered', 'human'),
        ],
        activities: [],
      }],
      activities: [], activeActivities: [], activeTurns: [],
    };

    const messages = orderedTranscriptMessages(snapshot, 'workstream-one', [{
      id: 'user-adam', name: 'Adam', email: 'adam@example.com', timezone: 'UTC',
    }]);
    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({
      id: 'elicitation-00000000-0000-7000-8000-000000000111',
      authorType: 'human',
      elicitation: { id: '00000000-0000-7000-8000-000000000111', status: 'answered', answer: 'one' },
    });
  });

  it('retains the posting member and mention identities from canonical transcript turns', () => {
    const snapshot: WorkstreamTranscriptSnapshot = {
      snapshotId: 'snapshot-identity', snapshotThrough: 1, eventSequence: 1,
      snapshotAtUtc: '2026-08-26T12:00:10.000Z', unreadAnchorSequence: null,
      unreadReason: 'no_unread',
      ranges: [{
        purpose: 'latest', requested: { startInclusive: 1, endExclusive: 2 },
        covered: { startInclusive: 1, endExclusive: 2 },
        turns: [{
          transcriptSequence: 1, turnId: 'turn-human', entryKind: 'conversation',
          actor: 'human', authorUserId: 'user-alex', attentionOrdinal: 1,
          clientMessageId: 'client-human', externalActor: null,
          createdAtUtc: '2026-08-26T12:00:01.000Z', revision: 1,
          blocks: [{
            type: 'text', blockId: 'text-human', blockIndex: 0,
            text: 'Ask [@Morgan](person:user-morgan)', streaming: false,
            messageType: 'text', structuredContent: null,
            mentions: [{
              type: 'person', userId: 'user-morgan', connectorType: null,
              startOffset: 4, endOffset: 41,
            }],
            attachments: [{
              id: '00000000-0000-7000-8000-000000000901',
              fileName: 'sonar.png', mimeType: 'image/png', sizeBytes: 1024,
              contentAvailable: true, createdAt: '2026-08-26T12:00:00.000Z',
            }],
          }],
          activityId: null, turnManifestRef: null, manifestByteLength: null,
          manifestSha256: null,
        }],
        activities: [],
      }],
      activities: [], activeActivities: [], activeTurns: [],
    };
    const members = [{
      id: 'user-alex', name: 'Alex', email: 'alex@example.com', timezone: 'UTC',
    }, {
      id: 'user-morgan', name: 'Morgan', email: 'morgan@example.com',
      avatarUrl: 'https://example.com/morgan.png', timezone: 'UTC',
    }];

    expect(orderedTranscriptMessages(snapshot, 'workstream-one', members)[0]).toMatchObject({
      author: members[0],
      clientMessageId: 'client-human',
      mentions: [{
        type: 'person', personId: 'user-morgan', displayName: 'Morgan',
        avatarUrl: 'https://example.com/morgan.png',
      }],
      attachments: [{
        id: '00000000-0000-7000-8000-000000000901',
        fileName: 'sonar.png', mimeType: 'image/png', sizeBytes: 1024,
        contentAvailable: true,
      }],
    });
  });

  it('retains an external participant identity from a canonical transcript turn', () => {
    const externalActor = {
      provider: 'slack', providerAccountId: 'workspace-slack', providerUserId: 'user-slack',
      displayName: 'Taylor', avatarUrl: 'https://example.com/taylor.png',
    };
    const snapshot: WorkstreamTranscriptSnapshot = {
      snapshotId: 'snapshot-external', snapshotThrough: 1, eventSequence: 1,
      snapshotAtUtc: '2026-08-26T12:00:10.000Z', unreadAnchorSequence: null,
      unreadReason: 'no_unread',
      ranges: [{
        purpose: 'latest', requested: { startInclusive: 1, endExclusive: 2 },
        covered: { startInclusive: 1, endExclusive: 2 },
        turns: [{
          transcriptSequence: 1, turnId: 'turn-external', entryKind: 'conversation',
          actor: 'external', authorUserId: null, clientMessageId: 'slack-event-1',
          externalActor, attentionOrdinal: 1, createdAtUtc: '2026-08-26T12:00:01.000Z',
          revision: 1, blocks: [{
            type: 'text', blockId: 'text-external', blockIndex: 0, text: 'From Slack',
            streaming: false, messageType: 'text', structuredContent: null,
          }],
          activityId: null, turnManifestRef: null, manifestByteLength: null,
          manifestSha256: null,
        }],
        activities: [],
      }],
      activities: [], activeActivities: [], activeTurns: [],
    };

    expect(orderedTranscriptMessages(snapshot, 'workstream-one')[0]).toMatchObject({
      authorType: 'external', clientMessageId: 'slack-event-1', externalActor,
      messageType: 'text', text: 'From Slack',
    });
  });

  it('renders text, parallel tools, and following text in model order', () => {
    const snapshot: WorkstreamTranscriptSnapshot = {
      snapshotId: 'snapshot-1',
      snapshotThrough: 2,
      eventSequence: 10,
      snapshotAtUtc: '2026-08-26T12:00:10.000Z',
      unreadAnchorSequence: null,
      unreadReason: 'no_unread',
      ranges: [{
        purpose: 'latest',
        requested: { startInclusive: 1, endExclusive: 3 },
        covered: { startInclusive: 1, endExclusive: 3 },
        turns: [
          {
            transcriptSequence: 1,
            turnId: 'turn-1',
            entryKind: 'conversation',
            actor: 'assistant',
            authorUserId: null,
            attentionOrdinal: null,
            createdAtUtc: '2026-08-26T12:00:01.000Z',
            revision: 3,
            blocks: [
              { type: 'text', blockId: 'text-a', blockIndex: 0, text: 'First', streaming: false },
              {
                type: 'tool', blockId: 'tool-a', blockIndex: 1, toolCallId: 'call-a',
                pluginId: 'github', toolName: 'Search A', callIndex: 0, status: 'completed',
                participantSafeInput: null, participantSafeResult: 'A', error: null, activityId: null,
              },
              {
                type: 'tool', blockId: 'tool-b', blockIndex: 2, toolCallId: 'call-b',
                pluginId: 'github', toolName: 'Search B', callIndex: 1, status: 'failed',
                participantSafeInput: null, participantSafeResult: null, error: 'failed', activityId: null,
              },
            ],
            activityId: null,
            turnManifestRef: null,
            manifestByteLength: null,
            manifestSha256: null,
          },
          {
            transcriptSequence: 2,
            turnId: 'turn-2',
            entryKind: 'conversation',
            actor: 'assistant',
            authorUserId: null,
            attentionOrdinal: null,
            createdAtUtc: '2026-08-26T12:00:03.000Z',
            revision: 1,
            blocks: [{ type: 'text', blockId: 'text-b', blockIndex: 0, text: 'Then', streaming: false }],
            activityId: null,
            turnManifestRef: null,
            manifestByteLength: null,
            manifestSha256: null,
          },
        ],
        activities: [],
      }],
      activities: [],
      activeActivities: [],
      activeTurns: [],
    };

    const canonical = orderedTranscriptMessages(snapshot, 'workstream-one');
    expect(canonical.map((message) => message.id)).toEqual(['text-a', 'tool-a', 'tool-b', 'text-b']);
    expect(canonical.map((message) => message.transcriptTurnId))
      .toEqual(['turn-1', 'turn-1', 'turn-1', 'turn-2']);
    expect(transientMessagesWithoutCanonicalMatch(canonical, [
      createTextMessage({
        ...base, id: 'turn-1', transcriptTurnId: 'turn-1', text: 'First', streaming: true,
        realtimeOrder: { anchorSequenceNumber: 3, eventSequence: 1, placement: 'at_anchor' },
      }),
      createToolEventMessage({
        ...base, id: 'live-tool-a', transcriptTurnId: 'turn-1',
        toolEvent: { id: 'invocation-a', toolCallId: 'call-a', name: 'Search A', status: 'completed' },
        realtimeOrder: { anchorSequenceNumber: 3, eventSequence: 2, placement: 'after_anchor' },
      }),
      createTextMessage({
        ...base, id: 'turn-3', transcriptTurnId: 'turn-3', text: 'Still live', streaming: true,
        realtimeOrder: { anchorSequenceNumber: 4, eventSequence: 3, placement: 'at_anchor' },
      }),
      createTextMessage({
        ...base, id: 'turn-4', transcriptTurnId: 'turn-4', text: 'Awaiting commit', streaming: false,
        realtimeOrder: { anchorSequenceNumber: 5, eventSequence: 4, placement: 'at_anchor' },
      }),
    ]).map((message) => message.id)).toEqual(['turn-3', 'turn-4']);
  });

  it('assigns collision-free render order without imposing a block count limit', () => {
    const blocks = Array.from({ length: 1_001 }, (_, blockIndex) => ({
      type: 'text' as const,
      blockId: `block-${blockIndex}`,
      blockIndex,
      text: String(blockIndex),
      streaming: false,
    }));
    const snapshot: WorkstreamTranscriptSnapshot = {
      snapshotId: 'snapshot-large-turn', snapshotThrough: 1, eventSequence: 1,
      snapshotAtUtc: '2026-08-26T12:00:10.000Z', unreadAnchorSequence: null,
      unreadReason: 'no_unread',
      ranges: [{
        purpose: 'latest', requested: { startInclusive: 1, endExclusive: 2 },
        covered: { startInclusive: 1, endExclusive: 2 },
        turns: [{
          transcriptSequence: 1, turnId: 'turn-large', entryKind: 'conversation',
          actor: 'assistant', authorUserId: null, attentionOrdinal: null,
          createdAtUtc: '2026-08-26T12:00:00.000Z', revision: 1, blocks,
          activityId: 'turn-large:activity', turnManifestRef: null,
          manifestByteLength: null, manifestSha256: null,
        }],
        activities: [],
      }],
      activities: [
        {
          activityId: 'run-large', parentActivityId: null, scope: 'response',
          subjectId: 'run-large', callIndex: null, label: 'Working', state: 'completed',
          intervals: [], revision: 2,
        },
        {
          activityId: 'turn-large:activity', parentActivityId: 'run-large', scope: 'assistant_turn',
          subjectId: 'turn-large', callIndex: 0, label: 'Assistant turn', state: 'completed',
          intervals: [], revision: 2,
        },
      ],
      activeActivities: [], activeTurns: [],
    };

    const messages = orderedTranscriptMessages(snapshot, 'workstream-one');
    expect(messages).toHaveLength(1_002);
    expect(new Set(messages.map((message) => message.sequenceNumber)).size).toBe(messages.length);
    expect(messages.slice(0, blocks.length).map((message) => message.id))
      .toEqual(blocks.map((block) => block.blockId));
    expect(messages.at(-1)?.id).toBe('run-large');
  });

  it('uses the server elapsed baseline and a local monotonic start for mid-stream opens', () => {
    const snapshot: WorkstreamTranscriptSnapshot = {
      snapshotId: 'snapshot-active',
      snapshotThrough: 1,
      eventSequence: 20,
      snapshotAtUtc: '2026-08-26T12:00:10.000Z',
      unreadAnchorSequence: null,
      unreadReason: 'no_unread',
      ranges: [{
        purpose: 'latest',
        requested: { startInclusive: 1, endExclusive: 2 },
        covered: { startInclusive: 1, endExclusive: 2 },
        turns: [{
          transcriptSequence: 1,
          turnId: 'turn-active',
          entryKind: 'conversation',
          actor: 'assistant',
          authorUserId: null,
          attentionOrdinal: null,
          createdAtUtc: '2026-08-26T12:00:00.000Z',
          revision: 1,
          blocks: [{ type: 'text', blockId: 'active-text', blockIndex: 0, text: 'Streaming', streaming: true }],
          activityId: 'turn-active:activity',
          turnManifestRef: null,
          manifestByteLength: null,
          manifestSha256: null,
        }],
        activities: [],
      }],
      activities: [
        {
          activityId: 'run-active',
          parentActivityId: null,
          scope: 'response',
          subjectId: 'run-active',
          callIndex: null,
          label: 'Working',
          state: 'active',
          intervals: [{
            intervalId: 'run-active:1',
            startedAtUtc: '2026-08-26T12:00:00.000Z',
            stoppedAtUtc: null,
            durationMs: null,
            elapsedMsAtSnapshot: 10_000,
            revision: 1,
          }],
          revision: 1,
        },
        {
          activityId: 'turn-active:activity',
          parentActivityId: 'run-active',
          scope: 'assistant_turn',
          subjectId: 'turn-active',
          callIndex: 1,
          label: 'Assistant turn',
          state: 'active',
          intervals: [],
          revision: 1,
        },
      ],
      activeActivities: [],
      activeTurns: [],
    };

    const timing = orderedTranscriptMessages(snapshot, 'workstream-one')
      .find((message) => message.id === 'run-active');
    expect(timing?.thoughtEvent).toMatchObject({
      status: 'started',
      durationMs: 10_000,
      activeVerb: 'working',
      completedVerb: 'worked',
      monotonicStartedAt: expect.any(Number),
    });
    const unrelated = mergeRealtimeTranscriptActivity(snapshot, {
      activityId: 'other', parentActivityId: null, scope: 'response',
      subjectId: 'other', callIndex: null, label: 'Worked', state: 'completed',
      intervals: [], revision: 1,
    }, 21, '2026-08-26T12:00:11.000Z');
    expect(orderedTranscriptMessages(unrelated, 'workstream-one')
      .find((message) => message.id === 'run-active')?.thoughtEvent?.monotonicStartedAt)
      .toBe(timing?.thoughtEvent?.monotonicStartedAt);
  });
});

describe('explicit transcript range coverage', () => {
  const snapshot = {
    snapshotId: 'snapshot-ranges',
    snapshotThrough: 50,
    eventSequence: 1,
    snapshotAtUtc: '2026-08-26T12:00:00.000Z',
    unreadAnchorSequence: null,
    unreadReason: 'no_unread',
    ranges: [
      { purpose: 'requested', requested: { startInclusive: 10, endExclusive: 20 }, covered: { startInclusive: 10, endExclusive: 20 }, turns: [], activities: [] },
      { purpose: 'requested', requested: { startInclusive: 15, endExclusive: 25 }, covered: { startInclusive: 15, endExclusive: 25 }, turns: [], activities: [] },
      { purpose: 'latest', requested: { startInclusive: 46, endExclusive: 51 }, covered: { startInclusive: 46, endExclusive: 51 }, turns: [], activities: [] },
    ],
    activities: [],
    activeActivities: [],
    activeTurns: [],
  } satisfies WorkstreamTranscriptSnapshot;

  it('unions overlap while retaining empty covered intervals and known gaps', () => {
    expect(transcriptCoverage(snapshot)).toEqual([
      { startInclusive: 10, endExclusive: 25 },
      { startInclusive: 46, endExclusive: 51 },
    ]);
    expect(transcriptGaps(snapshot)).toEqual([
      { startInclusive: 1, endExclusive: 10 },
      { startInclusive: 25, endExclusive: 46 },
    ]);
  });

  it('requests only one adjacent block while the latest island remains instantly available', () => {
    expect(adjacentTranscriptRange(snapshot, 'older')).toEqual({ startInclusive: 1, endExclusive: 10 });
    expect(adjacentTranscriptRange(snapshot, 'newer')).toEqual({ startInclusive: 25, endExclusive: 45 });
  });

  it('adds only a realtime singleton and does not fill an older gap', () => {
    const turn = {
      transcriptSequence: 51,
      turnId: 'turn-51',
      entryKind: 'conversation' as const,
      actor: 'assistant' as const,
      authorUserId: null,
      attentionOrdinal: null,
      createdAtUtc: '2026-08-26T12:00:01.000Z',
      revision: 1,
      blocks: [],
      activityId: null,
      turnManifestRef: null,
      manifestByteLength: null,
      manifestSha256: null,
    };
    const merged = mergeRealtimeTranscriptTurn(snapshot, turn, 2);
    expect(merged.snapshotThrough).toBe(50);
    expect(transcriptCoverage(merged)).toEqual([
      { startInclusive: 10, endExclusive: 25 },
      { startInclusive: 46, endExclusive: 52 },
    ]);
    expect(transcriptGaps(merged)).toEqual([
      { startInclusive: 1, endExclusive: 10 },
      { startInclusive: 25, endExclusive: 46 },
    ]);
  });

  it('rejects a stale activity revision and accepts a newer terminal duration', () => {
    const started = {
      activityId: 'activity-1', parentActivityId: null, scope: 'response' as const,
      subjectId: 'run-1', callIndex: null, label: 'Working', state: 'active' as const,
      intervals: [], revision: 2,
    };
    const active = mergeRealtimeTranscriptActivity(snapshot, started, 2, snapshot.snapshotAtUtc);
    expect(mergeRealtimeTranscriptActivity(
      active,
      { ...started, revision: 1 },
      3,
      snapshot.snapshotAtUtc,
    )).toBe(active);
    const completed = mergeRealtimeTranscriptActivity(
      active,
      { ...started, revision: 3, state: 'completed' },
      4,
      '2026-08-26T12:00:04.000Z',
    );
    expect(completed.activities[0]).toMatchObject({ revision: 3, state: 'completed' });
    expect(completed.activeActivities).toEqual([]);
  });

  it('merges lifecycle timing delivered with a lazily loaded range', () => {
    const activity = {
      activityId: 'historical-tool', parentActivityId: null, scope: 'tool_call' as const,
      subjectId: 'call-old', callIndex: 0, label: 'Search', state: 'completed' as const,
      intervals: [], revision: 2,
    };
    const merged = mergeTranscriptRange(snapshot, {
      purpose: 'requested',
      requested: { startInclusive: 1, endExclusive: 10 },
      covered: { startInclusive: 1, endExclusive: 10 },
      turns: [],
      activities: [activity],
    });
    expect(merged.activities).toContainEqual(activity);
  });

  it('satisfies range union and complement algebra for generated small intervals', () => {
    for (let leftStart = 1; leftStart <= 5; leftStart += 1) {
      for (let leftEnd = leftStart; leftEnd <= 6; leftEnd += 1) {
        for (let rightStart = 1; rightStart <= 5; rightStart += 1) {
          for (let rightEnd = rightStart; rightEnd <= 6; rightEnd += 1) {
            const ranges = [
              { purpose: 'requested' as const, requested: { startInclusive: leftStart, endExclusive: leftEnd }, covered: { startInclusive: leftStart, endExclusive: leftEnd }, turns: [], activities: [] },
              { purpose: 'requested' as const, requested: { startInclusive: rightStart, endExclusive: rightEnd }, covered: { startInclusive: rightStart, endExclusive: rightEnd }, turns: [], activities: [] },
            ];
            const generated = { ...snapshot, snapshotThrough: 5, ranges };
            const reversed = { ...generated, ranges: [...ranges].reverse() };
            expect(transcriptCoverage(generated)).toEqual(transcriptCoverage(reversed));
            for (let sequence = 1; sequence <= 5; sequence += 1) {
              const covered = transcriptCoverage(generated).some((range) =>
                sequence >= range.startInclusive && sequence < range.endExclusive);
              const gap = transcriptGaps(generated).some((range) =>
                sequence >= range.startInclusive && sequence < range.endExclusive);
              expect(Number(covered) + Number(gap)).toBe(1);
            }
          }
        }
      }
    }
  });
});
