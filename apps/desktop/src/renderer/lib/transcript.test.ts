import { describe, expect, it } from 'vitest';
import type { WorkstreamTranscriptSnapshot } from '@rally/contracts';
import type { Message } from './types';
import {
  foldSettledWorkIntoMessages,
  createElicitationMessage,
  adjacentTranscriptRange,
  createTextMessage,
  createToolEventMessage,
  orderedTranscriptMessages,
  composeTranscript,
  groupPluginToolMessages,
  mergeCanonicalTranscriptSnapshot,
  mergeRealtimeTranscriptActivity,
  mergeRealtimeTranscriptTurn,
  mergeTranscriptRange,
  transcriptCoverage,
  transcriptCoverageAdvanced,
  transcriptGaps,
  transcriptOverlaysWithoutCanonicalMatch,
  reconcileAuthoritativeTranscriptOverlays,
  upsertTranscriptOverlay,
  mapTranscriptOverlayMessages,
  setTranscriptElicitationState,
  upsertTranscriptMessage,
  applyPendingInputQueueOrder,
  assignPendingInputQueueSequences,
  composerQueueOverlays,
  isComposerQueueOverlay,
  pendingOverlayInputId,
  pendingTranscriptInputOverlay,
} from './transcript';

const base = {
  id: 'message-one',
  workstreamId: 'workstream-one',
  sequenceNumber: 1,
  authorType: 'agent' as const,
  createdAt: '2026-08-05T12:00:00.000Z',
};

describe('transcript messages', () => {
  it('keeps an oversized turn in sequence as a visible placeholder', () => {
    const envelope = {
      transcriptSequence: 1,
      turnId: 'turn-large',
      entryKind: 'conversation' as const,
      actor: 'assistant' as const,
      authorUserId: null,
      authorSnapshot: null,
      attentionOrdinal: null,
      createdAtUtc: '2026-08-05T12:00:00.000Z',
      revision: 2,
      blocks: [],
      blockCount: 1,
      activityId: null,
      blocksOmitted: true,
    };
    const snapshot = {
      snapshotId: 'snapshot-large',
      snapshotThrough: 1,
      eventSequence: 1,
      snapshotAtUtc: '2026-08-05T12:00:00.000Z',
      unreadAnchorSequence: null,
      unreadReason: 'no_unread' as const,
      ranges: [{
        purpose: 'latest' as const,
        requested: { startInclusive: 1, endExclusive: 2 },
        covered: { startInclusive: 1, endExclusive: 2 },
        turns: [envelope],
        activities: [],
        pluginRuns: [],
      }],
      activities: [],
      activeActivities: [],
      pluginRuns: [],
      activeTurns: [],
      pendingInputs: [],
    };
    expect(orderedTranscriptMessages(snapshot, 'workstream-one')).toEqual([
      expect.objectContaining({
        transcriptSequence: 1,
        text: 'This message is too large to display.',
        blocksOmittedPlaceholder: true,
      }),
    ]);
  });

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
  });
});

describe('canonical transcript and transient overlay composition', () => {
  const canonicalText = (id: string, transcriptSequence: number, createdAt: string): Message => createTextMessage({
    ...base,
    id,
    transcriptTurnId: id,
    transcriptSequence,
    createdAt,
    text: id,
  });
  const assistantOverlay = (turnId: string, afterTranscriptSequence: number, eventSequence: number, text: string) => ({
    identity: { type: 'assistant_turn' as const, turnId },
    provenance: { source: 'socket_event' as const, eventType: 'stream_delta', eventSequence },
    position: { afterTranscriptSequence, eventSequence },
    message: createTextMessage({
      ...base, id: turnId, transcriptTurnId: turnId, createdAt: '1999-01-01T00:00:00.000Z',
      streaming: true, text,
    }),
  });

  it('orders solely by canonical transcript position and explicit event position, never wall-clock time', () => {
    const first = canonicalText('canonical-1', 1, '2099-01-01T00:00:00.000Z');
    const second = canonicalText('canonical-2', 2, '2000-01-01T00:00:00.000Z');
    const overlay = assistantOverlay('live-between', 1, 90, 'live');

    expect(composeTranscript([first, second], [overlay]).map((message) => message.id))
      .toEqual(['canonical-1', 'live-between', 'canonical-2']);
  });

  it('refuses canonical input whose durable positions are not already ordered', () => {
    const first = canonicalText('canonical-1', 1, base.createdAt);
    const second = canonicalText('canonical-2', 2, base.createdAt);

    expect(() => composeTranscript([second, first], []))
      .toThrow('Rally received an invalid transcript order. Reopen this work stream.');
  });

  it('refuses a canonical row with no durable transcript position', () => {
    const unpositioned = createTextMessage({ ...base, id: 'unpositioned', text: 'Ambiguous' });

    expect(() => composeTranscript([unpositioned], []))
      .toThrow('Rally received an invalid transcript order. Reopen this work stream.');
  });

  it('preserves overlay and message identity when a reveal tick changes nothing', () => {
    const overlay = assistantOverlay('turn-live', 4, 10, 'complete');
    const overlays = [overlay];

    expect(mapTranscriptOverlayMessages(overlays, (messages) => messages)).toBe(overlays);
    expect(mapTranscriptOverlayMessages(overlays, (messages) => [...messages])).toBe(overlays);
  });

  it('keeps an overlay at its first observed position while content and provenance advance', () => {
    const first = assistantOverlay('turn-live', 4, 10, 'a');
    const later = assistantOverlay('turn-live', 99, 30, 'abc');
    const updated = upsertTranscriptOverlay([first], later);

    expect(updated).toMatchObject([{
      position: { afterTranscriptSequence: 4, eventSequence: 10 },
      provenance: { eventSequence: 30 },
      message: { text: 'abc' },
    }]);
  });

  it('reconciles by protocol identity and never by equal text or timestamps', () => {
    const canonical = canonicalText('canonical-unrelated', 3, base.createdAt);
    canonical.text = 'identical';
    const unrelated = assistantOverlay('different-turn', 3, 1, 'identical');
    expect(transcriptOverlaysWithoutCanonicalMatch([canonical], [unrelated])).toEqual([unrelated]);

    const matching = assistantOverlay('canonical-unrelated', 3, 2, 'different content');
    expect(transcriptOverlaysWithoutCanonicalMatch([canonical], [matching])).toEqual([]);
  });

  it('shows one live assistant block, then atomically yields to its final canonical block', () => {
    const streamingCanonical = canonicalText('turn-stream', 8, base.createdAt);
    streamingCanonical.streaming = true;
    streamingCanonical.text = 'server checkpoint';
    const overlay = assistantOverlay('turn-stream', 8, 11, 'smooth reveal');
    expect(composeTranscript([streamingCanonical], [overlay]).map((message) => message.text))
      .toEqual(['smooth reveal']);

    const finalCanonical = { ...streamingCanonical, streaming: false, text: 'final answer' };
    expect(composeTranscript([finalCanonical], [overlay]).map((message) => message.text))
      .toEqual(['final answer']);
  });

  it('removes abandoned partial text when the reserved turn becomes a durable error pill', () => {
    const overlay = assistantOverlay('turn-failed', 7, 11, 'partial provider bytes');
    const status = canonicalText('turn-failed', 8, base.createdAt);
    status.messageType = 'system';
    status.text = 'Response could not be completed';
    status.statusEvent = { kind: 'assistant_turn_failed', code: 'provider_failed' };

    expect(transcriptOverlaysWithoutCanonicalMatch([status], [overlay])).toEqual([]);
    expect(composeTranscript([status], [overlay])).toEqual([{ ...status, sequenceNumber: 1 }]);
  });

  it('lets a server-owned pending input replace the optimistic anchor without duplication', () => {
    const optimistic = {
      identity: { type: 'client_message' as const, clientMessageId: 'client-pending' },
      provenance: { source: 'client_command' as const, phase: 'accepted' as const },
      position: { afterTranscriptSequence: 9, eventSequence: 20 },
      message: createTextMessage({
        ...base, id: 'optimistic', clientMessageId: 'client-pending', authorType: 'human', text: 'pending',
      }),
    };
    const authoritative = {
      ...optimistic,
      identity: {
        type: 'client_message' as const,
        clientMessageId: 'client-pending',
        turnId: 'future-turn',
      },
      provenance: { source: 'socket_snapshot' as const, snapshotId: 'snapshot-2' },
      position: { afterTranscriptSequence: 4, eventSequence: 2 },
      message: { ...optimistic.message, id: 'future-turn', transcriptTurnId: 'future-turn' },
    };

    expect(reconcileAuthoritativeTranscriptOverlays([], [optimistic], [authoritative]))
      .toEqual([authoritative]);
  });

  it('reconciles each overlay kind only with its own canonical identity', () => {
    const client = createTextMessage({ ...base, id: 'client-row', clientMessageId: 'client-1', text: 'sent' });
    const tool = createToolEventMessage({
      ...base, id: 'tool-row', toolEvent: { id: 'tool-call-1', toolCallId: 'tool-call-1', name: 'Search', status: 'completed' },
    });
    const overlays = [
      {
        identity: { type: 'client_message' as const, clientMessageId: 'client-1' },
        provenance: { source: 'client_command' as const, phase: 'accepted' as const },
        position: { afterTranscriptSequence: 0, eventSequence: 1 }, message: client,
      },
      {
        identity: { type: 'tool_call' as const, toolCallId: 'tool-call-1' },
        provenance: { source: 'socket_event' as const, eventType: 'tool_event', eventSequence: 2 },
        position: { afterTranscriptSequence: 0, eventSequence: 2 }, message: tool,
      },
    ];
    expect(transcriptOverlaysWithoutCanonicalMatch([client], overlays).map((item) => item.identity.type))
      .toEqual(['tool_call']);
    expect(transcriptOverlaysWithoutCanonicalMatch([tool], overlays).map((item) => item.identity.type))
      .toEqual(['client_message']);
    expect(transcriptOverlaysWithoutCanonicalMatch([client, tool], overlays)).toEqual([]);
  });

  it('composes thousands of canonical blocks and overlays without losing or duplicating identities', () => {
    const canonical = Array.from({ length: 2_000 }, (_, index) =>
      canonicalText(`canonical-${index}`, index + 1, base.createdAt));
    const overlays = Array.from({ length: 200 }, (_, index) =>
      assistantOverlay(`live-${index}`, index * 10, index + 1, String(index)));
    const composed = composeTranscript(canonical, overlays);
    expect(composed).toHaveLength(2_200);
    expect(new Set(composed.map((message) => message.id)).size).toBe(2_200);
    expect(composed.map((message) => message.sequenceNumber))
      .toEqual(Array.from({ length: 2_200 }, (_, index) => index + 1));
  });

  it('linearly merges unsorted overlays before, between, beside, and after canonical islands', () => {
    const canonical = [
      canonicalText('canonical-2', 2, base.createdAt),
      canonicalText('canonical-8', 8, base.createdAt),
    ];
    const overlays = [
      assistantOverlay('after-tail', 9, 7, 'after'),
      assistantOverlay('same-anchor-later', 2, 5, 'later'),
      assistantOverlay('before-first', 0, 3, 'before'),
      assistantOverlay('same-anchor-first', 2, 4, 'first'),
      assistantOverlay('in-gap', 5, 6, 'gap'),
    ];

    expect(composeTranscript(canonical, overlays).map((message) => message.id)).toEqual([
      'before-first',
      'canonical-2',
      'same-anchor-first',
      'same-anchor-later',
      'in-gap',
      'canonical-8',
      'after-tail',
    ]);
  });
});

describe('ordered turn rendering', () => {
  it('keeps an optimistic opening turn until its canonical ordered turn exists', () => {
    const routed = createTextMessage({
      ...base,
      id: 'persisted-opening',
      clientMessageId: 'client-opening',
      authorType: 'human',
      author: { id: 'user-adam', name: 'Adam', email: 'adam@example.com', timezone: 'UTC' },
      text: 'Start this work stream',
      deliveryState: 'sending',
      realtimeOrder: { anchorSequenceNumber: 1, eventSequence: 1, placement: 'at_anchor' },
    });

    const overlay = {
      identity: { type: 'client_message' as const, clientMessageId: 'client-opening' },
      provenance: { source: 'client_command' as const, phase: 'sending' as const },
      position: { afterTranscriptSequence: 1, eventSequence: 1 },
      message: routed,
    };
    expect(composeTranscript([], [overlay])).toEqual([{ ...routed, sequenceNumber: 1 }]);

    const canonical = createTextMessage({
      ...routed,
      id: 'persisted-opening:text:0',
      transcriptTurnId: 'persisted-opening',
      text: routed.text ?? '',
    });
    expect(transcriptOverlaysWithoutCanonicalMatch([canonical], [overlay])).toEqual([]);
  });

  it('accepts only explicitly identified live overlays outside loaded ordered ranges', () => {
    const live = createTextMessage({
      ...base,
      id: 'turn-live',
      transcriptTurnId: 'turn-live',
      sequenceNumber: 21,
      text: 'Still streaming',
      streaming: true,
      realtimeOrder: { anchorSequenceNumber: 21, eventSequence: 7, placement: 'at_anchor' },
    });

    const overlay = {
      identity: { type: 'assistant_turn' as const, turnId: 'turn-live' },
      provenance: { source: 'socket_event' as const, eventType: 'stream_delta', eventSequence: 7 },
      position: { afterTranscriptSequence: 21, eventSequence: 7 },
      message: live,
    };
    expect(composeTranscript([], [overlay])).toEqual([{ ...live, sequenceNumber: 1 }]);
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
      authorSnapshot: actor === 'human'
        ? { userId: 'user-adam', displayName: 'Adam at posting time', avatarUrl: null }
        : null,
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
      activityId: null,    });
    const intervening = {
      transcriptSequence: 3, turnId: 'intervening', entryKind: 'conversation' as const,
      actor: 'assistant' as const, authorUserId: null, authorSnapshot: null,
      attentionOrdinal: 3, createdAtUtc: '2026-08-26T12:00:03.000Z', revision: 1,
      blocks: [{
        type: 'text' as const, blockId: 'intervening:text:0', blockIndex: 0,
        text: 'Work continued', streaming: false,
      }],
      activityId: null,    };
    const snapshot: WorkstreamTranscriptSnapshot = {
      snapshotId: 'snapshot-elicitations', snapshotThrough: 4, eventSequence: 4,
      snapshotAtUtc: '2026-08-26T12:00:04.000Z', unreadAnchorSequence: null,
      unreadReason: 'no_unread',
      ranges: [{
        purpose: 'latest', requested: { startInclusive: 1, endExclusive: 5 },
        covered: { startInclusive: 1, endExclusive: 5 },
        turns: [
          {
            transcriptSequence: 1, turnId: 'opening', entryKind: 'conversation', actor: 'human',
            authorUserId: 'user-adam',
            authorSnapshot: { userId: 'user-adam', displayName: 'Adam at posting time', avatarUrl: null },
            attentionOrdinal: 1,
            createdAtUtc: '2026-08-26T12:00:01.000Z', revision: 1,
            blocks: [{ type: 'text', blockId: 'opening:text:0', blockIndex: 0, text: 'Start', streaming: false }],
            activityId: null,          },
          turn(2, 'question-open', 'open', 'assistant'),
          intervening,
          turn(4, 'question-answer', 'answered', 'human'),
        ],
        activities: [],
        pluginRuns: [],
      }],
      activities: [], activeActivities: [], pluginRuns: [], activeTurns: [], pendingInputs: [],
    };

    const messages = orderedTranscriptMessages(snapshot, 'workstream-one', [{
      id: 'user-adam', name: 'Adam', email: 'adam@example.com', timezone: 'UTC',
    }]);
    expect(messages).toHaveLength(3);
    expect(messages[1]).toMatchObject({
      id: 'elicitation-00000000-0000-7000-8000-000000000111',
      authorType: 'human',
      transcriptSequence: 2,
      transcriptTurnId: 'question-open',
      elicitation: { id: '00000000-0000-7000-8000-000000000111', status: 'answered', answer: 'one' },
    });
    expect(messages[2]).toMatchObject({ transcriptSequence: 3, text: 'Work continued' });
    expect(() => composeTranscript(messages, [])).not.toThrow();
  });

  it('retains the immutable posting identity after the member leaves the work stream', () => {
    const snapshot: WorkstreamTranscriptSnapshot = {
      snapshotId: 'snapshot-identity', snapshotThrough: 1, eventSequence: 1,
      snapshotAtUtc: '2026-08-26T12:00:10.000Z', unreadAnchorSequence: null,
      unreadReason: 'no_unread',
      ranges: [{
        purpose: 'latest', requested: { startInclusive: 1, endExclusive: 2 },
        covered: { startInclusive: 1, endExclusive: 2 },
        turns: [{
          transcriptSequence: 1, turnId: 'turn-human', entryKind: 'conversation',
          actor: 'human', authorUserId: 'user-alex',
          authorSnapshot: {
            userId: 'user-alex', displayName: 'Alex at posting time',
            avatarUrl: 'https://example.com/alex-old.png',
          },
          attentionOrdinal: 1,
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
          activityId: null,        }],
        activities: [],
        pluginRuns: [],
      }],
      activities: [], activeActivities: [], pluginRuns: [], activeTurns: [], pendingInputs: [],
    };
    const members = [{
      id: 'user-morgan', name: 'Morgan', email: 'morgan@example.com',
      avatarUrl: 'https://example.com/morgan.png', timezone: 'UTC',
    }];

    expect(orderedTranscriptMessages(snapshot, 'workstream-one', members)[0]).toMatchObject({
      author: {
        id: 'user-alex', name: 'Alex at posting time',
        avatarUrl: 'https://example.com/alex-old.png',
      },
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

  it('fails closed instead of borrowing mutable membership for an invalid canonical human turn', () => {
    const invalid = {
      transcriptSequence: 1,
      turnId: 'invalid-human',
      entryKind: 'conversation' as const,
      actor: 'human' as const,
      authorUserId: 'user-alex',
      authorSnapshot: null,
      attentionOrdinal: 1,
      createdAtUtc: '2026-08-26T12:00:01.000Z',
      revision: 1,
      blocks: [{
        type: 'text' as const,
        blockId: 'invalid-human:text:0',
        blockIndex: 0,
        text: 'Invalid canonical row',
        streaming: false,
      }],
      activityId: null,
    };
    const snapshot: WorkstreamTranscriptSnapshot = {
      snapshotId: 'invalid-snapshot', snapshotThrough: 1, eventSequence: 1,
      snapshotAtUtc: '2026-08-26T12:00:02.000Z', unreadAnchorSequence: null,
      unreadReason: 'no_unread',
      ranges: [{
        purpose: 'latest', requested: { startInclusive: 1, endExclusive: 2 },
        covered: { startInclusive: 1, endExclusive: 2 },
        turns: [invalid], activities: [],
        pluginRuns: [],
      }],
      activities: [], activeActivities: [], pluginRuns: [], activeTurns: [], pendingInputs: [],
    };

    expect(() => orderedTranscriptMessages(snapshot, 'workstream-one', [{
      id: 'user-alex', name: 'Mutable Alex', email: 'alex@example.com', timezone: 'UTC',
    }])).toThrow('canonical_human_author_provenance_invalid');
  });

  it('preserves every canonical block when one submitted turn shares a client identity', () => {
    const snapshot: WorkstreamTranscriptSnapshot = {
      snapshotId: 'snapshot-multi-block', snapshotThrough: 1, eventSequence: 1,
      snapshotAtUtc: '2026-08-26T12:00:10.000Z', unreadAnchorSequence: null,
      unreadReason: 'no_unread',
      ranges: [{
        purpose: 'latest', requested: { startInclusive: 1, endExclusive: 2 },
        covered: { startInclusive: 1, endExclusive: 2 },
        turns: [{
          transcriptSequence: 1, turnId: 'turn-multi-block', entryKind: 'conversation',
          actor: 'human', authorUserId: 'user-alex',
          authorSnapshot: { userId: 'user-alex', displayName: 'Alex at posting time', avatarUrl: null },
          clientMessageId: 'one-submission',
          attentionOrdinal: 1, createdAtUtc: '2026-08-26T12:00:01.000Z', revision: 1,
          blocks: [
            { type: 'text', blockId: 'block-first', blockIndex: 0, text: 'First', streaming: false },
            { type: 'text', blockId: 'block-second', blockIndex: 1, text: 'Second', streaming: false },
          ],
          activityId: null,        }],
        activities: [],
        pluginRuns: [],
      }],
      activities: [], activeActivities: [], pluginRuns: [], activeTurns: [], pendingInputs: [],
    };

    const messages = orderedTranscriptMessages(snapshot, 'workstream-one');
    expect(messages.map((message) => [message.id, message.text, message.clientMessageId]))
      .toEqual([
        ['block-first', 'First', 'one-submission'],
        ['block-second', 'Second', 'one-submission'],
      ]);
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
          actor: 'external', authorUserId: null, authorSnapshot: null, clientMessageId: 'slack-event-1',
          externalActor, attentionOrdinal: 1, createdAtUtc: '2026-08-26T12:00:01.000Z',
          revision: 1, blocks: [{
            type: 'text', blockId: 'text-external', blockIndex: 0, text: 'From Slack',
            streaming: false, messageType: 'text', structuredContent: null,
          }],
          activityId: null,        }],
        activities: [],
        pluginRuns: [],
      }],
      activities: [], activeActivities: [], pluginRuns: [], activeTurns: [], pendingInputs: [],
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
            authorUserId: null, authorSnapshot: null,
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
                pluginId: 'github', toolName: 'Search B', callIndex: 1, status: 'ambiguous',
                participantSafeInput: null, participantSafeResult: null, error: 'outcome unknown', activityId: null,
              },
            ],
            activityId: null,
          },
          {
            transcriptSequence: 2,
            turnId: 'turn-2',
            entryKind: 'conversation',
            actor: 'assistant',
            authorUserId: null, authorSnapshot: null,
            attentionOrdinal: null,
            createdAtUtc: '2026-08-26T12:00:03.000Z',
            revision: 1,
            blocks: [{ type: 'text', blockId: 'text-b', blockIndex: 0, text: 'Then', streaming: false }],
            activityId: null,
          },
        ],
        activities: [],
        pluginRuns: [],
      }],
      activities: [],
      activeActivities: [],
      pluginRuns: [],
      activeTurns: [], pendingInputs: [],
    };

    const canonical = orderedTranscriptMessages(snapshot, 'workstream-one');
    expect(canonical.map((message) => message.id)).toEqual(['text-a', 'tool-a', 'tool-b', 'text-b']);
    expect(canonical.map((message) => message.transcriptTurnId))
      .toEqual(['turn-1', 'turn-1', 'turn-1', 'turn-2']);
    expect(canonical.find((message) => message.id === 'tool-b')?.toolEvent?.status).toBe('ambiguous');
    const overlays = [
      {
        identity: { type: 'assistant_turn' as const, turnId: 'turn-1' },
        provenance: { source: 'socket_event' as const, eventType: 'stream_delta', eventSequence: 1 },
        position: { afterTranscriptSequence: 3, eventSequence: 1 },
        message: createTextMessage({
        ...base, id: 'turn-1', transcriptTurnId: 'turn-1', text: 'First', streaming: true,
        realtimeOrder: { anchorSequenceNumber: 3, eventSequence: 1, placement: 'at_anchor' },
        }),
      },
      {
        identity: { type: 'tool_call' as const, toolCallId: 'call-a' },
        provenance: { source: 'socket_event' as const, eventType: 'tool_event', eventSequence: 2 },
        position: { afterTranscriptSequence: 3, eventSequence: 2 },
        message: createToolEventMessage({
        ...base, id: 'live-tool-a', transcriptTurnId: 'turn-1',
        toolEvent: { id: 'invocation-a', toolCallId: 'call-a', name: 'Search A', status: 'completed' },
        realtimeOrder: { anchorSequenceNumber: 3, eventSequence: 2, placement: 'after_anchor' },
        }),
      },
      {
        identity: { type: 'assistant_turn' as const, turnId: 'turn-3' },
        provenance: { source: 'socket_event' as const, eventType: 'stream_delta', eventSequence: 3 },
        position: { afterTranscriptSequence: 4, eventSequence: 3 },
        message: createTextMessage({
        ...base, id: 'turn-3', transcriptTurnId: 'turn-3', text: 'Still live', streaming: true,
        realtimeOrder: { anchorSequenceNumber: 4, eventSequence: 3, placement: 'at_anchor' },
        }),
      },
      {
        identity: { type: 'assistant_turn' as const, turnId: 'turn-4' },
        provenance: { source: 'socket_event' as const, eventType: 'stream_delta', eventSequence: 4 },
        position: { afterTranscriptSequence: 5, eventSequence: 4 },
        message: createTextMessage({
        ...base, id: 'turn-4', transcriptTurnId: 'turn-4', text: 'Awaiting commit', streaming: false,
        realtimeOrder: { anchorSequenceNumber: 5, eventSequence: 4, placement: 'at_anchor' },
        }),
      },
    ];
    expect(transcriptOverlaysWithoutCanonicalMatch(canonical, overlays)
      .map((overlay) => overlay.message.id)).toEqual(['turn-3', 'turn-4']);
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
          actor: 'assistant', authorUserId: null, authorSnapshot: null, attentionOrdinal: null,
          createdAtUtc: '2026-08-26T12:00:00.000Z', revision: 1, blocks,
          activityId: 'turn-large:activity',        }],
        activities: [],
        pluginRuns: [],
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
      activeActivities: [],
      pluginRuns: [], activeTurns: [], pendingInputs: [],
    };

    const messages = orderedTranscriptMessages(snapshot, 'workstream-one');
    expect(messages).toHaveLength(1_002);
    expect(new Set(messages.map((message) => message.sequenceNumber)).size).toBe(messages.length);
    expect(messages.slice(0, blocks.length).map((message) => message.id))
      .toEqual(blocks.map((block) => block.blockId));
    expect(messages.at(-1)?.id).toBe('run-large');
    expect(composeTranscript(messages, []).at(-1)?.id).toBe('run-large');
  });

  it('keeps response and plugin activity rows beside their canonical turn through composition', () => {
    const snapshot: WorkstreamTranscriptSnapshot = {
      snapshotId: 'snapshot-activity-order', snapshotThrough: 3, eventSequence: 9,
      snapshotAtUtc: '2026-08-26T12:00:10.000Z', unreadAnchorSequence: null,
      unreadReason: 'no_unread',
      ranges: [{
        purpose: 'latest', requested: { startInclusive: 1, endExclusive: 4 },
        covered: { startInclusive: 1, endExclusive: 4 },
        turns: [
          {
            transcriptSequence: 1, turnId: 'turn-before', entryKind: 'conversation',
            actor: 'human', authorUserId: 'user-before',
            authorSnapshot: { userId: 'user-before', displayName: 'Before author', avatarUrl: null },
            attentionOrdinal: null,
            createdAtUtc: '2026-08-26T12:00:01.000Z', revision: 1,
            blocks: [{
              type: 'text', blockId: 'before', blockIndex: 0, text: 'Before', streaming: false,
            }],
            activityId: null,          },
          {
            transcriptSequence: 2, turnId: 'turn-tool', entryKind: 'conversation',
            actor: 'assistant', authorUserId: null, authorSnapshot: null, attentionOrdinal: null,
            createdAtUtc: '2026-08-26T12:00:02.000Z', revision: 1,
            blocks: [{
              type: 'tool', blockId: 'tool', blockIndex: 0, toolCallId: 'call',
              pluginId: 'github', toolName: 'Search', callIndex: 0, status: 'completed',
              participantSafeInput: null, participantSafeResult: 'Found', error: null,
              activityId: null,
            }],
            activityId: 'turn-tool:activity',          },
          {
            transcriptSequence: 3, turnId: 'turn-after', entryKind: 'conversation',
            actor: 'assistant', authorUserId: null, authorSnapshot: null, attentionOrdinal: null,
            createdAtUtc: '2026-08-26T12:00:03.000Z', revision: 1,
            blocks: [{
              type: 'text', blockId: 'after', blockIndex: 0, text: 'After', streaming: false,
            }],
            activityId: null,          },
        ],
        activities: [],
        pluginRuns: [],
      }],
      activities: [
        {
          activityId: 'run', parentActivityId: null, scope: 'response', subjectId: 'run',
          callIndex: null, label: 'Working', state: 'completed', intervals: [], revision: 1,
        },
        {
          activityId: 'turn-tool:activity', parentActivityId: 'run', scope: 'assistant_turn',
          subjectId: 'turn-tool', callIndex: 0, label: 'Assistant turn', state: 'completed',
          intervals: [], revision: 1,
        },
        {
          activityId: 'github', parentActivityId: 'turn-tool:activity', scope: 'plugin',
          subjectId: 'github', callIndex: 0, label: 'GitHub', state: 'completed',
          intervals: [], revision: 1,
        },
      ],
      activeActivities: [],
      pluginRuns: [], activeTurns: [], pendingInputs: [],
    };

    const composed = composeTranscript(orderedTranscriptMessages(snapshot, 'workstream-one'), []);
    expect(composed.map((message) => message.id)).toEqual([
      'before', 'tool', 'github', 'run', 'after',
    ]);
    expect(composed.filter((message) =>
      message.messageType === 'plugin_activity' || message.messageType === 'thought')
      .map((message) => message.transcriptSequence)).toEqual([2, 2]);
    expect(composed.find((message) => message.id === 'github')?.pluginActivity)
      .toMatchObject({ groupKey: 'name:GitHub', icon: 'github', name: 'GitHub' });
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
          authorUserId: null, authorSnapshot: null,
          attentionOrdinal: null,
          createdAtUtc: '2026-08-26T12:00:00.000Z',
          revision: 1,
          blocks: [{ type: 'text', blockId: 'active-text', blockIndex: 0, text: 'Streaming', streaming: true }],
          activityId: 'turn-active:activity',
        }],
        activities: [],
        pluginRuns: [],
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
            boundarySource: 'rally',
            timingAccuracy: 'observed',
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
      pluginRuns: [],
      activeTurns: [], pendingInputs: [],
    };

    const timing = orderedTranscriptMessages(snapshot, 'workstream-one')
      .find((message) => message.id === 'run-active');
    expect(timing?.thoughtEvent).toMatchObject({
      status: 'started',
      durationMs: 10_000,
      activeVerb: 'working',
      completedVerb: 'worked',
      timingAccuracy: 'observed',
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

describe('canonical elicitation presentation', () => {
  const elicitationId = '00000000-0000-7000-8000-0000000000e1';
  const turn = {
    transcriptSequence: 4,
    turnId: 'elicitation-turn',
    entryKind: 'conversation' as const,
    actor: 'assistant' as const,
    authorUserId: null, authorSnapshot: null,
    attentionOrdinal: null,
    createdAtUtc: '2026-08-26T12:00:00.000Z',
    revision: 1,
    blocks: [{
      type: 'text' as const,
      blockId: 'elicitation-turn:text:0',
      blockIndex: 0,
      text: '',
      streaming: false,
      messageType: 'elicitation' as const,
      structuredContent: {
        kind: 'elicitation_request',
        elicitation: {
          id: elicitationId,
          workstreamId: '00000000-0000-7000-8000-0000000000e2',
          harnessRunId: '00000000-0000-7000-8000-0000000000e3',
          prompt: 'Choose one',
          responseType: 'single_select',
          options: [{ value: 'yes', label: 'Yes', description: null }],
          minimumSelections: 1,
          maximumSelections: 1,
          targetUserId: null,
          status: 'open',
          answer: null,
          answeredByUserId: null,
          createdAt: '2026-08-26T12:00:00.000Z',
          answeredAt: null,
        },
      },
    }],
    activityId: null,
  };
  const snapshot = {
    snapshotId: 'elicitation-snapshot',
    snapshotThrough: 4,
    eventSequence: 9,
    snapshotAtUtc: '2026-08-26T12:00:01.000Z',
    unreadAnchorSequence: null,
    unreadReason: 'no_unread' as const,
    ranges: [{
      purpose: 'latest' as const,
      requested: { startInclusive: 1, endExclusive: 5 },
      covered: { startInclusive: 1, endExclusive: 5 },
      turns: [turn],
      activities: [],
      pluginRuns: [],
    }, {
      purpose: 'requested' as const,
      requested: { startInclusive: 4, endExclusive: 5 },
      covered: { startInclusive: 4, endExclusive: 5 },
      turns: [turn],
      activities: [],
      pluginRuns: [],
    }],
    activities: [],
    activeActivities: [],
    pluginRuns: [],
    activeTurns: [turn], pendingInputs: [],
  } satisfies WorkstreamTranscriptSnapshot;

  it('closes and rolls back an open canonical card immediately across every cached copy', () => {
    const answered = setTranscriptElicitationState(snapshot, elicitationId, {
      status: 'answered',
      answer: 'yes',
    });
    const answeredMessages = orderedTranscriptMessages(answered, 'workstream-one');
    expect(answeredMessages).toHaveLength(1);
    expect(answeredMessages[0]?.elicitation).toMatchObject({ status: 'answered', answer: 'yes' });
    expect(answered.ranges.flatMap((range) => range.turns).every((candidate) =>
      candidate.revision === 1)).toBe(true);

    const rolledBack = setTranscriptElicitationState(answered, elicitationId, {
      status: 'open',
      answer: null,
    });
    expect(orderedTranscriptMessages(rolledBack, 'workstream-one')[0]?.elicitation)
      .toMatchObject({ status: 'open', answer: null });
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
      { purpose: 'requested', requested: { startInclusive: 10, endExclusive: 20 }, covered: { startInclusive: 10, endExclusive: 20 }, turns: [], activities: [], pluginRuns: [] },
      { purpose: 'requested', requested: { startInclusive: 15, endExclusive: 25 }, covered: { startInclusive: 15, endExclusive: 25 }, turns: [], activities: [], pluginRuns: [] },
      { purpose: 'latest', requested: { startInclusive: 46, endExclusive: 51 }, covered: { startInclusive: 46, endExclusive: 51 }, turns: [], activities: [], pluginRuns: [] },
    ],
    activities: [],
    activeActivities: [],
    pluginRuns: [],
    activeTurns: [], pendingInputs: [],
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

  it('detects coverage progress even when range merge keeps the same range count', () => {
    const advanced = {
      ...snapshot,
      ranges: snapshot.ranges.map((range, index) => index === 0 ? {
        ...range,
        covered: { startInclusive: 5, endExclusive: 20 },
      } : range),
    };
    expect(advanced.ranges).toHaveLength(snapshot.ranges.length);
    expect(transcriptCoverageAdvanced(snapshot, advanced)).toBe(true);
    expect(transcriptCoverageAdvanced(snapshot, { ...snapshot })).toBe(false);
  });

  it('requests only one adjacent block while the latest island remains instantly available', () => {
    expect(adjacentTranscriptRange(snapshot, 'older')).toEqual({ startInclusive: 1, endExclusive: 10 });
    expect(adjacentTranscriptRange(snapshot, 'newer')).toEqual({ startInclusive: 25, endExclusive: 45 });
  });

  it('keeps loaded history outside a refreshed opening window and replaces overlap authoritatively', () => {
    const historicalTurn = {
      transcriptSequence: 5,
      turnId: 'turn-5',
      entryKind: 'conversation' as const,
      actor: 'assistant' as const,
      authorUserId: null,
      authorSnapshot: null,
      attentionOrdinal: null,
      createdAtUtc: '2026-08-26T12:00:00.000Z',
      revision: 1,
      blocks: [],
      activityId: null,
    };
    const retractedTurn = { ...historicalTurn, transcriptSequence: 12, turnId: 'turn-12' };
    const staleTurn = { ...historicalTurn, transcriptSequence: 15, turnId: 'turn-15' };
    const authoritativeTurn = { ...staleTurn, revision: 2 };
    const current = {
      ...snapshot,
      ranges: [{
        purpose: 'requested' as const,
        requested: { startInclusive: 1, endExclusive: 21 },
        covered: { startInclusive: 1, endExclusive: 21 },
        turns: [historicalTurn, retractedTurn, staleTurn],
        activities: [],
        pluginRuns: [],
      }],
    };
    const incoming = {
      ...snapshot,
      snapshotId: 'snapshot-refresh',
      eventSequence: 2,
      ranges: [{
        purpose: 'unread' as const,
        requested: { startInclusive: 10, endExclusive: 20 },
        covered: { startInclusive: 10, endExclusive: 20 },
        turns: [authoritativeTurn],
        activities: [],
        pluginRuns: [],
      }],
    };

    const merged = mergeCanonicalTranscriptSnapshot(current, incoming);

    expect(merged.snapshotId).toBe('snapshot-refresh');
    expect(transcriptCoverage(merged)).toEqual([{ startInclusive: 1, endExclusive: 21 }]);
    expect(merged.ranges.flatMap((range) => range.turns)).toEqual([
      historicalTurn,
      authoritativeTurn,
    ]);
  });

  it('adds only a realtime singleton and does not fill an older gap', () => {
    const turn = {
      transcriptSequence: 51,
      turnId: 'turn-51',
      entryKind: 'conversation' as const,
      actor: 'assistant' as const,
      authorUserId: null, authorSnapshot: null,
      attentionOrdinal: null,
      createdAtUtc: '2026-08-26T12:00:01.000Z',
      revision: 1,
      blocks: [],
      activityId: null,
    };
    const merged = mergeRealtimeTranscriptTurn(snapshot, turn, 2);
    expect(merged.snapshotThrough).toBe(51);
    expect(transcriptCoverage(merged)).toEqual([
      { startInclusive: 10, endExclusive: 25 },
      { startInclusive: 46, endExclusive: 52 },
    ]);
    expect(transcriptGaps(merged)).toEqual([
      { startInclusive: 1, endExclusive: 10 },
      { startInclusive: 25, endExclusive: 46 },
    ]);
  });

  it('lets authoritative revision one replace a provisional local opening turn', () => {
    const provisional = {
      transcriptSequence: 51,
      turnId: 'opening-turn',
      entryKind: 'conversation' as const,
      actor: 'human' as const,
      authorUserId: 'user-one', authorSnapshot: null,
      attentionOrdinal: 1,
      createdAtUtc: '2026-08-26T12:00:01.000Z',
      revision: 0,
      blocks: [{
        type: 'text' as const,
        blockId: 'opening-turn:text:0',
        blockIndex: 0,
        text: 'local text without hydrated server fields',
        streaming: false,
      }],
      activityId: null,
    };
    const seeded = {
      ...snapshot,
      ranges: [{
        purpose: 'latest' as const,
        requested: { startInclusive: 51, endExclusive: 52 },
        covered: { startInclusive: 51, endExclusive: 52 },
        turns: [provisional],
        activities: [],
        pluginRuns: [],
      }],
    };
    const authoritative = {
      ...provisional,
      revision: 1,
      blocks: [{
        type: 'text' as const,
        blockId: 'opening-turn:text:0',
        blockIndex: 0,
        text: 'server text',
        streaming: false,
        mentions: [{
          type: 'person' as const,
          userId: 'user-two',
          connectorType: null,
          startOffset: 0,
          endOffset: 7,
        }],
      }],
    };

    const merged = mergeRealtimeTranscriptTurn(seeded, authoritative, 2);
    expect(merged.ranges[0]?.turns).toEqual([authoritative]);
  });

  it('does not let a stale realtime revision evict a newer active turn', () => {
    const activeTurn = {
      transcriptSequence: 5,
      turnId: 'turn-active',
      entryKind: 'conversation' as const,
      actor: 'assistant' as const,
      authorUserId: null, authorSnapshot: null,
      attentionOrdinal: null,
      createdAtUtc: '2026-08-26T12:00:01.000Z',
      revision: 4,
      blocks: [{
        type: 'text' as const,
        blockId: 'turn-active:text:0',
        blockIndex: 0,
        text: 'Newest active text',
        streaming: true,
      }],
      activityId: 'turn-active:activity',
    };
    const withActive = { ...snapshot, activeTurns: [activeTurn] };
    const stale = mergeRealtimeTranscriptTurn(
      withActive,
      { ...activeTurn, revision: 3, blocks: [] },
      2,
    );

    expect(stale.activeTurns).toEqual([activeTurn]);
    expect(stale.ranges.flatMap((range) => range.turns)).not.toContainEqual(
      expect.objectContaining({ turnId: activeTurn.turnId, revision: 3 }),
    );
    expect(stale.eventSequence).toBe(2);
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
      pluginRuns: [],
    });
    expect(merged.activities).toContainEqual(activity);
  });

  it('satisfies range union and complement algebra for generated small intervals', () => {
    for (let leftStart = 1; leftStart <= 5; leftStart += 1) {
      for (let leftEnd = leftStart; leftEnd <= 6; leftEnd += 1) {
        for (let rightStart = 1; rightStart <= 5; rightStart += 1) {
          for (let rightEnd = rightStart; rightEnd <= 6; rightEnd += 1) {
            const ranges = [
              { purpose: 'requested' as const, requested: { startInclusive: leftStart, endExclusive: leftEnd }, covered: { startInclusive: leftStart, endExclusive: leftEnd }, turns: [], activities: [], pluginRuns: [] },
              { purpose: 'requested' as const, requested: { startInclusive: rightStart, endExclusive: rightEnd }, covered: { startInclusive: rightStart, endExclusive: rightEnd }, turns: [], activities: [], pluginRuns: [] },
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

describe('grouping tool calls by plugin', () => {
  const row = (id: string, extra: Partial<Message>): Message => ({
    id,
    workstreamId: 'workstream-one',
    sequenceNumber: 0,
    authorType: 'agent',
    messageType: 'text',
    createdAt: '2026-08-26T12:00:00.000Z',
    ...extra,
  });

  const toolRow = (id: string, pluginId: string, pluginName: string, extra: Partial<Message['toolEvent']> = {}): Message =>
    row(id, {
      messageType: 'tool_event',
      toolEvent: {
        id, toolCallId: id, name: `${id}_call`, status: 'completed', pluginId, pluginName, ...extra,
      },
    });

  const activityRow = (id: string, group: { groupKey: string; name: string; icon: 'plug' | 'rally' | 'slack' }, durationMs: number, active = false): Message =>
    row(id, {
      messageType: 'plugin_activity',
      pluginActivity: {
        ...group,
        active,
        durationMs,
        activeVerb: `${group.name} is working`,
        completedVerb: `${group.name} worked`,
      },
    });

  const slack = { groupKey: 'name:Slack', name: 'Slack', icon: 'slack' } as const;

  it('shows one row per plugin, where that plugin first worked', () => {
    const grouped = groupPluginToolMessages([
      toolRow('slack-1', 'connection:one', 'Slack'),
      toolRow('slack-2', 'connection:one', 'Slack'),
      toolRow('granola-1', 'connection:two', 'Granola'),
      toolRow('slack-3', 'connection:one', 'Slack'),
    ]);

    expect(grouped.map((message) => message.pluginActivity?.name)).toEqual(['Slack', 'Granola']);
    expect(grouped.map((message) => message.messageType)).toEqual(['plugin_activity', 'plugin_activity']);
    // Nothing downstream can reach the calls the row stands for.
    expect(grouped.every((message) => message.toolEvent === undefined)).toBe(true);
  });

  it('closes a run at anything a person reads, so later work starts a new row', () => {
    const grouped = groupPluginToolMessages([
      toolRow('slack-1', 'connection:one', 'Slack'),
      toolRow('granola-1', 'connection:two', 'Granola'),
      row('said', { messageType: 'text', text: "I'm looking for more info" }),
      toolRow('slack-2', 'connection:one', 'Slack'),
    ]);

    expect(grouped.map((message) => message.pluginActivity?.name ?? message.text)).toEqual([
      'Slack', 'Granola', "I'm looking for more info", 'Slack',
    ]);
    expect(grouped[0]!.id).not.toBe(grouped[3]!.id);
  });

  it('keeps a run open across the thinking the model does between calls', () => {
    const grouped = groupPluginToolMessages([
      toolRow('granola-1', 'connection:two', 'Granola'),
      row('thinking', { messageType: 'thought', thoughtEvent: { status: 'completed', durationMs: 900 } }),
      toolRow('granola-2', 'connection:two', 'Granola'),
    ]);

    expect(grouped.map((message) => message.messageType)).toEqual(['plugin_activity', 'thought']);
  });

  it('folds every first-party plugin in one run into Rally and Computer', () => {
    const grouped = groupPluginToolMessages([
      toolRow('load', 'rally:discovery', 'rally:discovery'),
      toolRow('memory', 'rally:memory', 'rally:memory'),
      toolRow('wakeup', 'rally:workstream', 'Workstream'),
      toolRow('table', 'rally:tables', 'rally:tables'),
      toolRow('shell', 'rally:terminal', 'Terminal'),
    ]);

    expect(grouped.map((message) => message.pluginActivity?.name)).toEqual(['Rally', 'Computer']);
    expect(grouped.map((message) => message.pluginActivity?.icon)).toEqual(['rally', 'computer']);
  });

  it('drops a tool call whose owner the transcript has not named yet', () => {
    const planned = row('planned', {
      messageType: 'tool_event',
      toolEvent: { id: 'planned', toolCallId: 'planned', name: 'search', status: 'started' },
    });

    expect(groupPluginToolMessages([planned])).toEqual([]);
  });

  it('measures the plugin rather than the sum of its calls when the transcript says so', () => {
    const grouped = groupPluginToolMessages([
      toolRow('slack-1', 'connection:one', 'Slack', { durationMs: 400 }),
      toolRow('slack-2', 'connection:one', 'Slack', { durationMs: 600 }),
      // The plugin activity covers the gap between the two calls; the summed
      // call durations cannot, and must not be added on top of it.
      activityRow('slack-activity', slack, 4_000),
    ]);

    expect(grouped).toHaveLength(1);
    expect(grouped[0]!.pluginActivity).toMatchObject({ durationMs: 4_000, name: 'Slack' });
  });

  it('adds the plugin activities of every turn in the run together', () => {
    const grouped = groupPluginToolMessages([
      toolRow('granola-1', 'connection:two', 'Granola'),
      activityRow('granola-activity-1', { groupKey: 'name:Granola', name: 'Granola', icon: 'plug' }, 3_000),
      row('thinking', { messageType: 'thought', thoughtEvent: { status: 'completed', durationMs: 900 } }),
      toolRow('granola-2', 'connection:two', 'Granola'),
      activityRow('granola-activity-2', { groupKey: 'name:Granola', name: 'Granola', icon: 'plug' }, 3_000, true),
    ]);

    expect(grouped.filter((message) => message.messageType === 'plugin_activity')).toHaveLength(1);
    expect(grouped[0]!.pluginActivity).toMatchObject({ active: true, durationMs: 6_000 });
  });

  it('falls back to the calls it can see while the plugin activity is still missing', () => {
    const grouped = groupPluginToolMessages([
      toolRow('slack-1', 'connection:one', 'Slack', { durationMs: 400 }),
      toolRow('slack-2', 'connection:one', 'Slack', { durationMs: 600, status: 'started' }),
    ]);

    expect(grouped[0]!.pluginActivity).toMatchObject({ active: true, durationMs: 1_000 });
  });

  it('keeps every concurrently running plugin ticking, not just the last one seen', () => {
    // Bind runs a batch's non-activation tool calls concurrently, so two
    // first-party plugins in the Rally group are genuinely active at the same
    // time. Their completed times are summed, so the live row has to advance by
    // both — keeping only the last start advanced it by one, and the number
    // jumped up to the real total the moment they settled.
    const running = (id: string, monotonicStartedAt: number): Message =>
      row(id, {
        messageType: 'plugin_activity',
        pluginActivity: {
          groupKey: 'rally', name: 'Rally', icon: 'rally',
          activeVerb: 'Rally is working', completedVerb: 'Rally worked',
          active: true, durationMs: 3_000, monotonicStartedAt: [monotonicStartedAt],
        },
      });
    const grouped = groupPluginToolMessages([running('memory', 1_000), running('tables', 1_002)]);

    expect(grouped).toHaveLength(1);
    expect(grouped[0]!.pluginActivity).toMatchObject({ active: true, durationMs: 6_000 });
    expect(grouped[0]!.pluginActivity?.monotonicStartedAt).toEqual([1_000, 1_002]);
  });

  it('carries a lone running plugin as one start', () => {
    const grouped = groupPluginToolMessages([
      row('slack-activity', {
        messageType: 'plugin_activity',
        pluginActivity: {
          groupKey: 'name:Slack', name: 'Slack', icon: 'slack',
          activeVerb: 'Slack is working', completedVerb: 'Slack worked',
          active: true, durationMs: 2_000, monotonicStartedAt: [500],
        },
      }),
    ]);

    expect(grouped[0]!.pluginActivity?.monotonicStartedAt).toEqual([500]);
  });

  it('never lets a group row acknowledge the turn it was built from', () => {
    // A tool block carries its turn's attention ordinal — the same ordinal as
    // that turn's text — and the group keeps the row's other fields. Carrying
    // that ordinal too would let a group scrolling into view acknowledge an
    // answer still below the fold, because the guard that skipped tool rows
    // keys on the message type this row no longer has.
    const grouped = groupPluginToolMessages([
      { ...toolRow('slack-1', 'connection:one', 'Slack'), attentionSequenceNumber: 7 },
    ]);

    expect(grouped[0]!.attentionSequenceNumber).toBeNull();
  });

  it('renumbers the rows it kept so the feed stays densely ordered', () => {
    const grouped = groupPluginToolMessages([
      toolRow('slack-1', 'connection:one', 'Slack'),
      toolRow('slack-2', 'connection:one', 'Slack'),
      row('said', { messageType: 'text', text: 'Done' }),
    ]);

    expect(grouped.map((message) => message.sequenceNumber)).toEqual([1, 2]);
  });
});

describe('orderedTranscriptMessages plugin runs', () => {
  /**
   * The shape that produced "Rally worked for 0ms" in production.
   *
   * The turn carries tool blocks and nothing else: `turn.activityId` is null,
   * every block's `activityId` is null, and `activities` is empty. Those are
   * exactly the two nullable seeds the snapshot's upward activity walk needs,
   * so a client rebuilding the row from the activity tree finds no plugin
   * activity, no tool-call duration, and reports zero for work that happened.
   */
  const brokenJoinSnapshot = (
    pluginRuns: WorkstreamTranscriptSnapshot['pluginRuns'],
  ): WorkstreamTranscriptSnapshot => ({
    snapshotId: 'snapshot-plugin-runs', snapshotThrough: 1, eventSequence: 1,
    snapshotAtUtc: '2026-08-26T12:00:10.000Z', unreadAnchorSequence: null,
    unreadReason: 'no_unread',
    ranges: [{
      purpose: 'latest', requested: { startInclusive: 1, endExclusive: 2 },
      covered: { startInclusive: 1, endExclusive: 2 },
      turns: [{
        transcriptSequence: 1, turnId: 'turn-tools', entryKind: 'conversation',
        actor: 'assistant', authorUserId: null, authorSnapshot: null, attentionOrdinal: null,
        createdAtUtc: '2026-08-26T12:00:00.000Z', revision: 1,
        blocks: [
          {
            type: 'tool', blockId: 'b0', blockIndex: 0, toolCallId: 'call-0',
            pluginId: 'rally:core', toolName: 'core_current_time', callIndex: 0,
            status: 'completed', participantSafeInput: null, participantSafeResult: null,
            error: null, activityId: null,
          },
          {
            type: 'tool', blockId: 'b1', blockIndex: 1, toolCallId: 'call-1',
            pluginId: 'rally:memory', toolName: 'memory_search', callIndex: 1,
            status: 'completed', participantSafeInput: null, participantSafeResult: null,
            error: null, activityId: null,
          },
        ],
        activityId: null,
      }],
      activities: [],
      pluginRuns: [],
    }],
    activities: [],
    activeActivities: [],
    pluginRuns,
    activeTurns: [],
    pendingInputs: [],
  });

  const run = (
    over: Partial<WorkstreamTranscriptSnapshot['pluginRuns'][number]>,
  ): WorkstreamTranscriptSnapshot['pluginRuns'][number] => ({
    pluginRunId: 'turn-tools:plugin:rally:core',
    turnId: 'turn-tools',
    pluginId: 'rally:core',
    displayName: 'rally:core',
    state: 'completed',
    durationMs: 4_000,
    elapsedMsAtSnapshot: null,
    timingAccuracy: 'observed',
    toolCallIds: ['call-0'],
    ...over,
  });

  it('times a row from the server when every activity-tree join is missing', () => {
    const messages = orderedTranscriptMessages(
      brokenJoinSnapshot([
        run({}),
        run({
          pluginRunId: 'turn-tools:plugin:rally:memory',
          pluginId: 'rally:memory',
          displayName: 'rally:memory',
          durationMs: 2_770,
          toolCallIds: ['call-1'],
        }),
      ]),
      'workstream-one',
    );
    const grouped = groupPluginToolMessages(messages);
    const rows = grouped.filter((message) => message.messageType === 'plugin_activity');
    expect(rows).toHaveLength(1);
    // Both first-party plugins share the Rally row, and its total is the sum
    // the server measured — not the zero the activity tree could produce here.
    expect(rows[0]!.pluginActivity).toMatchObject({ name: 'Rally', durationMs: 6_770 });
  });

  it('reports an unmeasurable run as unknown rather than as zero', () => {
    const messages = orderedTranscriptMessages(
      brokenJoinSnapshot([run({ durationMs: null, toolCallIds: ['call-0', 'call-1'] })]),
      'workstream-one',
    );
    const grouped = groupPluginToolMessages(messages);
    const rows = grouped.filter((message) => message.messageType === 'plugin_activity');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.pluginActivity?.durationMs).toBeNull();
  });

  it('lets one unmeasurable plugin make the whole row unknown', () => {
    const messages = orderedTranscriptMessages(
      brokenJoinSnapshot([
        run({ durationMs: 4_000 }),
        run({
          pluginRunId: 'turn-tools:plugin:rally:memory',
          pluginId: 'rally:memory',
          displayName: 'rally:memory',
          durationMs: null,
          toolCallIds: ['call-1'],
        }),
      ]),
      'workstream-one',
    );
    const grouped = groupPluginToolMessages(messages);
    const rows = grouped.filter((message) => message.messageType === 'plugin_activity');
    // Summing only the half that reported would understate the work by exactly
    // the half that did not, and present the shortfall as certain.
    expect(rows[0]!.pluginActivity?.durationMs).toBeNull();
  });

  it('lets a live activity supersede the run the snapshot was taken with', () => {
    const snapshot = brokenJoinSnapshot([run({ toolCallIds: ['call-0', 'call-1'] })]);
    const messages = orderedTranscriptMessages({
      ...snapshot,
      activities: [
        {
          activityId: 'turn-tools:activity', parentActivityId: null, scope: 'assistant_turn',
          subjectId: 'turn-tools', callIndex: 0, label: 'Assistant turn', state: 'completed',
          intervals: [], revision: 2,
        },
        {
          activityId: 'turn-tools:plugin:rally:core', parentActivityId: 'turn-tools:activity',
          scope: 'plugin', subjectId: 'rally:core', callIndex: 0, label: 'rally:core',
          state: 'completed',
          intervals: [{
            intervalId: 'i0', startedAtUtc: '2026-08-26T12:00:00.000Z',
            stoppedAtUtc: '2026-08-26T12:00:09.000Z', durationMs: 9_000,
            elapsedMsAtSnapshot: null, boundarySource: 'rally',
            timingAccuracy: 'observed', revision: 2,
          }],
          revision: 2,
        },
      ],
    }, 'workstream-one');
    const rows = groupPluginToolMessages(messages)
      .filter((message) => message.messageType === 'plugin_activity');
    // Still one row, not two: the two sources are the same run and compose
    // rather than competing. The tree wins the timing because realtime keeps
    // it current while the snapshot's copy is frozen at the moment it was
    // taken -- which is what stops a completed plugin ticking forever.
    expect(rows).toHaveLength(1);
    expect(rows[0]!.pluginActivity?.durationMs).toBe(9_000);
  });
});

describe('foldSettledWorkIntoMessages', () => {
  const base = {
    workstreamId: 'workstream-one', sequenceNumber: 0, attentionSequenceNumber: null,
    createdAt: '2026-08-26T12:00:00.000Z', transcriptSequence: 1,
  } as const;
  const answer = (turnId: string): Message => ({
    ...base, id: `${turnId}:text`, transcriptTurnId: turnId,
    authorType: 'agent', messageType: 'text', text: 'Answer',
  });
  const work = (turnId: string, over: Partial<NonNullable<Message['thoughtEvent']>> = {}): Message => ({
    ...base, id: `${turnId}:work`, transcriptTurnId: turnId,
    authorType: 'agent', messageType: 'thought',
    thoughtEvent: {
      status: 'completed', durationMs: 172_000, activeVerb: 'working',
      completedVerb: 'worked', ...over,
    },
  });

  it('moves a settled response total into the message it produced', () => {
    const folded = foldSettledWorkIntoMessages([answer('turn-1'), work('turn-1')]);
    expect(folded).toHaveLength(1);
    expect(folded[0]!.messageType).toBe('text');
    expect(folded[0]!.workSummary).toEqual({ durationMs: 172_000 });
  });

  it('leaves a running total as its own row, because it is still progress', () => {
    const folded = foldSettledWorkIntoMessages([answer('turn-1'), work('turn-1', { status: 'started' })]);
    expect(folded).toHaveLength(2);
    expect(folded[1]!.messageType).toBe('thought');
    expect(folded[0]!.workSummary).toBeUndefined();
  });

  it('leaves a turn thinking row alone', () => {
    // Thinking annotates one step inside the run; only the response's own
    // total is a fact about the finished message.
    const folded = foldSettledWorkIntoMessages([
      answer('turn-1'),
      work('turn-1', { activeVerb: 'thinking', completedVerb: 'thought' }),
    ]);
    expect(folded).toHaveLength(2);
    expect(folded[0]!.workSummary).toBeUndefined();
  });

  it('keeps the row when its turn produced no answer to carry it', () => {
    const folded = foldSettledWorkIntoMessages([answer('turn-1'), work('turn-2')]);
    expect(folded).toHaveLength(2);
    expect(folded[0]!.workSummary).toBeUndefined();
  });

  it('carries an unknown total as unknown', () => {
    const folded = foldSettledWorkIntoMessages([answer('turn-1'), work('turn-1', { durationMs: null })]);
    expect(folded[0]!.workSummary).toEqual({ durationMs: null });
  });
});

describe('plugin runs stay current as the transcript changes', () => {
  const turn = (turnId: string) => ({
    transcriptSequence: 1, turnId, entryKind: 'conversation' as const,
    actor: 'assistant' as const, authorUserId: null, authorSnapshot: null,
    attentionOrdinal: null, createdAtUtc: '2026-08-26T12:00:00.000Z', revision: 1,
    blocks: [{
      type: 'tool' as const, blockId: 'b0', blockIndex: 0, toolCallId: 'call-0',
      pluginId: 'rally:memory', toolName: 'memory_search', callIndex: 0,
      status: 'completed' as const, participantSafeInput: null, participantSafeResult: null,
      error: null, activityId: null,
    }],
    activityId: null,
  });
  const runningRun = {
    pluginRunId: 't1:plugin:rally:memory', turnId: 't1', pluginId: 'rally:memory',
    displayName: 'rally:memory', state: 'active' as const, durationMs: 0,
    elapsedMsAtSnapshot: 2_000, timingAccuracy: 'observed' as const, toolCallIds: ['call-0'],
  };
  const snapshotWith = (
    over: Partial<WorkstreamTranscriptSnapshot> = {},
  ): WorkstreamTranscriptSnapshot => ({
    snapshotId: 's', snapshotThrough: 1, eventSequence: 1,
    snapshotAtUtc: '2026-08-26T12:00:10.000Z', unreadAnchorSequence: null,
    unreadReason: 'no_unread',
    ranges: [{
      purpose: 'latest', requested: { startInclusive: 1, endExclusive: 2 },
      covered: { startInclusive: 1, endExclusive: 2 },
      turns: [turn('t1')], activities: [], pluginRuns: [],
    }],
    activities: [], activeActivities: [], pluginRuns: [runningRun],
    activeTurns: [], pendingInputs: [],
    ...over,
  });

  it('settles a running row when its completion arrives over the socket', () => {
    // The snapshot's run says `active`; realtime only ever updates `activities`,
    // so a row taking its state from the snapshot alone would tick forever.
    const completed = mergeRealtimeTranscriptActivity(snapshotWith(), {
      activityId: 't1:plugin:rally:memory', parentActivityId: 't1:activity', scope: 'plugin',
      subjectId: 'rally:memory', callIndex: 0, label: 'rally:memory', state: 'completed',
      intervals: [{
        intervalId: 'i0', startedAtUtc: '2026-08-26T12:00:00.000Z',
        stoppedAtUtc: '2026-08-26T12:00:06.770Z', durationMs: 6_770,
        elapsedMsAtSnapshot: null, boundarySource: 'rally', timingAccuracy: 'observed', revision: 2,
      }],
      revision: 2,
    }, 2, '2026-08-26T12:00:11.000Z');
    // The turn activity has to be present for the tree to name the run's turn.
    const withParent = {
      ...completed,
      activities: [...completed.activities, {
        activityId: 't1:activity', parentActivityId: null, scope: 'assistant_turn' as const,
        subjectId: 't1', callIndex: 0, label: 'Assistant turn', state: 'completed' as const,
        intervals: [], revision: 2,
      }],
    };
    const row = orderedTranscriptMessages(withParent, 'w')
      .find((message) => message.messageType === 'plugin_activity');
    expect(row?.pluginActivity).toMatchObject({ active: false, durationMs: 6_770 });
  });

  it('keeps a snapshot run when the tree cannot name its turn', () => {
    // The production shape: no activities at all. The server's run stands.
    const row = orderedTranscriptMessages(snapshotWith(), 'w')
      .find((message) => message.messageType === 'plugin_activity');
    expect(row?.pluginActivity).toMatchObject({ active: true });
  });

  it('carries runs in on a loaded range', () => {
    const merged = mergeTranscriptRange(snapshotWith({ pluginRuns: [] }), {
      purpose: 'requested', requested: { startInclusive: 2, endExclusive: 3 },
      covered: { startInclusive: 2, endExclusive: 3 },
      turns: [], activities: [],
      pluginRuns: [{ ...runningRun, pluginRunId: 't2:plugin:rally:memory', turnId: 't2' }],
    });
    expect(merged.pluginRuns.map((run) => run.pluginRunId)).toEqual(['t2:plugin:rally:memory']);
  });

  it('retains the runs of turns a reconcile keeps', () => {
    // History above the incoming snapshot's coverage survives the reconcile, so
    // its timing has to survive with it or those rows blank out.
    const current = snapshotWith({
      ranges: [{
        purpose: 'requested', requested: { startInclusive: 1, endExclusive: 2 },
        covered: { startInclusive: 1, endExclusive: 2 },
        turns: [turn('t1')], activities: [], pluginRuns: [runningRun],
      }],
      pluginRuns: [runningRun],
    });
    const incoming = snapshotWith({
      snapshotThrough: 5,
      ranges: [{
        purpose: 'latest', requested: { startInclusive: 3, endExclusive: 6 },
        covered: { startInclusive: 3, endExclusive: 6 },
        turns: [], activities: [], pluginRuns: [],
      }],
      pluginRuns: [],
    });
    const merged = mergeCanonicalTranscriptSnapshot(current, incoming);
    expect(merged.pluginRuns.map((run) => run.pluginRunId)).toContain('t1:plugin:rally:memory');
    expect(merged.ranges.flatMap((range) => range.pluginRuns).map((run) => run.turnId))
      .toContain('t1');
  });
});

describe('a tool row takes its plugin name from the run', () => {
  it('groups a connector block the activity tree could not name', () => {
    // The production shape for a connector: `connection:<uuid>` on the block,
    // no plugin activity, no `turn.activityId`. Without a name `pluginGroup`
    // returns null and the row is dropped, so the connector vanishes from the
    // feed entirely — the run is the only thing that can name it.
    const snapshot: WorkstreamTranscriptSnapshot = {
      snapshotId: 's', snapshotThrough: 1, eventSequence: 1,
      snapshotAtUtc: '2026-08-26T12:00:10.000Z', unreadAnchorSequence: null,
      unreadReason: 'no_unread',
      ranges: [{
        purpose: 'latest', requested: { startInclusive: 1, endExclusive: 2 },
        covered: { startInclusive: 1, endExclusive: 2 },
        turns: [{
          transcriptSequence: 1, turnId: 't1', entryKind: 'conversation',
          actor: 'assistant', authorUserId: null, authorSnapshot: null, attentionOrdinal: null,
          createdAtUtc: '2026-08-26T12:00:00.000Z', revision: 1,
          blocks: [{
            type: 'tool', blockId: 'b0', blockIndex: 0, toolCallId: 'call-0',
            pluginId: 'connection:9c1f0000-0000-4000-8000-000000000001',
            toolName: 'slack_read_thread', callIndex: 0, status: 'completed',
            participantSafeInput: null, participantSafeResult: null, error: null,
            activityId: null,
          }],
          activityId: null,
        }],
        activities: [], pluginRuns: [],
      }],
      activities: [], activeActivities: [],
      pluginRuns: [{
        pluginRunId: 't1:plugin:connection', turnId: 't1',
        pluginId: 'connection:9c1f0000-0000-4000-8000-000000000001',
        displayName: 'Slack', state: 'completed', durationMs: 5_000,
        elapsedMsAtSnapshot: null, timingAccuracy: 'observed', toolCallIds: ['call-0'],
      }],
      activeTurns: [], pendingInputs: [],
    };
    const messages = orderedTranscriptMessages(snapshot, 'w');
    expect(messages.find((message) => message.messageType === 'tool_event')?.toolEvent?.pluginName)
      .toBe('Slack');
    const rows = groupPluginToolMessages(messages)
      .filter((message) => message.messageType === 'plugin_activity');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.pluginActivity).toMatchObject({ name: 'Slack', durationMs: 5_000 });
  });
});

describe('a reported run always gets a row', () => {
  it('places a run whose calls have no blocks yet at the end of its turn', () => {
    // Reported by the authority, so the work happened; the blocks that would
    // anchor it may simply not have streamed in. Dropping the row loses real
    // information, and anchoring only decides where it sits.
    const snapshot: WorkstreamTranscriptSnapshot = {
      snapshotId: 's', snapshotThrough: 1, eventSequence: 1,
      snapshotAtUtc: '2026-08-26T12:00:10.000Z', unreadAnchorSequence: null,
      unreadReason: 'no_unread',
      ranges: [{
        purpose: 'latest', requested: { startInclusive: 1, endExclusive: 2 },
        covered: { startInclusive: 1, endExclusive: 2 },
        turns: [{
          transcriptSequence: 1, turnId: 't1', entryKind: 'conversation',
          actor: 'assistant', authorUserId: null, authorSnapshot: null, attentionOrdinal: null,
          createdAtUtc: '2026-08-26T12:00:00.000Z', revision: 1,
          blocks: [{
            type: 'text', blockId: 'text-0', blockIndex: 0, text: 'Answer', streaming: false,
          }],
          activityId: null,
        }],
        activities: [], pluginRuns: [],
      }],
      activities: [], activeActivities: [],
      pluginRuns: [{
        pluginRunId: 't1:plugin:rally:memory', turnId: 't1', pluginId: 'rally:memory',
        displayName: 'rally:memory', state: 'completed', durationMs: 4_000,
        elapsedMsAtSnapshot: null, timingAccuracy: 'observed', toolCallIds: ['call-0'],
      }],
      activeTurns: [], pendingInputs: [],
    };
    const rows = orderedTranscriptMessages(snapshot, 'w')
      .filter((message) => message.messageType === 'plugin_activity');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.pluginActivity).toMatchObject({ name: 'Rally', durationMs: 4_000 });
  });
});

describe('composer queue overlays', () => {
  const pendingHuman = {
    inputId: '00000000-0000-7000-8000-000000000101',
    futureTurnId: '00000000-0000-7000-8000-000000000101',
    inputSequence: 3,
    deliveryMode: 'queue' as const,
    afterTranscriptSequence: 4,
    actor: 'human' as const,
    authorUserId: 'user-1',
    authorSnapshot: { userId: 'user-1', displayName: 'Ada', avatarUrl: null },
    clientMessageId: 'client-queue-1',
    externalActor: null,
    block: {
      type: 'text' as const,
      blockId: 'block-1',
      blockIndex: 0,
      text: 'Queued for the next loop',
      streaming: false as const,
      messageType: 'text' as const,
    },
    admittedAtUtc: '2026-08-05T12:00:00.000Z',
  };

  it('copies inputSequence onto the overlay as queueSequence', () => {
    const overlay = pendingTranscriptInputOverlay(pendingHuman, 'workstream-one', {
      source: 'socket_snapshot',
      snapshotId: 'snapshot-1',
    });
    expect(overlay.queueSequence).toBe(3);
    expect(pendingOverlayInputId(overlay)).toBe(pendingHuman.inputId);
    expect(isComposerQueueOverlay(overlay, { harnessRunning: false })).toBe(true);
  });

  it('sorts the composer queue by queueSequence and parks sending rows last', () => {
    const first = pendingTranscriptInputOverlay(pendingHuman, 'workstream-one', {
      source: 'rest_snapshot',
      snapshotId: 'snapshot-1',
    });
    const second = pendingTranscriptInputOverlay({
      ...pendingHuman,
      inputId: '00000000-0000-7000-8000-000000000102',
      futureTurnId: '00000000-0000-7000-8000-000000000102',
      inputSequence: 1,
      clientMessageId: 'client-queue-2',
      block: { ...pendingHuman.block, blockId: 'block-2', text: 'Earlier' },
    }, 'workstream-one', { source: 'rest_snapshot', snapshotId: 'snapshot-1' });
    const sending = {
      identity: { type: 'client_message' as const, clientMessageId: 'client-sending' },
      provenance: { source: 'client_command' as const, phase: 'sending' as const },
      position: { afterTranscriptSequence: 4, eventSequence: 90 },
      message: createTextMessage({
        ...base, id: 'client-sending', clientMessageId: 'client-sending',
        authorType: 'human', text: 'Just typed', deliveryState: 'sending',
      }),
    };
    expect(composerQueueOverlays([first, sending, second], { harnessRunning: true })
      .map((overlay) => overlay.message.text)).toEqual([
      'Earlier',
      'Queued for the next loop',
      'Just typed',
    ]);
    expect(isComposerQueueOverlay(sending, { harnessRunning: false })).toBe(false);
    expect(isComposerQueueOverlay(sending, { harnessRunning: true })).toBe(true);
  });

  it('permutes existing queue sequences in the named order and leaves unnamed ids behind', () => {
    const first = pendingTranscriptInputOverlay(pendingHuman, 'workstream-one', {
      source: 'rest_snapshot',
      snapshotId: 'snapshot-1',
    });
    const second = pendingTranscriptInputOverlay({
      ...pendingHuman,
      inputId: '00000000-0000-7000-8000-000000000102',
      futureTurnId: '00000000-0000-7000-8000-000000000102',
      inputSequence: 1,
      clientMessageId: 'client-queue-2',
    }, 'workstream-one', { source: 'rest_snapshot', snapshotId: 'snapshot-1' });
    const third = pendingTranscriptInputOverlay({
      ...pendingHuman,
      inputId: '00000000-0000-7000-8000-000000000103',
      futureTurnId: '00000000-0000-7000-8000-000000000103',
      inputSequence: 2,
      clientMessageId: 'client-queue-3',
    }, 'workstream-one', { source: 'rest_snapshot', snapshotId: 'snapshot-1' });
    const reordered = applyPendingInputQueueOrder(
      [second, third, first],
      ['00000000-0000-7000-8000-000000000103'],
    );
    expect(composerQueueOverlays(reordered, { harnessRunning: false }).map((overlay) => ({
      id: pendingOverlayInputId(overlay),
      sequence: overlay.queueSequence,
    }))).toEqual([
      { id: '00000000-0000-7000-8000-000000000103', sequence: 1 },
      { id: '00000000-0000-7000-8000-000000000102', sequence: 2 },
      { id: '00000000-0000-7000-8000-000000000101', sequence: 3 },
    ]);
    expect(assignPendingInputQueueSequences(reordered, [
      { inputId: '00000000-0000-7000-8000-000000000103', inputSequence: 7 },
      { inputId: '00000000-0000-7000-8000-000000000102', inputSequence: 8 },
      { inputId: '00000000-0000-7000-8000-000000000101', inputSequence: 9 },
    ]).map((overlay) => overlay.queueSequence)).toEqual([8, 7, 9]);
  });
});
