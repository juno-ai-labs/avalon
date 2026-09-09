import { describe, expect, it } from 'vitest';
import type { WorkstreamTranscriptSnapshot } from '@rally/contracts';
import type { Message, ThoughtEventData } from './types';
import {
  collapseSettledWorkIntoAccordion,
  foldSettledWorkIntoMessages,
  createElicitationMessage,
  adjacentTranscriptRange,
  createTextMessage,
  optimisticMentionRendering,
  createToolEventMessage,
  orderedTranscriptMessages,
  composeTranscript,
  groupPluginToolMessages,
  groupThinkingMessages,
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

  it('carries an automation activation through as its own kind', () => {
    // At the mapping, not at the block. The block-level tests build a Message
    // with this messageType directly, so they passed while this function
    // folded the kind into 'text' — which rendered every automation result as
    // the clamped grey system note instead of a message authored Automation.
    const snapshot = {
      snapshotId: 'snapshot-activation',
      snapshotThrough: 1,
      eventSequence: 1,
      snapshotAtUtc: '2026-09-01T12:00:00.000Z',
      unreadAnchorSequence: null,
      unreadReason: 'no_unread' as const,
      ranges: [{
        purpose: 'latest' as const,
        requested: { startInclusive: 1, endExclusive: 2 },
        covered: { startInclusive: 1, endExclusive: 2 },
        turns: [{
          transcriptSequence: 1,
          turnId: 'turn-activation',
          entryKind: 'conversation' as const,
          actor: 'system' as const,
          authorUserId: null,
          authorSnapshot: null,
          attentionOrdinal: 1,
          clientMessageId: 'automation-activation:delivery-1',
          externalActor: null,
          createdAtUtc: '2026-09-01T12:00:00.000Z',
          revision: 1,
          blocks: [{
            type: 'text' as const,
            blockId: 'block-activation',
            blockIndex: 0,
            text: 'Two candidates reached final round.',
            streaming: false,
            messageType: 'automation_activation' as const,
            structuredContent: null,
            mentions: [],
            attachments: [],
          }],
          blockCount: 1,
          activityId: null,
        }],
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
        messageType: 'automation_activation',
        text: 'Two candidates reached final round.',
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

  it('rewrites an optimistic turn into the Markdown the room will store, so its mention is already a chip', () => {
    // The chip is rendered from the text, not from the mention rows: without
    // the `person://` Markdown `renderIdentity` has no href to resolve and the
    // bubble shows a plain `@Sam` that widens into a chip when the canonical
    // turn lands — the one resize an in-flight row exists to prevent.
    const rendered = optimisticMentionRendering(
      'Ping @Sam and @Linear',
      [
        { type: 'person', label: '@Sam', userId: 'user-sam', connectorType: null, startOffset: 5, endOffset: 9 },
        {
          type: 'connector', label: '@Linear', userId: null, connectorType: 'linear',
          startOffset: 14, endOffset: 21,
        },
      ],
      [{ id: 'user-sam', name: 'Sam', email: 'sam@example.com', timezone: 'UTC' }],
    );

    expect(rendered.text).toBe('Ping [@Sam](person://user-sam) and @Linear');
    expect(rendered.mentions).toEqual([
      {
        type: 'person', personId: 'user-sam', displayName: 'Sam', startOffset: 5, endOffset: 30,
      },
      {
        type: 'connector', connectorType: 'linear', startOffset: 35, endOffset: 42,
      },
    ]);
  });

  it('leaves a draft alone when the selection carries no offsets to rewrite', () => {
    expect(optimisticMentionRendering(
      'Ping @Sam',
      [{ type: 'person', label: '@Sam', userId: 'user-sam', connectorType: null }],
      [{ id: 'user-sam', name: 'Sam', email: 'sam@example.com', timezone: 'UTC' }],
    )).toEqual({ text: 'Ping @Sam', mentions: [] });
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
    // The response's timer carries no spans, deliberately: its own covers the
    // whole run, so a stretch that swallowed this row — one whose settled total
    // never found a host answer — would union to the entire response and claim
    // it for one part of it.
    expect(timing?.workSpans).toBeUndefined();
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

  it('carries every contribution\'s spans onto the group it built', () => {
    // The row was spread from the first call, so its own span stands for a
    // fraction of what the row now says. A stretch unioning these has to see
    // the whole run.
    const grouped = groupPluginToolMessages([
      row('slack-1', {
        messageType: 'tool_event',
        workSpans: [{ startedAtMs: 1_000, endedAtMs: 3_000 }],
        toolEvent: {
          id: 'slack-1', toolCallId: 'slack-1', name: 'slack_read', status: 'completed',
          pluginId: 'connection:one', pluginName: 'Slack',
        },
      }),
      row('slack-2', {
        messageType: 'tool_event',
        workSpans: [{ startedAtMs: 6_000, endedAtMs: 9_000 }],
        toolEvent: {
          id: 'slack-2', toolCallId: 'slack-2', name: 'slack_send', status: 'completed',
          pluginId: 'connection:one', pluginName: 'Slack',
        },
      }),
    ]);

    expect(grouped[0]!.workSpans).toEqual([
      { startedAtMs: 1_000, endedAtMs: 3_000 },
      { startedAtMs: 6_000, endedAtMs: 9_000 },
    ]);
  });

  it('keeps the plugin activity\'s spans when a sibling call has none', () => {
    // The durations are tiered — an activity displaces the tool sums outright —
    // and the spans have to be, or the one nullable join `pluginRuns` exists to
    // route around takes the whole row's timing down with it.
    const grouped = groupPluginToolMessages([
      row('slack-activity', {
        messageType: 'plugin_activity',
        workSpans: [{ startedAtMs: 1_000, endedAtMs: 10_000 }],
        pluginActivity: {
          ...slack, active: false, durationMs: 9_000,
          activeVerb: 'Slack is working', completedVerb: 'Slack worked',
        },
      }),
      toolRow('slack-2', 'connection:one', 'Slack'),
    ]);

    expect(grouped[0]!.workSpans).toEqual([{ startedAtMs: 1_000, endedAtMs: 10_000 }]);
    expect(grouped[0]!.pluginActivity?.durationMs).toBe(9_000);
  });

  it('times a fallback group by the union of its calls, not their sum', () => {
    // Bind runs a batch concurrently, and without an activity the row's own
    // number is a sum of the calls — three 5s calls at once read as 15s. The
    // drawer around it unions the same spans to 5s, and a container shorter
    // than the row inside it reads as a defect rather than as concurrency.
    const call = (id: string, startedAtMs: number, endedAtMs: number): Message => row(id, {
      messageType: 'tool_event',
      workSpans: [{ startedAtMs, endedAtMs }],
      toolEvent: {
        id, toolCallId: id, name: 'slack_read', status: 'completed',
        pluginId: 'connection:one', pluginName: 'Slack', durationMs: endedAtMs - startedAtMs,
      },
    });
    const grouped = groupPluginToolMessages([
      call('slack-1', 1_000, 6_000),
      call('slack-2', 1_000, 6_000),
      call('slack-3', 1_000, 6_000),
    ]);

    expect(grouped[0]!.pluginActivity?.durationMs).toBe(5_000);
  });

  it('carries a recovered call\'s accuracy onto the row it is grouped into', () => {
    // Without an activity the row's number now comes from the calls' spans, so
    // the row has to inherit what those spans say about how well they are known
    // — or it prints a recovered boundary as an exact time, under a drawer that
    // says "at most".
    const grouped = groupPluginToolMessages([
      row('slack-1', {
        messageType: 'tool_event',
        workSpans: [{ startedAtMs: 1_000, endedAtMs: 6_000, timingAccuracy: 'upper_bound' }],
        toolEvent: {
          id: 'slack-1', toolCallId: 'slack-1', name: 'slack_read', status: 'completed',
          pluginId: 'connection:one', pluginName: 'Slack', durationMs: 5_000,
        },
      }),
    ]);

    expect(grouped[0]!.pluginActivity).toEqual(expect.objectContaining({
      durationMs: 5_000,
      timingAccuracy: 'upper_bound',
    }));
  });

  it('drops the group\'s spans when one call cannot say when it worked', () => {
    const grouped = groupPluginToolMessages([
      row('slack-1', {
        messageType: 'tool_event',
        workSpans: [{ startedAtMs: 1_000, endedAtMs: 3_000 }],
        toolEvent: {
          id: 'slack-1', toolCallId: 'slack-1', name: 'slack_read', status: 'completed',
          pluginId: 'connection:one', pluginName: 'Slack',
        },
      }),
      toolRow('slack-2', 'connection:one', 'Slack'),
    ]);

    expect(grouped[0]!.workSpans).toBeUndefined();
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

describe('collapsing a run of thinking', () => {
  const row = (id: string, extra: Partial<Message>): Message => ({
    id,
    workstreamId: 'workstream-one',
    sequenceNumber: 0,
    authorType: 'agent',
    messageType: 'text',
    createdAt: '2026-08-26T12:00:00.000Z',
    ...extra,
  });

  const thinkingRow = (id: string, thought: Partial<ThoughtEventData> = {}): Message =>
    row(id, {
      messageType: 'thought',
      thoughtEvent: {
        status: 'completed',
        durationMs: 1_000,
        activeVerb: 'thinking',
        completedVerb: 'thought',
        ...thought,
      },
    });

  const pluginRow = (id: string): Message =>
    row(id, {
      messageType: 'plugin_activity',
      pluginActivity: {
        groupKey: 'computer', name: 'Computer', icon: 'computer',
        activeVerb: 'using a computer', completedVerb: 'used a computer',
        active: false, durationMs: 7_000,
      },
    });

  it('sums a run into one row where its thinking first started', () => {
    const rows = groupThinkingMessages([
      thinkingRow('thought-1', { durationMs: 29_000 }),
      thinkingRow('thought-2', { durationMs: 38_000 }),
      thinkingRow('thought-3', { durationMs: 17_000 }),
      thinkingRow('thought-4', { durationMs: 14_000 }),
    ]);

    expect(rows.map((message) => message.id)).toEqual(['thought-1']);
    expect(rows[0]!.thoughtEvent).toMatchObject({
      status: 'completed',
      durationMs: 98_000,
      activeVerb: 'thinking',
      completedVerb: 'thought',
    });
  });

  it('carries every segment\'s spans onto the collapsed row', () => {
    const rows = groupThinkingMessages([
      thinkingRow('thought-1', { durationMs: 29_000 }),
      thinkingRow('thought-2', { durationMs: 38_000 }),
    ].map((message, index) => ({
      ...message,
      workSpans: [{ startedAtMs: index * 100_000, endedAtMs: index * 100_000 + 29_000 }],
    })));

    expect(rows[0]!.workSpans).toEqual([
      { startedAtMs: 0, endedAtMs: 29_000 },
      { startedAtMs: 100_000, endedAtMs: 129_000 },
    ]);
  });

  it('drops the collapsed row\'s spans when one segment cannot say when it worked', () => {
    const rows = groupThinkingMessages([
      { ...thinkingRow('thought-1'), workSpans: [{ startedAtMs: 0, endedAtMs: 29_000 }] },
      thinkingRow('thought-2'),
    ]);

    expect(rows[0]!.workSpans).toBeUndefined();
  });

  it('keeps the run open across a plugin row that precedes the thinking', () => {
    // The production shape: one grouped plugin row anchored at the run's first
    // call, with the model's thinking between every later call stacked under it.
    const rows = groupThinkingMessages([
      pluginRow('computer'),
      thinkingRow('thought-1', { durationMs: 29_000 }),
      thinkingRow('thought-2', { durationMs: 38_000 }),
    ]);

    expect(rows.map((message) => message.messageType)).toEqual(['plugin_activity', 'thought']);
    expect(rows[1]!.thoughtEvent?.durationMs).toBe(67_000);
  });

  it('sums thinking that alternates with the plugins it drove', () => {
    // The shape a real multi-plugin run produces: the model thinks, calls a
    // plugin, thinks again, calls another. Every thought belongs to one stretch
    // of reasoning, so the run is one row — and the plugin rows keep their own
    // places, each already anchored at its plugin's first call.
    const rows = groupThinkingMessages([
      pluginRow('rally'),
      thinkingRow('thought-1', { durationMs: 9_000 }),
      pluginRow('multimodal'),
      thinkingRow('thought-2', { durationMs: 7_000 }),
      pluginRow('computer'),
      thinkingRow('thought-3', { durationMs: 8_000 }),
      thinkingRow('thought-4', { durationMs: 11_000 }),
      row('said', { messageType: 'text', text: 'The hero artwork is ready.' }),
      pluginRow('computer-2'),
      thinkingRow('thought-5', { durationMs: 6_000 }),
      thinkingRow('thought-6', { durationMs: 69_000 }),
    ]);

    expect(rows.map((message) => message.id)).toEqual([
      'rally', 'thought-1', 'multimodal', 'computer', 'said', 'computer-2', 'thought-5',
    ]);
    expect(rows.map((message) => message.thoughtEvent?.durationMs ?? null))
      .toEqual([null, 35_000, null, null, null, null, 75_000]);
  });

  it('closes the run at anything a person reads', () => {
    const rows = groupThinkingMessages([
      thinkingRow('thought-1', { durationMs: 1_000 }),
      thinkingRow('thought-2', { durationMs: 2_000 }),
      row('said', { messageType: 'text', text: 'Here is what I found' }),
      thinkingRow('thought-3', { durationMs: 4_000 }),
      thinkingRow('thought-4', { durationMs: 8_000 }),
    ]);

    expect(rows.map((message) => message.thoughtEvent?.durationMs ?? message.text)).toEqual([
      3_000, 'Here is what I found', 12_000,
    ]);
  });

  it('leaves the response total out of the run it sits in', () => {
    // 'working' is the whole response's timer, which the header takes; folding
    // it into a turn's thinking would double-count it and take it out of reach
    // of `foldSettledWorkIntoMessages`.
    const rows = groupThinkingMessages([
      thinkingRow('thought-1', { durationMs: 1_000 }),
      thinkingRow('thought-2', { durationMs: 2_000 }),
      row('response', {
        messageType: 'thought',
        thoughtEvent: { status: 'completed', durationMs: 60_000, activeVerb: 'working', completedVerb: 'worked' },
      }),
    ]);

    expect(rows.map((message) => message.thoughtEvent?.durationMs)).toEqual([3_000, 60_000]);
  });

  it('reports no time at all when one segment of the run never reported its own', () => {
    const rows = groupThinkingMessages([
      thinkingRow('thought-1', { durationMs: 5_000 }),
      thinkingRow('thought-2', { durationMs: null }),
    ]);

    expect(rows[0]!.thoughtEvent?.durationMs).toBeNull();
  });

  it('keeps every still-running segment ticking, and reads as thinking while any is', () => {
    const rows = groupThinkingMessages([
      thinkingRow('thought-1', { durationMs: 5_000 }),
      thinkingRow('thought-2', { status: 'started', durationMs: 2_000, monotonicStartedAt: 1_000 }),
      thinkingRow('thought-3', { status: 'started', durationMs: 3_000, monotonicStartedAt: 1_002 }),
    ]);

    expect(rows[0]!.thoughtEvent).toMatchObject({ status: 'started', durationMs: 10_000 });
    expect(rows[0]!.thoughtEvent?.monotonicStartedAt).toEqual([1_000, 1_002]);
  });

  it('carries a recovered segment\u2019s uncertainty across the whole run', () => {
    const rows = groupThinkingMessages([
      thinkingRow('thought-1', { durationMs: 5_000 }),
      thinkingRow('thought-2', { durationMs: 2_000, timingAccuracy: 'upper_bound' }),
    ]);

    expect(rows[0]!.thoughtEvent?.timingAccuracy).toBe('upper_bound');
  });

  it('leaves a lone thinking row exactly as it was', () => {
    const lone = thinkingRow('thought-1', { durationMs: 5_000, monotonicStartedAt: 1_000 });

    expect(groupThinkingMessages([lone])[0]!.thoughtEvent).toEqual(lone.thoughtEvent);
  });

  it('renumbers the rows it kept so the feed stays densely ordered', () => {
    const rows = groupThinkingMessages([
      thinkingRow('thought-1'),
      thinkingRow('thought-2'),
      row('said', { messageType: 'text', text: 'Done' }),
    ]);

    expect(rows.map((message) => message.sequenceNumber)).toEqual([1, 2]);
  });
});

describe('a transcript gap between two loaded islands', () => {
  /**
   * The opening snapshot a person returning to a busy work stream gets: an
   * unread island and a separate latest island, with turns nobody has loaded
   * in between. Both islands are flattened into one feed, so the last row of
   * the first and the first row of the second look adjacent and are not.
   */
  const thinkingTurn = (
    transcriptSequence: number,
    turnId: string,
  ): WorkstreamTranscriptSnapshot['ranges'][number]['turns'][number] => ({
    transcriptSequence, turnId, entryKind: 'conversation',
    actor: 'assistant', authorUserId: null, authorSnapshot: null, attentionOrdinal: null,
    createdAtUtc: '2026-08-26T12:00:00.000Z', revision: 1,
    blocks: [{
      type: 'thinking', blockId: `${turnId}:thinking:0`, blockIndex: 0,
      providerEvidence: 'reasoning_summary', summary: null,
      activityId: `${turnId}:activity`,
    }],
    activityId: null,
  });

  const thinkingActivity = (
    turnId: string,
    durationMs: number,
  ): WorkstreamTranscriptSnapshot['activities'][number] => ({
    activityId: `${turnId}:activity`, parentActivityId: null, scope: 'thinking',
    subjectId: `${turnId}:thinking:0`, callIndex: null, label: 'Thinking',
    state: 'completed', revision: 1,
    intervals: [{
      intervalId: `${turnId}:interval`, startedAtUtc: '2026-08-26T12:00:00.000Z',
      stoppedAtUtc: '2026-08-26T12:00:10.000Z', durationMs,
      elapsedMsAtSnapshot: durationMs, boundarySource: 'rally',
      timingAccuracy: 'observed', revision: 1,
    }],
  });

  const disjointSnapshot: WorkstreamTranscriptSnapshot = {
    snapshotId: 'snapshot-gap', snapshotThrough: 12, eventSequence: 1,
    snapshotAtUtc: '2026-08-26T12:00:10.000Z', unreadAnchorSequence: 2,
    unreadReason: null,
    ranges: [
      {
        purpose: 'unread',
        requested: { startInclusive: 2, endExclusive: 3 },
        covered: { startInclusive: 2, endExclusive: 3 },
        turns: [thinkingTurn(2, 'turn-unread')],
        activities: [], pluginRuns: [],
      },
      {
        purpose: 'latest',
        requested: { startInclusive: 11, endExclusive: 13 },
        covered: { startInclusive: 11, endExclusive: 13 },
        turns: [thinkingTurn(11, 'turn-latest'), thinkingTurn(12, 'turn-latest-2')],
        activities: [], pluginRuns: [],
      },
    ],
    activities: [
      thinkingActivity('turn-unread', 29_000),
      thinkingActivity('turn-latest', 38_000),
      thinkingActivity('turn-latest-2', 17_000),
    ],
    activeActivities: [], pluginRuns: [], activeTurns: [], pendingInputs: [],
  };

  it('marks the first row of a later island and nothing else', () => {
    const messages = orderedTranscriptMessages(disjointSnapshot, 'workstream-one', []);

    expect(messages.map((message) => message.precededByTranscriptGap ?? false))
      .toEqual([false, true, false]);
  });

  it('never sums thinking across turns nobody has loaded', () => {
    // The turns between sequence 2 and 11 are not on this client. One of them
    // may be a sentence from Rally, which would have ended the run — so the two
    // sides of the seam must stay two rows, and only the contiguous pair sums.
    const rows = groupThinkingMessages(orderedTranscriptMessages(disjointSnapshot, 'workstream-one', []));

    expect(rows.map((message) => message.thoughtEvent?.durationMs)).toEqual([29_000, 55_000]);
  });

  it('never groups a plugin across turns nobody has loaded', () => {
    const toolRow = (id: string, extra: Partial<Message>): Message => ({
      id,
      workstreamId: 'workstream-one',
      sequenceNumber: 0,
      authorType: 'agent',
      messageType: 'tool_event',
      createdAt: '2026-08-26T12:00:00.000Z',
      toolEvent: {
        id, toolCallId: id, name: `${id}_call`, status: 'completed',
        pluginId: 'connection:one', pluginName: 'Slack',
      },
      ...extra,
    });
    const grouped = groupPluginToolMessages([
      toolRow('slack-1', {}),
      toolRow('slack-2', { precededByTranscriptGap: true }),
    ]);

    expect(grouped).toHaveLength(2);
    expect(grouped.every((message) => message.messageType === 'plugin_activity')).toBe(true);
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

  it('takes a plugin row\'s spans from the activity that measured it', () => {
    const snapshot = brokenJoinSnapshot([run({ toolCallIds: ['call-0'] })]);
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

    // When it worked, not only how long: a folded stretch adds several rows up
    // and cannot do that from durations alone.
    expect(messages.find((message) => message.messageType === 'plugin_activity')?.workSpans)
      .toEqual([{
        startedAtMs: Date.parse('2026-08-26T12:00:00.000Z'),
        endedAtMs: Date.parse('2026-08-26T12:00:09.000Z'),
      }]);
  });

  it('leaves a still-running interval without spans', () => {
    // A span needs an end. An open interval has an elapsed reading instead,
    // which is a number that keeps changing, and unioning it would freeze it.
    const snapshot = brokenJoinSnapshot([run({ toolCallIds: ['call-0'] })]);
    const messages = orderedTranscriptMessages({
      ...snapshot,
      activities: [
        {
          activityId: 'turn-tools:plugin:rally:core', parentActivityId: null,
          scope: 'plugin', subjectId: 'rally:core', callIndex: 0, label: 'rally:core',
          state: 'active',
          intervals: [{
            intervalId: 'i0', startedAtUtc: '2026-08-26T12:00:00.000Z',
            stoppedAtUtc: null, durationMs: null, elapsedMsAtSnapshot: 4_000,
            boundarySource: 'rally', timingAccuracy: 'observed', revision: 2,
          }],
          revision: 2,
        },
      ],
    }, 'workstream-one');

    expect(messages.find((message) => message.messageType === 'plugin_activity')?.workSpans)
      .toBeUndefined();
  });

  it('leaves an interval the authority could not measure without spans', () => {
    // Closed, with timestamps, and a null duration: the contract calls that
    // unmeasurable and `activityDuration` counts it as nothing. Reading the
    // timestamps anyway would let a drawer report time its rows do not have.
    const snapshot = brokenJoinSnapshot([run({ toolCallIds: ['call-0'] })]);
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
            stoppedAtUtc: '2026-08-26T12:00:09.000Z', durationMs: null,
            elapsedMsAtSnapshot: null, boundarySource: 'recovered',
            timingAccuracy: 'upper_bound', revision: 2,
          }],
          revision: 2,
        },
      ],
    }, 'workstream-one');

    expect(messages.find((message) => message.messageType === 'plugin_activity')?.workSpans)
      .toBeUndefined();
  });

  it('leaves a run the activity tree never reached without spans', () => {
    // The server states how long it took; nothing here can state when, and a
    // stretch holding this row therefore reports no total rather than one
    // missing it.
    const messages = orderedTranscriptMessages(brokenJoinSnapshot([run({})]), 'workstream-one');

    const row = messages.find((message) => message.messageType === 'plugin_activity');
    expect(row?.pluginActivity?.durationMs).toBe(4_000);
    expect(row?.workSpans).toBeUndefined();
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

describe('collapseSettledWorkIntoAccordion', () => {
  const base = {
    workstreamId: 'workstream-one', sequenceNumber: 0, attentionSequenceNumber: 7,
    createdAt: '2026-08-26T12:00:00.000Z', transcriptSequence: 1,
    authorType: 'agent' as const,
  };
  const answer = (turnId: string, over: Partial<Message> = {}): Message => ({
    ...base, id: `${turnId}:text`, transcriptTurnId: turnId,
    messageType: 'text', text: 'Answer', workSummary: { durationMs: 2_477_000 }, ...over,
  });
  const plugin = (id: string, name: string, over: Partial<Message> = {}): Message => ({
    ...base, id, messageType: 'plugin_activity',
    pluginActivity: {
      groupKey: `name:${name}`, name, icon: 'plug', active: false, durationMs: 4_000,
      activeVerb: `Using ${name}`, completedVerb: `Used ${name}`,
    },
    ...over,
  });
  const thinking = (id: string, over: Partial<Message> = {}): Message => ({
    ...base, id, messageType: 'thought',
    thoughtEvent: {
      status: 'completed', durationMs: 50_000, activeVerb: 'thinking', completedVerb: 'thought',
    },
    ...over,
  });
  const said = (id: string): Message => ({
    ...base, id, authorType: 'human', messageType: 'text', text: 'Please investigate.',
  });

  it('folds a settled run behind its own total, above the answer it produced', () => {
    const collapsed = collapseSettledWorkIntoAccordion([
      said('human-one'),
      thinking('thought-one'),
      plugin('plugin-google', 'Google Mail + Calendar'),
      plugin('plugin-web', 'Web'),
      answer('turn-1'),
    ]);

    expect(collapsed.map((message) => message.messageType)).toEqual(['text', 'work_accordion', 'text']);
    const accordion = collapsed[1]!;
    // Where the run's first row sat, and holding every row of it in order.
    expect(accordion.workAccordion?.rows.map((row) => row.id))
      .toEqual(['thought-one', 'plugin-google', 'plugin-web']);
    // The answer's own total, moved rather than copied: one duration, one place.
    expect(accordion.workAccordion?.durationMs).toBe(2_477_000);
    expect(collapsed[2]!.workSummary).toBeUndefined();
  });

  it('keeps the total in the header when the turn reached for nothing', () => {
    // No machinery above the answer means no drawer to put the receipt in, and
    // an empty accordion is worse than the line it replaced.
    const collapsed = collapseSettledWorkIntoAccordion([said('human-one'), answer('turn-1')]);

    expect(collapsed.map((message) => message.messageType)).toEqual(['text', 'text']);
    expect(collapsed[1]!.workSummary).toEqual({ durationMs: 2_477_000 });
  });

  it('stops at the last thing a person read, so one answer never swallows another turn', () => {
    const collapsed = collapseSettledWorkIntoAccordion([
      plugin('plugin-early', 'Slack'),
      answer('turn-1', { id: 'turn-1:text', workSummary: undefined }),
      thinking('thought-two'),
      answer('turn-2'),
    ]);

    // Each answer folds the stretch that reported into it, and neither drawer
    // reaches past the sentence between them.
    expect(collapsed.map((message) => message.messageType))
      .toEqual(['work_accordion', 'text', 'work_accordion', 'text']);
    expect(collapsed[0]!.workAccordion?.rows.map((row) => row.id)).toEqual(['plugin-early']);
    expect(collapsed[2]!.workAccordion?.rows.map((row) => row.id)).toEqual(['thought-two']);
  });

  it('folds every stretch of a run that narrated itself, not only the last', () => {
    // The response timer settles once, at the end. Keying on it folded the last
    // stretch and left the earlier ones expanded above the sentences that had
    // already summarized them — the stack of spent timers this pass removes.
    const collapsed = collapseSettledWorkIntoAccordion([
      said('human-one'),
      thinking('thought-one'),
      answer('turn-1', { id: 'turn-1:text', workSummary: undefined }),
      plugin('plugin-github', 'GitHub'),
      thinking('thought-two'),
      answer('turn-2', { id: 'turn-2:text', workSummary: undefined }),
      plugin('plugin-web', 'Web'),
      answer('turn-3'),
    ]);

    expect(collapsed.map((message) => message.messageType)).toEqual([
      'text',
      'work_accordion', 'text',
      'work_accordion', 'text',
      'work_accordion', 'text',
    ]);
    expect(collapsed[3]!.workAccordion?.rows.map((row) => row.id))
      .toEqual(['plugin-github', 'thought-two']);
  });

  it('keeps a multi-stretch response\'s total in the header rather than on its last drawer', () => {
    // The total measured the whole response. No one stretch is that, so printing
    // it on the last drawer would claim 2,477s for the 50s of rows inside it.
    const collapsed = collapseSettledWorkIntoAccordion([
      said('human-one'),
      thinking('thought-one'),
      answer('turn-1', { id: 'turn-1:text', workSummary: undefined }),
      thinking('thought-two'),
      answer('turn-2'),
    ]);

    // Each drawer reports the one row it holds, and neither takes the total.
    expect(collapsed[1]!.workAccordion?.durationMs).toBe(50_000);
    expect(collapsed[3]!.workAccordion?.durationMs).toBe(50_000);
    expect(collapsed[4]!.workSummary).toEqual({ durationMs: 2_477_000 });
  });

  it('starts counting a response\'s stretches again after the previous one settled', () => {
    // A settled total ends the response it belonged to, so the next response's
    // single drawer is still that response's whole run and still takes it.
    const collapsed = collapseSettledWorkIntoAccordion([
      thinking('thought-one'),
      answer('turn-1', { id: 'turn-1:text' }),
      thinking('thought-two'),
      answer('turn-2', { id: 'turn-2:text' }),
    ]);

    expect(collapsed[0]!.workAccordion?.durationMs).toBe(2_477_000);
    expect(collapsed[2]!.workAccordion?.durationMs).toBe(2_477_000);
    expect(collapsed[1]!.workSummary).toBeUndefined();
    expect(collapsed[3]!.workSummary).toBeUndefined();
  });

  it('stops at a stretch of transcript nobody has loaded', () => {
    // The sentence that closed the earlier run may be sitting in the gap, so
    // the row after it opens the accordion rather than joining what precedes.
    const collapsed = collapseSettledWorkIntoAccordion([
      plugin('plugin-before-gap', 'Slack'),
      thinking('thought-after-gap', { precededByTranscriptGap: true }),
      plugin('plugin-web', 'Web'),
      answer('turn-1'),
    ]);

    expect(collapsed.map((message) => message.messageType))
      .toEqual(['plugin_activity', 'work_accordion', 'text']);
    expect(collapsed[1]!.workAccordion?.rows.map((row) => row.id))
      .toEqual(['thought-after-gap', 'plugin-web']);
  });

  it('stops when the answer itself opens a newly loaded stretch', () => {
    // The projection marks only a turn's first row, so an answer that opens its
    // turn is where this shape appears. What sits above it is the previous
    // island's work, and folding it in would attribute it to this answer.
    const collapsed = collapseSettledWorkIntoAccordion([
      plugin('plugin-before-gap', 'Slack'),
      thinking('thought-before-gap'),
      answer('turn-1', { precededByTranscriptGap: true }),
    ]);

    expect(collapsed.map((message) => message.messageType))
      .toEqual(['plugin_activity', 'thought', 'text']);
    // No drawer to move it to, so the total stays in the header.
    expect(collapsed[2]!.workSummary).toEqual({ durationMs: 2_477_000 });
  });

  it('keeps the turn\'s attention ordinal, so the unread divider lands above the run', () => {
    // The divider is placed at the first row carrying an ordinal. The rows that
    // carried it are inside the accordion now, so the accordion carries it or
    // an unread turn's work ends up above the divider, in the read section.
    const collapsed = collapseSettledWorkIntoAccordion([
      // A grouped plugin row already carries none; the thinking row behind it
      // is where the turn's ordinal survives, and it is the one to inherit.
      plugin('plugin-web', 'Web', { attentionSequenceNumber: null }),
      thinking('thought-one', { attentionSequenceNumber: 12 }),
      answer('turn-1', { attentionSequenceNumber: 12 }),
    ]);

    expect(collapsed[0]!.messageType).toBe('work_accordion');
    expect(collapsed[0]!.attentionSequenceNumber).toBe(12);
  });

  it('leaves the live tail expanded, because its rows are the progress being watched', () => {
    // Nothing has reported on these rows yet — the response's own timer is the
    // last row in the feed while it runs — so they stay in the feed as progress.
    const collapsed = collapseSettledWorkIntoAccordion([
      thinking('thought-one'),
      answer('turn-1', { workSummary: undefined }),
      plugin('plugin-web', 'Web', { pluginActivity: {
        groupKey: 'name:Web', name: 'Web', icon: 'web', active: true, durationMs: 7_000,
        activeVerb: 'Using Web', completedVerb: 'Used Web',
      } }),
      thinking('thought-live', { thoughtEvent: {
        status: 'started', durationMs: 12_000, activeVerb: 'working', completedVerb: 'worked',
      } }),
    ]);

    expect(collapsed.map((message) => message.messageType))
      .toEqual(['work_accordion', 'text', 'plugin_activity', 'thought']);
  });

  it('gives the accordion a derived id, no attention ordinal, and a renumbered feed', () => {
    const collapsed = collapseSettledWorkIntoAccordion([
      said('human-one'),
      thinking('thought-one'),
      plugin('plugin-web', 'Web'),
      answer('turn-1'),
    ]);

    // Derived, because the row it sits in place of is still in the feed inside
    // it, and two elements answering to one `message-<id>` anchor is worse than
    // none.
    expect(collapsed[1]!.id).toBe('thought-one:work-accordion');
    // Nothing downstream should read the first row's own timing off the wrapper.
    expect(collapsed[1]!.thoughtEvent).toBeUndefined();
    expect(collapsed.map((message) => message.sequenceNumber)).toEqual([1, 2, 3]);
  });

  it('keeps the total in the header when the response begins in an unloaded stretch', () => {
    // The seam means the response may have had earlier stretches nobody has
    // loaded, so the one visible drawer is not known to be the whole of what
    // the total measured — and filling the gap must not move the label.
    const collapsed = collapseSettledWorkIntoAccordion([
      plugin('plugin-before-gap', 'Slack'),
      thinking('thought-after-gap', { precededByTranscriptGap: true }),
      answer('turn-1'),
    ]);

    // The drawer still reports its own row; what it must not take is the
    // response's total, which stays in the header until the gap is filled.
    expect(collapsed[1]!.workAccordion?.durationMs).toBe(50_000);
    expect(collapsed[2]!.workSummary).toEqual({ durationMs: 2_477_000 });
  });

  it('recovers coverage at the next settled total, so a later response keeps its own', () => {
    // The guard above must not latch: a settled total is the end of the response
    // that may have been partly unloaded, and whatever follows it is loaded.
    const collapsed = collapseSettledWorkIntoAccordion([
      thinking('thought-after-gap', { precededByTranscriptGap: true }),
      answer('turn-0', { id: 'turn-0:text' }),
      thinking('thought-one'),
      answer('turn-1'),
    ]);

    // The drawer inside the partially loaded response reports its own row
    // rather than the response's total, which stays in the header.
    expect(collapsed[0]!.workAccordion?.durationMs).toBe(50_000);
    expect(collapsed[1]!.workSummary).toEqual({ durationMs: 2_477_000 });
    // The next response is whole, and takes it.
    expect(collapsed[2]!.workAccordion?.durationMs).toBe(2_477_000);
    expect(collapsed[3]!.workSummary).toBeUndefined();
  });

  it('does not treat a steer as the end of the response it interrupts', () => {
    // A steer is committed as its own canonical turn between two answers of one
    // response, while the response activity spans both sides of it. Counting it
    // as a boundary let the last stretch take a total covering both.
    const collapsed = collapseSettledWorkIntoAccordion([
      said('human-one'),
      thinking('thought-one'),
      answer('turn-1', { id: 'turn-1:text', workSummary: undefined }),
      said('human-steer'),
      thinking('thought-two'),
      answer('turn-2'),
    ]);

    expect(collapsed[4]!.workAccordion?.durationMs).toBe(50_000);
    expect(collapsed[5]!.workSummary).toEqual({ durationMs: 2_477_000 });
  });

  it('leaves a stretch open while any row in it is still reporting live work', () => {
    // A streaming answer overlay is inserted at `transcriptSequence - 1`, so it
    // can arrive below the response's own still-running timer. Folding on
    // position alone put that live timer inside a closed drawer.
    const liveResponseTotal = thinking('act-response', {
      thoughtEvent: {
        status: 'started', durationMs: 195_000, activeVerb: 'working', completedVerb: 'worked',
      },
    });
    const collapsed = collapseSettledWorkIntoAccordion([
      thinking('thought-one'),
      liveResponseTotal,
      answer('turn-1', { id: 'overlay:text', streaming: true, workSummary: undefined }),
    ]);

    expect(collapsed.map((message) => message.messageType)).toEqual(['thought', 'thought', 'text']);
  });

  it('closes that stretch once the live row settles', () => {
    // The same rows, with the timer settled: nothing is being watched any more.
    const collapsed = collapseSettledWorkIntoAccordion([
      thinking('thought-one'),
      thinking('act-response', { thoughtEvent: {
        status: 'completed', durationMs: 195_000, activeVerb: 'working', completedVerb: 'worked',
      } }),
      answer('turn-1', { id: 'overlay:text', workSummary: undefined }),
    ]);

    expect(collapsed.map((message) => message.messageType)).toEqual(['work_accordion', 'text']);
    expect(collapsed[0]!.workAccordion?.rows.map((row) => row.id))
      .toEqual(['thought-one', 'act-response']);
  });

  it('keeps a multi-drawer response\'s total in the header when its last answer folds nothing', () => {
    // `collapsed.length === 0` with drawers already built earlier in the
    // response: the total has no drawer of its own to go to, and the drawers it
    // does not describe must not get it either.
    const collapsed = collapseSettledWorkIntoAccordion([
      said('human-one'),
      thinking('thought-one'),
      answer('turn-1', { id: 'turn-1:text', workSummary: undefined }),
      answer('turn-2'),
    ]);

    expect(collapsed.map((message) => message.messageType))
      .toEqual(['text', 'work_accordion', 'text', 'text']);
    expect(collapsed[1]!.workAccordion?.durationMs).toBe(50_000);
    expect(collapsed[3]!.workSummary).toEqual({ durationMs: 2_477_000 });
  });

  it('holds a stretch open for a plugin run still marked active, not only a live timer', () => {
    // A plugin run is anchored at its own last call inside `run.turnId`, so a
    // run still reading active in one turn sits above an answer arriving in the
    // next. Its mark is still pulsing; it does not go in a closed drawer.
    const collapsed = collapseSettledWorkIntoAccordion([
      thinking('thought-one'),
      plugin('plugin-slack', 'Slack', { pluginActivity: {
        groupKey: 'name:Slack', name: 'Slack', icon: 'plug', active: true, durationMs: 7_000,
        activeVerb: 'Using Slack', completedVerb: 'Used Slack',
      } }),
      answer('turn-1', { workSummary: undefined }),
    ]);

    expect(collapsed.map((message) => message.messageType))
      .toEqual(['thought', 'plugin_activity', 'text']);
  });

  it('reports a stretch of a self-narrating response from when its rows worked', () => {
    // No one drawer is what the response timer measured, so each says what it
    // holds: the union of its rows' spans. The rows overlap here — the plugin
    // covers the gaps between its own calls that the thinking beside it fills —
    // and the sum of their two 12s spans, 24s, is 9s more than the 15s the
    // stretch actually took.
    const collapsed = collapseSettledWorkIntoAccordion([
      thinking('thought-one', {
        workSpans: [{ startedAtMs: 1_000_000, endedAtMs: 1_009_000 }],
      }),
      answer('turn-1', { id: 'turn-1:text', workSummary: undefined }),
      thinking('thought-two', {
        workSpans: [{ startedAtMs: 1_020_000, endedAtMs: 1_032_000 }],
      }),
      plugin('plugin-drive', 'Google Drive + Docs + Sheets', {
        workSpans: [{ startedAtMs: 1_023_000, endedAtMs: 1_035_000 }],
      }),
      answer('turn-2'),
    ]);

    expect(collapsed[0]!.workAccordion?.durationMs).toBe(9_000);
    expect(collapsed[2]!.workAccordion?.durationMs).toBe(15_000);
    // The response's own total still belongs to the answer that produced it.
    expect(collapsed[3]!.workSummary).toEqual({ durationMs: 2_477_000 });
  });

  it('adds up stretches of work that do not overlap', () => {
    // The shape the feed produces most often: a thought, then a call that ran
    // after it finished. A union that kept only the last cluster would report
    // 5s here, and one that measured start-to-end would report 15s.
    const collapsed = collapseSettledWorkIntoAccordion([
      plugin('plugin-slack', 'Slack', {
        workSpans: [{ startedAtMs: 1_010_000, endedAtMs: 1_015_000 }],
      }),
      thinking('thought-one', {
        workSpans: [{ startedAtMs: 1_000_000, endedAtMs: 1_005_000 }],
      }),
      answer('turn-1', { workSummary: undefined }),
    ]);

    expect(collapsed[0]!.workAccordion?.durationMs).toBe(10_000);
  });

  it('reads a stretch holding an upper-bound thinking row as an upper bound', () => {
    const collapsed = collapseSettledWorkIntoAccordion([
      thinking('thought-one', {
        workSpans: [{ startedAtMs: 1_000_000, endedAtMs: 1_009_000 }],
        thoughtEvent: {
          status: 'completed', durationMs: 9_000, timingAccuracy: 'upper_bound',
          activeVerb: 'thinking', completedVerb: 'thought',
        },
      }),
      answer('turn-1', { workSummary: undefined }),
    ]);

    expect(collapsed[0]!.workAccordion).toEqual(expect.objectContaining({
      durationMs: 9_000,
      timingAccuracy: 'upper_bound',
    }));
  });

  it('takes a lone row\'s own duration when it cannot say when it worked', () => {
    // One row is the whole stretch, so there is nothing to union it against and
    // nothing its number could be overlapping with. Falling back to "Worked"
    // here would withhold a total the drawer plainly has.
    const collapsed = collapseSettledWorkIntoAccordion([
      plugin('plugin-slack', 'Slack'),
      answer('turn-1', { workSummary: undefined }),
    ]);

    expect(collapsed[0]!.workAccordion?.durationMs).toBe(4_000);
  });

  it('says only "Worked" when a row in the stretch cannot say when it worked', () => {
    // A union over the rest would print a number missing however long that row
    // took, and present it as the stretch's own.
    const collapsed = collapseSettledWorkIntoAccordion([
      thinking('thought-one', {
        workSpans: [{ startedAtMs: 1_000_000, endedAtMs: 1_009_000 }],
      }),
      answer('turn-1', { id: 'turn-1:text', workSummary: undefined }),
      thinking('thought-two', {
        workSpans: [{ startedAtMs: 1_020_000, endedAtMs: 1_032_000 }],
      }),
      plugin('plugin-drive', 'Google Drive + Docs + Sheets'),
      answer('turn-2'),
    ]);

    expect(collapsed[0]!.workAccordion?.durationMs).toBe(9_000);
    expect(collapsed[2]!.workAccordion?.durationMs).toBeNull();
  });

  it('reads a stretch holding an upper-bound row as an upper bound itself', () => {
    const collapsed = collapseSettledWorkIntoAccordion([
      thinking('thought-one', {
        workSpans: [{ startedAtMs: 1_000_000, endedAtMs: 1_009_000 }],
      }),
      answer('turn-1', { id: 'turn-1:text', workSummary: undefined }),
      plugin('plugin-slack', 'Slack', {
        workSpans: [{ startedAtMs: 1_020_000, endedAtMs: 1_024_000 }],
        pluginActivity: {
          groupKey: 'name:Slack', name: 'Slack', icon: 'plug', active: false,
          durationMs: 4_000, timingAccuracy: 'upper_bound',
          activeVerb: 'Using Slack', completedVerb: 'Used Slack',
        },
      }),
      answer('turn-2'),
    ]);

    expect(collapsed[2]!.workAccordion).toEqual(expect.objectContaining({
      durationMs: 4_000,
      timingAccuracy: 'upper_bound',
    }));
  });

  it('keeps a recovered boundary\'s accuracy when the span is all that carries it', () => {
    // A group assembled from tool rows alone — the fallback for a run whose
    // plugin activity never arrived — has no aggregate accuracy to read, so the
    // span is the only thing that can say the boundary was recovered.
    const collapsed = collapseSettledWorkIntoAccordion([
      thinking('thought-one', {
        workSpans: [{ startedAtMs: 1_000_000, endedAtMs: 1_009_000 }],
      }),
      answer('turn-1', { id: 'turn-1:text', workSummary: undefined }),
      plugin('plugin-slack', 'Slack', {
        workSpans: [{
          startedAtMs: 1_020_000, endedAtMs: 1_024_000, timingAccuracy: 'upper_bound',
        }],
      }),
      answer('turn-2'),
    ]);

    expect(collapsed[2]!.workAccordion).toEqual(expect.objectContaining({
      durationMs: 4_000,
      timingAccuracy: 'upper_bound',
    }));
  });

  it('prefers the response\'s own total over the stretch it would compute', () => {
    // One drawer means the drawer is the whole response, and the authority's
    // measurement of it beats a union of the rows this client happens to hold.
    const collapsed = collapseSettledWorkIntoAccordion([
      thinking('thought-one', {
        workSpans: [{ startedAtMs: 1_000_000, endedAtMs: 1_009_000 }],
      }),
      answer('turn-1'),
    ]);

    expect(collapsed[0]!.workAccordion?.durationMs).toBe(2_477_000);
  });

  it('carries an unknown total and a recovered accuracy through to the drawer', () => {
    const collapsed = collapseSettledWorkIntoAccordion([
      thinking('thought-one'),
      answer('turn-1', { workSummary: { durationMs: null, timingAccuracy: 'upper_bound' } }),
    ]);

    expect(collapsed[0]!.workAccordion?.durationMs).toBeNull();
    expect(collapsed[0]!.workAccordion?.timingAccuracy).toBe('upper_bound');
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
