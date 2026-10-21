import { ErrorNoticeProvider } from '@rally/ui/components/error-notice';
import "../../../../../tests/isolated-region";
import { createRef } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as Tooltip from '@radix-ui/react-tooltip';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesktopSession } from '../../common/desktop';
import type { ElicitationData, HarnessRunMetadata, Message, WorkspaceMember, WorkstreamDetail, WorkstreamResource } from '../lib/types';
import { ApiError } from '../lib/api';
import {
  AddParticipantDialog,
  AddResourceDialog,
  acceptedMessageOverlayDeliveryState,
  branchProvenance,
  conversationReadAcknowledgement,
  highestVisibleAttentionSequence,
  initialTranscriptAnchorIndex,
  manualElicitationResponse,
  RunFailureNotice,
  orderedTranscriptOwnsRunTiming,
  WorkstreamErrorState,
  workstreamPayloadBelongsToRoute,
  workstreamPresenceViewers,
  workstreamRunTiming,
  workstreamShowsReadyState,
  resourceVersionsQueryKey,
  railChildrenWithAttention,
  workspaceMemberFromSession,
} from './workstream';
import { conversationActivityRow, conversationShowsStoppingRow, NO_STOP_ACKNOWLEDGEMENT, nextStopAcknowledgement, refusalMessage, RemoveParticipantDialog } from './conversation-surface';
import { JumpToLatestButton } from '../components/conversation-follow';
import { WorkstreamComposer } from '../components/workstream-composer';

describe('organization foreground presence', () => {
  const member = (id: string, name: string): WorkspaceMember => ({
    id,
    name,
    email: `${id}@example.test`,
    timezone: 'America/Los_Angeles',
  });

  it('resolves non-participant viewers from WorkspaceDO presence instead of feed subscribers', () => {
    const participant = member('participant', 'Participant');
    const viewer = member('viewer', 'Viewer');
    const offline = member('offline', 'Offline');

    expect(workstreamPresenceViewers(
      [participant],
      [participant, viewer, offline],
      [participant.id, viewer.id],
    )).toEqual([{ ...viewer, viewing: true }]);
  });
});

describe('a resource history follows swaps the rail did not make', () => {
  it('keys the history on the version the detail shows, not on the resource alone', () => {
    // An agent republish or a watch-driven re-ingest arrives over the socket
    // and advances `currentVersion` without this cache being touched. Keyed on
    // the id alone, the rail then shows a history missing its newest entry
    // while presenting itself as the whole record.
    expect(resourceVersionsQueryKey('resource-1', 3))
      .not.toEqual(resourceVersionsQueryKey('resource-1', 4));
    expect(resourceVersionsQueryKey('resource-1', 3))
      .toEqual(resourceVersionsQueryKey('resource-1', 3));
    expect(resourceVersionsQueryKey('resource-1', 3))
      .not.toEqual(resourceVersionsQueryKey('resource-2', 3));
  });

  it('is a stable key while nothing is inspected', () => {
    expect(resourceVersionsQueryKey(null, null)).toEqual(resourceVersionsQueryKey(null, null));
  });
});

describe('channel route handoff', () => {
  it('refuses to paint detail or transcript rows retained from another channel', () => {
    const routeWorkstreamId = 'workstream-two';
    const workstream = { id: routeWorkstreamId };
    const transcript = {
      snapshotId: 'snapshot-route', snapshotThrough: 0, eventSequence: 0,
      snapshotAtUtc: '2026-08-27T12:00:00.000Z', unreadAnchorSequence: null,
      unreadReason: 'no_unread' as const, ranges: [], activities: [], activeActivities: [], pluginRuns: [], activeTurns: [], pendingInputs: [],
    };

    expect(workstreamPayloadBelongsToRoute(routeWorkstreamId, workstream, transcript)).toBe(true);
    expect(workstreamPayloadBelongsToRoute(routeWorkstreamId, { id: 'workstream-one' }, transcript)).toBe(false);
    expect(workstreamPayloadBelongsToRoute(routeWorkstreamId, workstream, undefined)).toBe(false);
  });
});

const copyText = vi.hoisted(() => vi.fn());
const getRuntimeConfig = vi.hoisted(() => vi.fn());
const getApplicationSettings = vi.hoisted(() => vi.fn(async () => ({ debugEnabled: false })));
const onApplicationSettingsChanged = vi.hoisted(() => vi.fn(() => () => undefined));

vi.mock('../lib/platform', () => ({
  desktopBridge: () => ({
    copyText,
    getRuntimeConfig,
    getApplicationSettings,
    onApplicationSettingsChanged,
  }),
  desktopServicesAvailable: () => false,
}));

const headerWorkstream: WorkstreamDetail = {
  id: 'workstream-header',
  title: 'Daily product brief',
  titleStatus: 'settled' as const,
  harnessStatus: 'completed',
  scope: 'workspace',
  lastActivityAt: '2026-08-07T12:00:00.000Z',
  latestAttentionSequenceNumber: 0,
  readThroughSequenceNumber: 0,
  manualUnreadFromSequenceNumber: null,
  manualUnreadGeneration: 0,
  hasUnread: false,
  firstUnreadSequenceNumber: null,
  nextPendingWakeup: null,
  pinPosition: null,
  participantUserIds: [],
  participantExtraCount: 0,
  spaceIds: [],
  createdAt: '2026-08-07T12:00:00.000Z',
  participants: [],
  viewers: [],
  resources: [],
  connections: [],
  backgroundTasks: [],
};

describe('Channel rail attention from projected conversations', () => {
  it('badges an unopened sibling and a guest-visible sibling independently of the selected detail', () => {
    const rows = railChildrenWithAttention([
      { substreamId: 'selected', harnessStatus: 'completed' as const, unreadCount: 0 },
      { substreamId: 'member-sibling', youAreMentioned: true },
      { substreamId: 'guest-sibling', needsAttention: true },
    ], 'selected', { ...headerWorkstream, hasUnread: true });
    expect(rows?.map((row) => row.needsAttention)).toEqual([false, true, true]);
  });

  it('uses the latest projected viewer state for the selected Breakout and normalizes idle runs', () => {
    const detail = { ...headerWorkstream, hasUnread: false, youAreMentioned: false };
    expect(railChildrenWithAttention([
      { substreamId: 'selected', harnessStatus: 'idle' as const, unreadCount: 1 },
      { substreamId: 'quiet', harnessStatus: 'idle' as const },
    ], 'selected', detail)?.map((row) => row.needsAttention)).toEqual([true, false]);
    expect(railChildrenWithAttention([{ substreamId: 'selected' }], 'selected', {
      ...headerWorkstream, hasUnread: true,
    })?.[0]?.needsAttention).toBe(true);
    expect(railChildrenWithAttention([{ substreamId: 'selected', needsAttention: true }], 'selected', detail)?.[0]?.needsAttention)
      .toBe(false);
  });
});

describe('Channel rail questions from projected conversations', () => {
  it('flags a Breakout waiting on an answer, preferring the open detail over its row', () => {
    const rows = railChildrenWithAttention([
      { substreamId: 'asking', harnessStatus: 'needs_input' as const },
      { substreamId: 'answered', harnessStatus: 'needs_input' as const },
      { substreamId: 'quiet', harnessStatus: 'completed' as const },
      { substreamId: 'guest', needsAttention: true },
    ], 'answered', { ...headerWorkstream, harnessStatus: 'running' });
    expect(rows?.map((row) => row.needsInput)).toEqual([true, false, false, false]);
  });
});

describe('running channel message delivery', () => {
  it('keeps accepted pending messages visibly pending until canonical promotion', () => {
    expect(acceptedMessageOverlayDeliveryState('pending', 'steer')).toBe('steer_pending');
    expect(acceptedMessageOverlayDeliveryState('pending', 'queue')).toBe('queue_pending');
    expect(acceptedMessageOverlayDeliveryState('pending', undefined)).toBe('queue_pending');
    expect(acceptedMessageOverlayDeliveryState('canonical', 'queue')).toBeUndefined();
  });

  it('delivers a message at the running loop safe boundary without a delivery dropdown', async () => {
    const onSend = vi.fn(async () => undefined);
    render(
      <MemoryRouter>
        <Tooltip.Provider>
          <WorkstreamComposer
            draftKey="test-draft"
            attachments={[]}
            fileInputRef={createRef<HTMLInputElement>()}
            members={[]}
            onAttach={vi.fn()}
            onOpenAttachment={vi.fn()}
            onRemoveAttachment={vi.fn()}
            onRetryAttachment={vi.fn()}
            onSend={onSend}
            onStop={vi.fn(async () => undefined)}
            sending={false}
            uploading={false}
            workstream={{ ...headerWorkstream, harnessStatus: 'running' }}
          />
        </Tooltip.Provider>
      </MemoryRouter>,
    );

    expect(screen.queryByRole('combobox', { name: 'Message delivery' })).not.toBeInTheDocument();
    const composer = screen.getByRole('textbox', { name: 'Message the thread' });
    fireEvent.change(composer, { target: { value: 'Add this context to the current conversation' } });
    fireEvent.keyDown(composer, { key: 'Enter' });

    await waitFor(() => expect(onSend).toHaveBeenCalledWith(
      'Add this context to the current conversation',
      [],
      undefined,
      'steer',
    ));
  });
});

const transcript: Message[] = [
  {
    id: 'message-one',
    workstreamId: 'workstream-one',
    sequenceNumber: 1,
    attentionSequenceNumber: 1,
    authorType: 'human',
    messageType: 'text',
    text: 'Start',
    createdAt: '2026-08-01T00:00:00.000Z',
  },
  {
    id: 'message-two',
    workstreamId: 'workstream-one',
    sequenceNumber: 2,
    attentionSequenceNumber: null,
    authorType: 'agent',
    messageType: 'tool_event',
    createdAt: '2026-08-01T00:00:01.000Z',
  },
  {
    id: 'message-three',
    workstreamId: 'workstream-one',
    sequenceNumber: 3,
    attentionSequenceNumber: 2,
    authorType: 'agent',
    messageType: 'text',
    text: 'Done',
    createdAt: '2026-08-01T00:00:02.000Z',
  },
];

describe('transcript read positioning', () => {
  it('opens one message before the first unread sequence to preserve context', () => {
    expect(initialTranscriptAnchorIndex(transcript, 2)).toBe(1);
    expect(initialTranscriptAnchorIndex(transcript, 1)).toBe(0);
    expect(initialTranscriptAnchorIndex(transcript, null)).toBeNull();
  });

  it('acknowledges visible attention messages but ignores tool and transient rows', () => {
    expect(highestVisibleAttentionSequence(transcript, [0, 1], 2)).toBe(1);
    expect(highestVisibleAttentionSequence(transcript, [1, 2], 2)).toBe(2);
    expect(highestVisibleAttentionSequence([
      ...transcript,
      { ...transcript[2]!, id: 'transient', sequenceNumber: 4, attentionSequenceNumber: null },
    ], [3], 2)).toBe(0);
  });

  it('does not acknowledge a settled run\'s accordion, which is machinery', () => {
    // It carries its turn's ordinal so the unread divider lands above it rather
    // than between it and its answer — but scrolling it into view, or scrolling
    // through an open one, says nothing about having read that answer.
    expect(highestVisibleAttentionSequence([
      ...transcript,
      {
        ...transcript[2]!, id: 'work-accordion', sequenceNumber: 4,
        messageType: 'work_accordion' as const, attentionSequenceNumber: 2,
      },
    ], [3], 2)).toBe(0);
  });
});

describe('the read a conversation acknowledges', () => {
  const viewer = {
    readThroughSequenceNumber: 1,
    manualUnreadFromSequenceNumber: null,
    manualUnreadGeneration: 0,
  };

  it('acknowledges a private breakout against itself, not against its parent', () => {
    // The waterline is the child object's own, and a child's ordinals are
    // deliberately not comparable to Main's. While this was a work stream's
    // fact the child's read went unrecorded, so the divider the child had
    // drawn from its own unread waterline stayed above the reply being read.
    expect(conversationReadAcknowledgement({
      parentId: 'workstream-one',
      substreamId: 'substream-two',
      highestVisibleSequence: 4,
      viewer,
    })).toEqual({
      parentId: 'workstream-one',
      substreamId: 'substream-two',
      readThroughSequenceNumber: 4,
      observedManualUnreadGeneration: 0,
      key: 'workstream-one:substream-two:4:0',
    });
  });

  it('keeps two children of one channel on two keys', () => {
    // The in-flight key is what suppresses a duplicate request. Naming only
    // the work stream would call one child's read the other's.
    const shared = { parentId: 'workstream-one', highestVisibleSequence: 4, viewer };
    expect(conversationReadAcknowledgement({ ...shared, substreamId: 'substream-two' })?.key)
      .not.toBe(conversationReadAcknowledgement({ ...shared, substreamId: 'substream-three' })?.key);
  });

  it('sends nothing when the room already knows everything on screen was read', () => {
    expect(conversationReadAcknowledgement({
      parentId: 'workstream-one', substreamId: '0', highestVisibleSequence: 1, viewer,
    })).toBeNull();
    // Nothing that asks for attention is on screen at all.
    expect(conversationReadAcknowledgement({
      parentId: 'workstream-one', substreamId: '0', highestVisibleSequence: 0, viewer,
    })).toBeNull();
  });

  it('still acknowledges an already-read position while a manual mark stands', () => {
    // Marking unread by hand is retired by the next acknowledgement, so a
    // waterline that is already past what is visible is not a reason to stay
    // quiet. The generation travels so the room can refuse a stale retirement.
    expect(conversationReadAcknowledgement({
      parentId: 'workstream-one',
      substreamId: '0',
      highestVisibleSequence: 1,
      viewer: { ...viewer, manualUnreadFromSequenceNumber: 1, manualUnreadGeneration: 3 },
    })).toMatchObject({ readThroughSequenceNumber: 1, observedManualUnreadGeneration: 3 });
  });
});

const openElicitation: ElicitationData = {
  id: 'elicitation-one',
  prompt: 'What should Rally do?',
  responseType: 'single_select',
  options: [{ label: 'Review it', value: 'review' }],
  minimumSelections: 1,
  maximumSelections: 1,
  status: 'open',
};

const harnessRun: HarnessRunMetadata = {
  id: 'run-one',
  origin: 'message',
  status: 'running',
  startedAt: '2026-08-05T12:00:00.000Z',
  createdAt: '2026-08-05T11:59:59.000Z',
};

describe('workstreamRunTiming', () => {
  it('adapts the current harness run to the shared live work timer', () => {
    expect(workstreamRunTiming('running', harnessRun)).toEqual({
      active: true,
      durationMs: 0,
      startedAt: Date.parse('2026-08-05T12:00:00.000Z'),
    });
  });

  it('retains the canonical elapsed time after the turn completes', () => {
    expect(workstreamRunTiming('completed', {
      ...harnessRun,
      status: 'completed',
      completedAt: '2026-08-05T12:01:23.000Z',
    })).toEqual({ active: false, durationMs: 83_000 });
  });

  it('does not describe a run awaiting input as completed work', () => {
    expect(workstreamRunTiming('needs_input', {
      ...harnessRun,
      status: 'needs_input',
    })).toBeNull();
  });
});

describe('workstreamShowsReadyState', () => {
  it('never invites another start while a newly created run is admitted or running', () => {
    expect(workstreamShowsReadyState(0, false, 'scheduled')).toBe(false);
    expect(workstreamShowsReadyState(0, false, 'running')).toBe(false);
    expect(workstreamShowsReadyState(0, false, 'completed')).toBe(true);
    expect(workstreamShowsReadyState(1, false, 'completed')).toBe(false);
    expect(workstreamShowsReadyState(0, true, 'completed')).toBe(false);
  });
});

describe('orderedTranscriptOwnsRunTiming', () => {
  it('replaces the legacy timer only after the canonical response timing has an ordered turn anchor', () => {
    const snapshot: NonNullable<Parameters<typeof orderedTranscriptOwnsRunTiming>[0]> = {
      activities: [
        { activityId: 'run-one:activity', parentActivityId: null, scope: 'response', subjectId: 'run-one' },
        {
          activityId: 'run-one:turn:1:activity',
          parentActivityId: 'run-one:activity',
          scope: 'assistant_turn',
          subjectId: 'run-one:turn:1',
        },
      ],
      ranges: [],
      activeTurns: [],
    };

    expect(orderedTranscriptOwnsRunTiming(snapshot, 'run-one')).toBe(false);
    snapshot.ranges = [{
      turns: [{ activityId: 'run-one:turn:1:activity' }],
    }];
    expect(orderedTranscriptOwnsRunTiming(snapshot, 'run-one')).toBe(true);
    expect(orderedTranscriptOwnsRunTiming(snapshot, 'run-two')).toBe(false);
    expect(orderedTranscriptOwnsRunTiming(undefined, 'run-one')).toBe(false);
  });
});

describe('conversationShowsStoppingRow', () => {
  it('acknowledges a stop only while the run it would be waiting on is live', () => {
    expect(conversationShowsStoppingRow('running', true)).toBe(true);
    expect(conversationShowsStoppingRow('running', false)).toBe(false);
    expect(conversationShowsStoppingRow('running', undefined)).toBe(false);
    // The loop clears `stop_requested_at` as it goes idle, but a settled run
    // can still be read back before the next snapshot lands. A stopping row
    // over a run that has already stopped promises a wait that is over.
    expect(conversationShowsStoppingRow('stopped', true)).toBe(false);
    expect(conversationShowsStoppingRow('completed', true)).toBe(false);
  });
});

describe('nextStopAcknowledgement', () => {
  const live = { id: 'run-one', status: 'running' as const };
  const stopped = { id: 'run-one', status: 'stopped' as const };
  const held = { runId: 'run-one', pendingRunId: null };

  it('holds the arming across the wait, which is the whole of the mechanism', () => {
    // Between the request and the settlement the run still reads `running`.
    // An arming that cleared itself the moment it found nothing to say would
    // be gone by the time the run settled, which is exactly what it exists to
    // survive — and what the first version of this got wrong.
    const asked = nextStopAcknowledgement(NO_STOP_ACKNOWLEDGEMENT, 'running', true, live);
    expect(asked).toEqual({ runId: null, pendingRunId: 'run-one' });
    // Three passes, not two: `applyHarnessStatus` clears `stopRequested` on a
    // status frame while the run is still going, so the pass in the middle
    // carries neither the request nor the settlement. An arming read from the
    // request alone survives a two-pass test and dies here.
    const waiting = nextStopAcknowledgement(asked, 'running', false, live);
    expect(waiting).toEqual({ runId: null, pendingRunId: 'run-one' });
    expect(nextStopAcknowledgement(waiting, 'stopped', false, stopped)).toEqual(held);
  });

  it('survives a status frame that cannot say a stop was a stop', () => {
    // The sequence a real member stop actually produces. A stop leaves the
    // work stream `idle` — `settleWorkstreamState` calls that the member
    // taking the conversation back rather than an outcome — and this client
    // reads `idle` as `completed`, so the frame that ends the wait looks
    // exactly like an ordinary finish. Only the run row behind it says which
    // it was. An arming cleared on that frame is gone a beat before its own
    // evidence arrives, and the acknowledgement never appears at all.
    const asked = nextStopAcknowledgement(NO_STOP_ACKNOWLEDGEMENT, 'running', true, live);
    const quiet = nextStopAcknowledgement(asked, 'completed', false, live);
    expect(quiet).toEqual({ runId: null, pendingRunId: 'run-one' });
    expect(nextStopAcknowledgement(quiet, 'completed', false, stopped)).toEqual(held);
  });

  it('says so the moment the status frame lands, not when the snapshot does', () => {
    // `harness_status_changed` writes the status and leaves `latestHarnessRun`
    // to a separate snapshot round trip. Read from the run row alone the dock
    // goes blank for the length of that trip — and stays blank for good if the
    // socket reconnects instead of the snapshot landing, which loses the
    // acknowledgement for somebody who watched the whole stop.
    const asked = nextStopAcknowledgement(NO_STOP_ACKNOWLEDGEMENT, 'running', true, live);
    const onTheFrame = nextStopAcknowledgement(asked, 'stopped', false, live);
    // Acknowledged already, and still armed: the run row has not settled yet,
    // so the arming stays up until the evidence behind the frame arrives.
    expect(onTheFrame).toEqual({ runId: 'run-one', pendingRunId: 'run-one' });
    // And the snapshot behind it does not take the row away again. The status
    // no longer says `stopped` by then: `settleWorkstreamState` leaves a
    // stopped run's work stream `idle`, which this client reads as
    // `completed`, so the run row is what says it from here on.
    expect(nextStopAcknowledgement(onTheFrame, 'completed', false, stopped)).toEqual(held);
  });

  it('will not let one run\u2019s arming answer for another', () => {
    // `applyHarnessStatus` clears `stopRequested` from the status event and
    // leaves `latestHarnessRun` to the canonical snapshot behind it, so a
    // snapshot that lands already carrying the next run reaches this with the
    // arm still up. Carried onto that run, it would say "Run stopped" as the
    // settlement of a request nobody made for it.
    const asked = nextStopAcknowledgement(NO_STOP_ACKNOWLEDGEMENT, 'running', true, live);
    const next = nextStopAcknowledgement(asked, 'running', false, { id: 'run-two', status: 'running' });
    expect(next).toEqual(NO_STOP_ACKNOWLEDGEMENT);
    expect(nextStopAcknowledgement(next, 'stopped', false, { id: 'run-two', status: 'stopped' }))
      .toEqual(NO_STOP_ACKNOWLEDGEMENT);
  });

  it('withdraws it the moment the conversation is working again', () => {
    // The same skew, in the direction that shows. The status event moves
    // first and the run row follows a snapshot later, so a held
    // acknowledgement would otherwise sit in the dock saying the run stopped
    // while the feed above it shows an agent visibly working — and would stay
    // there for as long as the snapshot took, or for good if it never landed.
    for (const status of ['running', 'scheduled', 'needs_input'] as const) {
      expect(nextStopAcknowledgement(held, status, false, stopped)).toEqual(NO_STOP_ACKNOWLEDGEMENT);
    }
  });

  it('keeps saying so until the conversation has another run to describe', () => {
    expect(nextStopAcknowledgement(held, 'completed', false, stopped)).toEqual(held);
    expect(nextStopAcknowledgement(held, 'stopped', false, { id: 'run-two', status: 'stopped' }))
      .toEqual(NO_STOP_ACKNOWLEDGEMENT);
    expect(nextStopAcknowledgement(held, 'completed', false, null)).toEqual(NO_STOP_ACKNOWLEDGEMENT);
    expect(nextStopAcknowledgement(held, 'completed', false, undefined)).toEqual(NO_STOP_ACKNOWLEDGEMENT);
  });

  it('says nothing to a reader who was not there', () => {
    // The status on the row is permanent, so opening a conversation stopped
    // last week would otherwise greet them with an answer to a button press
    // they never made — and, in a room where people talk to each other, keep
    // it on screen under every later message, because a turn the addressing
    // classifier reads as human-only starts no run to replace it.
    expect(nextStopAcknowledgement(NO_STOP_ACKNOWLEDGEMENT, 'stopped', false, stopped))
      .toEqual(NO_STOP_ACKNOWLEDGEMENT);
  });

  it('drops the arming on a run that ended some other way', () => {
    const asked = { runId: null, pendingRunId: 'run-one' };
    expect(nextStopAcknowledgement(asked, 'completed', false, { id: 'run-one', status: 'completed' }))
      .toEqual(NO_STOP_ACKNOWLEDGEMENT);
    expect(nextStopAcknowledgement(asked, 'failed', false, { id: 'run-one', status: 'failed' }))
      .toEqual(NO_STOP_ACKNOWLEDGEMENT);
  });
});

describe('conversationActivityRow', () => {
  const running = {
    status: 'running' as const,
    compactingThisRun: false,
    orderedOwnsRunTiming: false,
    runTiming: { active: true, durationMs: 0, startedAt: Date.parse('2026-08-05T12:00:00.000Z') },
  };

  it('prefers compaction over the elapsed total, and only for a live run', () => {
    expect(conversationActivityRow({ ...running, compactingThisRun: true }))
      .toEqual({ kind: 'compacting' });
    // The answer carries the props it was decided from, so the call site has
    // nothing left to assert back.
    expect(conversationActivityRow(running)).toEqual({ kind: 'timing', timing: running.runTiming });
    expect(conversationActivityRow({
      ...running,
      status: 'completed',
      compactingThisRun: true,
      runTiming: { active: false, durationMs: 83_000 },
    })).toEqual({ kind: 'timing', timing: { active: false, durationMs: 83_000 } });
  });

  it('leaves the elapsed total to the feed once the ordered transcript draws it', () => {
    expect(conversationActivityRow({ ...running, orderedOwnsRunTiming: true })).toBeNull();
    expect(conversationActivityRow({ ...running, runTiming: null })).toBeNull();
  });
});

describe('manualElicitationResponse', () => {
  it('turns a composer entry into a custom single-select response', () => {
    expect(manualElicitationResponse(openElicitation, '  Take a closer look  ')).toEqual({
      answer: 'Take a closer look',
      customResponse: 'Take a closer look',
    });
  });

  it('wraps a custom multi-select response and leaves text responses as text', () => {
    expect(manualElicitationResponse({ ...openElicitation, responseType: 'multi_select' }, 'Summarize both')).toEqual({
      answer: ['Summarize both'],
      customResponse: 'Summarize both',
    });
    expect(manualElicitationResponse({ ...openElicitation, responseType: 'text' }, 'Explain the risk')).toEqual({
      answer: 'Explain the risk',
    });
  });
});

describe('WorkstreamErrorState', () => {
  beforeEach(() => {
    copyText.mockReset();
    copyText.mockResolvedValue(undefined);
  });

  it('offers the channel ID from a More menu so an unopenable channel can still be reported', async () => {
    const onRetry = vi.fn();
    render(
      <Tooltip.Provider>
        <WorkstreamErrorState description="An unexpected error occurred" onRetry={onRetry} workstreamId="workstream-unopenable" />
      </Tooltip.Provider>,
    );

    expect(screen.getByText('Thread could not be opened')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledOnce();

    fireEvent.pointerDown(screen.getByRole('button', { name: 'More thread actions' }), {
      button: 0,
      ctrlKey: false,
    });
    const items = await screen.findAllByRole('menuitem');
    expect(items.map((item) => item.textContent?.trim())).toEqual(['Copy thread ID']);

    fireEvent.click(items[0]!);
    expect(copyText).toHaveBeenCalledWith('workstream-unopenable');
  });
});

describe('JumpToLatestButton', () => {
  it('is compact and icon-only while retaining an accessible action name', () => {
    const onJump = vi.fn();
    render(
      <Tooltip.Provider>
        <JumpToLatestButton onJump={onJump} />
      </Tooltip.Provider>,
    );

    const button = screen.getByRole('button', { name: 'Jump to latest' });
    expect(button).not.toHaveTextContent('Latest');
    fireEvent.click(button);
    expect(onJump).toHaveBeenCalledOnce();
  });
});

describe('RunFailureNotice', () => {
  it('shows a typed member-safe error, the request id beside its copy control, and retry', async () => {
    copyText.mockReset();
    copyText.mockResolvedValue(undefined);
    const onRetry = vi.fn();
    render(
      <Tooltip.Provider>
        <RunFailureNotice
          code="context_limit_exceeded"
          message="The run exceeded the model context window."
          onRetry={onRetry}
          requestId="run-request-123"
          retrying={false}
        />
      </Tooltip.Provider>,
      { wrapper: ErrorNoticeProvider },
    );

    expect(screen.getByRole('alertdialog')).toHaveTextContent('The run exceeded the model context window.');
    expect(screen.getByRole('alertdialog')).toHaveTextContent('context_limit_exceeded');
    // The id is on screen, so the icon beside it is about something.
    expect(screen.getByRole('alertdialog')).toHaveTextContent('run-request-123');
    fireEvent.click(screen.getByRole('button', { name: 'Copy request ID' }));
    await waitFor(() => expect(copyText).toHaveBeenCalledWith('run-request-123'));
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('prevents a duplicate retry while the retry request is pending', () => {
    render(
      <RunFailureNotice
        code="provider_timeout"
        message="The provider timed out."
        onRetry={vi.fn()}
        retrying
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    expect(screen.getByRole('button', { name: 'Retry' })).toBeDisabled();
  });
});

describe('RemoveParticipantDialog', () => {
  const jordan = { id: 'member-2', name: 'Jordan', email: 'jordan@example.com', timezone: 'UTC' };

  it('names who is being removed and removes only on Continue', () => {
    const onContinue = vi.fn();
    const onCancel = vi.fn();
    render(
      <Tooltip.Provider>
        <RemoveParticipantDialog member={jordan} noun="breakout" onCancel={onCancel} onContinue={onContinue} pending={false} self={false} />
      </Tooltip.Provider>,
    );

    expect(screen.getByRole('heading', { name: 'Remove Jordan from the breakout?' })).toBeTruthy();
    expect(screen.getByText('Jordan will be taken off this breakout. They keep access only if it’s public.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalled();
    expect(onContinue).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it('asks the reader whether to leave when they chose themselves, and shows a refusal in place', () => {
    render(
      <Tooltip.Provider>
        <RemoveParticipantDialog failure="You are the last participant." member={jordan} noun="thread" onCancel={vi.fn()} onContinue={vi.fn()} pending={false} self />
      </Tooltip.Provider>,
    );

    expect(screen.getByRole('alertdialog')).toHaveTextContent('You are the last participant.');
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    expect(screen.getByRole('heading', { name: 'Leave the thread?' })).toBeTruthy();
    expect(screen.getByText('You will be taken off this thread. You keep access only if it’s public.')).toBeTruthy();
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('is closed while nobody is chosen', () => {
    render(<RemoveParticipantDialog member={undefined} noun="thread" onCancel={vi.fn()} onContinue={vi.fn()} pending={false} self={false} />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('AddParticipantDialog', () => {
  const member = (id: string, name: string, status?: 'active' | 'invited' | 'suspended') => ({
    id,
    name,
    email: `${name.toLowerCase()}@example.com`,
    timezone: 'UTC',
    ...(status ? { status } : {}),
  });

  it('offers Organization invitees after the members and shares by address when one is added', () => {
    const onInvite = vi.fn();
    render(
      <Tooltip.Provider>
        <AddParticipantDialog
          current={[]}
          invitees={['dana@example.com']}
          members={[member('member-1', 'Adam', 'active')]}
          onAdd={vi.fn()}
          onInvite={onInvite}
          onRemove={vi.fn()}
          onOpenChange={vi.fn()}
          open
          pending={false}
        />
      </Tooltip.Provider>,
    );

    const invitee = screen.getByRole('button', { name: 'Add dana@example.com to main conversation' });
    expect(invitee).toHaveTextContent('Invited');
    fireEvent.click(invitee);
    expect(onInvite).toHaveBeenCalledWith('dana@example.com');
  });

  it('shows why an add was refused instead of leaving the dialog looking idle', () => {
    render(
      <Tooltip.Provider>
        <AddParticipantDialog
          current={[]}
          failure="add"
          members={[member('member-1', 'Adam', 'active')]}
          onAdd={vi.fn()}
          onRemove={vi.fn()}
          onOpenChange={vi.fn()}
          open
          pending={false}
        />
      </Tooltip.Provider>,
    );

    expect(screen.getByText('That participant couldn’t be added.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    // The list stays usable: the refusal is about one attempt, not the dialog.
    expect(screen.getByRole('button', { name: /Adam/u })).toBeTruthy();
  });

  it('says the server\'s own reason for a refusal when it gave one', () => {
    const refusal = new ApiError('This substream is archived. Restore it before changing who is in it.', 409, 'substream_archived');
    render(
      <Tooltip.Provider>
        <AddParticipantDialog
          current={[]}
          failure="add"
          failureMessage={refusalMessage(refusal)}
          members={[member('member-1', 'Adam', 'active')]}
          onAdd={vi.fn()}
          onRemove={vi.fn()}
          onOpenChange={vi.fn()}
          open
          pending={false}
        />
      </Tooltip.Provider>,
    );

    expect(screen.getByText('This substream is archived. Restore it before changing who is in it.')).toBeTruthy();
    expect(screen.queryByText('That participant couldn’t be added.')).toBeNull();
  });

  it('labels a guest participant as a Guest, and nobody else', () => {
    const guest = { ...member('guest-1', 'Gale', 'active'), accessClass: 'guest' as const };
    const teammate = member('member-1', 'Adam', 'active');
    render(
      <Tooltip.Provider>
        <AddParticipantDialog
          current={[guest, teammate]}
          members={[guest, teammate]}
          onAdd={vi.fn()}
          onRemove={vi.fn()}
          onOpenChange={vi.fn()}
          open
          pending={false}
        />
      </Tooltip.Provider>,
    );

    const rows = screen.getAllByText(/@example\.com/u).map((email) => email.closest('.member-action-row')!);
    expect(rows.find((row) => row.textContent?.includes('Gale'))?.textContent).toContain('Guest');
    expect(rows.find((row) => row.textContent?.includes('Adam'))?.textContent).not.toContain('Guest');
  });

  it('keeps the generic sentence for a failure the server did not word', () => {
    expect(refusalMessage(new ApiError('Request failed with status 409', 409))).toBeUndefined();
    expect(refusalMessage(new ApiError('Upstream exploded', 502, 'internal_error'))).toBeUndefined();
    expect(refusalMessage(new Error('offline'))).toBeUndefined();
  });

  it('offers only active memberships, because the endpoint refuses the rest', () => {
    const onAdd = vi.fn();
    render(
      <Tooltip.Provider>
        <AddParticipantDialog
          current={[]}
          members={[
            member('member-1', 'Adam', 'active'),
            member('member-2', 'Invited', 'invited'),
            member('member-3', 'Suspended', 'suspended'),
          ]}
          onAdd={onAdd}
          onRemove={vi.fn()}
          onOpenChange={vi.fn()}
          open
          pending={false}
        />
      </Tooltip.Provider>,
    );

    expect(screen.getByRole('button', { name: /Adam/u })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Invited/u })).toBeNull();
    expect(screen.queryByRole('button', { name: /Suspended/u })).toBeNull();
  });

  it('keeps a person whose status the caller did not resolve', () => {
    // Participants and viewers reach this dialog without a status; treating a
    // missing one as inactive would empty the list for every caller but the
    // workspace roster.
    render(
      <Tooltip.Provider>
        <AddParticipantDialog
          current={[]}
          members={[member('member-1', 'Unstated')]}
          onAdd={vi.fn()}
          onRemove={vi.fn()}
          onOpenChange={vi.fn()}
          open
          pending={false}
        />
      </Tooltip.Provider>,
    );

    expect(screen.getByRole('button', { name: /Unstated/u })).toBeTruthy();
  });

  it('shows participants beside addable members and gives participants a destructive menu', () => {
    const adam = member('member-1', 'Adam', 'active');
    const katherine = member('member-2', 'Katherine', 'active');
    const suspendedKatherine = member('member-2', 'Katherine', 'suspended');
    const jordan = member('member-3', 'Jordan', 'active');
    const onAdd = vi.fn();
    const onRemove = vi.fn();
    render(
      <Tooltip.Provider>
        <AddParticipantDialog
          current={[adam, katherine]}
          members={[adam, suspendedKatherine, jordan]}
          onAdd={onAdd}
          onRemove={onRemove}
          onOpenChange={vi.fn()}
          open
          pending={false}
        />
      </Tooltip.Provider>,
    );

    expect(screen.getByRole('button', { name: 'Add Jordan to main conversation' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Katherine participant actions' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Add Adam to main conversation' })).not.toBeInTheDocument();

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Adam participant actions' }), {
      button: 0,
      ctrlKey: false,
    });
    const remove = screen.getByRole('menuitem', { name: 'Remove from main conversation' });
    expect(remove).toHaveClass('menu-item-danger');
    fireEvent.click(remove);
    expect(onRemove).toHaveBeenCalledWith(adam);

    // The whole nonparticipant row remains the add target; only an existing
    // participant's row delegates its action to the ellipsis control.
    fireEvent.click(screen.getByText('Jordan'));
    expect(onAdd).toHaveBeenCalledWith(jordan);
  });

  it('keeps the final participant visible but disables removing them', () => {
    const adam = member('member-1', 'Adam', 'active');
    render(
      <Tooltip.Provider>
        <AddParticipantDialog
          current={[adam]}
          members={[adam]}
          onAdd={vi.fn()}
          onRemove={vi.fn()}
          onOpenChange={vi.fn()}
          open
          pending={false}
        />
      </Tooltip.Provider>,
    );

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Adam participant actions' }), {
      button: 0,
      ctrlKey: false,
    });
    expect(screen.getByRole('menuitem', { name: 'Remove from main conversation' }))
      .toHaveAttribute('data-disabled');
  });
});

describe('AddResourceDialog', () => {
  it.each([
    ['load', 'Resources couldn’t be loaded.'],
    ['attach', 'That resource couldn’t be added.'],
  ] as const)('owns stable copy for a %s failure', (failure, copy) => {
    render(
      <Tooltip.Provider>
        <AddResourceDialog
          current={[]}
          failure={failure}
          fetching={false}
          hasMore={false}
          loading={false}
          onAttach={vi.fn()}
          onLoadMore={vi.fn()}
          onOpenChange={vi.fn()}
          onSearchChange={vi.fn()}
          onUpload={vi.fn()}
          open
          pending={false}
          resources={[]}
          search=""
        />
      </Tooltip.Provider>,
    );
    expect(screen.getByText(copy)).toBeVisible();
  });

  it('searches and attaches discovered connector resources while retaining upload fallback', () => {
    const resource: WorkstreamResource = {
      id: 'resource-1',
      title: 'Rally release pull request',
      resourceType: 'github_pull_request',
      provider: 'github',
      canonicalUrl: 'https://github.com/juno-ai-labs/rally/pull/42',
      refreshSupported: true,
      watchEnabled: false,
      watchStatus: 'paused',
      currentVersion: 1,
      relationshipType: 'attachment',
      direction: 'source',
    };
    const onAttach = vi.fn();
    const onSearchChange = vi.fn();
    const onUpload = vi.fn();
    render(
      <Tooltip.Provider>
        <AddResourceDialog
          current={[]}
          fetching={false}
          hasMore={false}
          loading={false}
          onAttach={onAttach}
          onLoadMore={vi.fn()}
          onOpenChange={vi.fn()}
          onSearchChange={onSearchChange}
          onUpload={onUpload}
          open
          pending={false}
          resources={[resource]}
          search=""
        />
      </Tooltip.Provider>,
    );

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search resources' }), { target: { value: 'release' } });
    expect(onSearchChange).toHaveBeenCalledWith('release');
    fireEvent.click(screen.getByRole('button', { name: /Rally release pull request/u }));
    expect(onAttach).toHaveBeenCalledWith(resource);
    fireEvent.click(screen.getByRole('button', { name: 'Upload file' }));
    expect(onUpload).toHaveBeenCalledOnce();
  });
});

describe('workspaceMemberFromSession', () => {
  it('uses the signed-in person for an optimistic human message in a multiplayer stream', () => {
    const session: DesktopSession = {
      accessToken: 'access-token-longer-than-twenty-characters',
      expiresAt: '2026-07-31T20:00:00.000Z',
      apiBaseUrl: 'https://api.rallywith.ai',
      user: {
        id: 'user-current',
        name: 'Current Person',
        email: 'current@example.com',
        avatarUrl: 'https://example.com/current.png',
      },
      workspace: {
        id: 'workspace-one',
        name: 'Rally',
        region: 'global',
        role: 'member',
      },
    };

    expect(workspaceMemberFromSession(session)).toEqual({
      id: 'user-current',
      name: 'Current Person',
      email: 'current@example.com',
      avatarUrl: 'https://example.com/current.png',
      role: 'member',
      timezone: 'America/Los_Angeles',
    });
  });
});

describe('what a breakout shows of where it came from', () => {
  const turn = (sequence: number): Message => ({
    id: `row-${sequence}`,
    transcriptTurnId: `turn-${sequence}`,
    workstreamId: 'workstream-1',
    sequenceNumber: sequence,
    authorType: 'agent',
    messageType: 'text',
    text: `Main turn ${sequence}`,
    createdAt: '2026-09-09T20:00:00.000Z',
  });
  const transcript = [1, 2, 3, 4, 5, 6, 7].map(turn);

  it('ends at the message that was branched from and reaches five turns back', () => {
    expect(branchProvenance(transcript, 'turn-7').map((message) => message.text))
      .toEqual(['Main turn 3', 'Main turn 4', 'Main turn 5', 'Main turn 6', 'Main turn 7']);
  });

  it('stops at the start of the conversation rather than padding the window', () => {
    expect(branchProvenance(transcript, 'turn-2').map((message) => message.text))
      .toEqual(['Main turn 1', 'Main turn 2']);
  });

  it('shows only text, counting five turns of it past the activity rows between them', () => {
    const activity = (sequence: number, messageType: Message['messageType']): Message => ({
      ...turn(sequence), id: `row-${sequence}-${messageType}`, messageType, text: '',
    });
    const busy: Message[] = [
      turn(1),
      turn(2),
      activity(3, 'thought'),
      activity(3, 'tool_event'),
      turn(3),
      // One answer split over two text rows is one turn.
      { ...turn(3), id: 'row-3-more', text: 'Main turn 3, continued' },
      activity(4, 'tool_event'),
      // A Sidekick's result is written text and counts as a turn.
      { ...turn(4), authorType: 'system', messageType: 'automation_activation', text: 'Sidekick result 4' },
      turn(5),
      // The row the reported bug drew: a settled answer's folded work.
      activity(6, 'work_accordion'),
      turn(6),
      { ...activity(6, 'system'), authorType: 'system', text: 'Ada joined the conversation' },
      turn(7),
    ];
    expect(branchProvenance(busy, 'turn-6').map((message) => message.text))
      .toEqual(['Main turn 2', 'Main turn 3', 'Main turn 3, continued', 'Sidekick result 4', 'Main turn 5', 'Main turn 6']);
  });

  it('shows nothing for a breakout started from the sidebar, or from a turn off the loaded window', () => {
    expect(branchProvenance(transcript, null)).toEqual([]);
    // Not the newest turns: a branch point this client cannot see is provenance
    // it does not have, and the last five turns are a different claim.
    expect(branchProvenance(transcript, 'turn-99')).toEqual([]);
  });
});
