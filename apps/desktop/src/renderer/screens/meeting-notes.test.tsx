import * as Tooltip from '@radix-ui/react-tooltip';
import { CONTROL_TOWER_REFRESH_SECONDS } from '@avalon/contracts';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MeetingCloseReason } from '../../common/desktop';
import {
  appendMeetingSegment,
  DEFAULT_MEETING_NOTES_INTERVAL_MS,
  MEETING_CADENCE_REQUEST_TIMEOUT_MS,
  meetingRecordedMs,
  meetingRefreshCadenceLabel,
  mergeSavedMeetingSegmentDuration,
  MeetingNotesScreen,
  noteIdFromSearch,
} from './meeting-notes';

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  return {
    promise: new Promise<T>((next) => { resolve = next; }),
    resolve,
  };
}

const state = vi.hoisted(() => ({
  api: {
    appendNoteTranscriptSegment: vi.fn(),
    clientFeatureFlags: vi.fn(),
    createNote: vi.fn(),
    generateNoteNotes: vi.fn(),
    getTranscriptionSocketTicket: vi.fn(),
    updateNote: vi.fn(),
  },
  closeMeetingNotes: vi.fn(async () => undefined),
  closeRequested: undefined as undefined | ((reason: MeetingCloseReason) => void),
  copyText: vi.fn(),
  getMeetingAudioPermissions: vi.fn(),
  openMeetingAudioSettings: vi.fn(async () => undefined),
  permissions: { microphone: 'granted', systemAudio: 'granted' } as {
    microphone: 'not-determined' | 'granted' | 'denied' | 'restricted' | 'unknown';
    systemAudio: 'not-determined' | 'granted' | 'denied' | 'restricted' | 'unknown';
  },
  prepareMeetingAudioPermissions: vi.fn(),
  reportTelemetryProductIntent: vi.fn(async () => undefined),
  commit: vi.fn(async () => ''),
  dictationState: 'idle' as 'idle' | 'requesting' | 'connecting' | 'listening' | 'paused' | 'transcribing' | 'finalizing' | 'error',
  dictationWarning: undefined as string | undefined,
  dictationOptions: undefined as undefined | {
    includeSystemAudio?: boolean;
    useSystemDefaultMicrophone?: boolean;
  },
  onTranscript: undefined as undefined | ((transcript: string) => void),
  pause: vi.fn(async () => undefined),
  resume: vi.fn(async () => undefined),
  start: vi.fn(async () => undefined),
  stop: vi.fn(async () => undefined),
  userId: '00000000-0000-4000-8000-000000000114',
}));

vi.mock('../lib/app-session', () => ({
  useAppSession: () => ({
    api: state.api,
    session: { user: { id: state.userId } },
  }),
}));
vi.mock('../lib/platform', () => ({
  desktopBridge: () => ({
    closeMeetingNotes: state.closeMeetingNotes,
    copyText: state.copyText,
    getMeetingAudioPermissions: state.getMeetingAudioPermissions,
    openMeetingAudioSettings: state.openMeetingAudioSettings,
    prepareMeetingAudioPermissions: state.prepareMeetingAudioPermissions,
    reportTelemetryProductIntent: state.reportTelemetryProductIntent,
    onMeetingCloseRequested: (listener: (reason: MeetingCloseReason) => void) => {
      state.closeRequested = listener;
      return () => {
        if (state.closeRequested === listener) state.closeRequested = undefined;
      };
    },
  }),
}));
vi.mock('../lib/use-realtime-dictation', () => ({
  useRealtimeDictation: (
    _api: unknown,
    onTranscript: (transcript: string) => void,
    options?: { includeSystemAudio?: boolean; useSystemDefaultMicrophone?: boolean },
  ) => {
    state.onTranscript = onTranscript;
    state.dictationOptions = options;
    return {
      commit: state.commit,
      devices: [{ deviceId: 'default', label: 'Default microphone' }],
      selectedDeviceId: 'default',
      setSelectedDeviceId: vi.fn(),
      pause: state.pause,
      resume: state.resume,
      start: state.start,
      state: state.dictationState,
      stop: state.stop,
      ...(state.dictationWarning ? { warning: state.dictationWarning } : {}),
    };
  },
}));

function noteDetail(overrides: Record<string, unknown> = {}) {
  return {
    id: '00000000-0000-4000-8000-000000000111',
    workspaceId: '00000000-0000-4000-8000-000000000112',
    resourceId: '00000000-0000-4000-8000-000000000113',
    ownerUserId: '00000000-0000-4000-8000-000000000114',
    scope: 'personal' as const,
    title: 'Meeting notes',
    recordingStatus: 'idle' as const,
    manualNotes: '',
    liveNotes: '',
    notesThroughSequence: 0,
    segments: [],
    recordedMs: 0,
    startedAt: null,
    endedAt: null,
    generatedAt: null,
    lastActivityAt: '2026-08-07T18:00:00.000Z',
    createdAt: '2026-08-07T18:00:00.000Z',
    updatedAt: '2026-08-07T18:00:00.000Z',
    archivedAt: null,
    ...overrides,
  };
}

describe('MeetingNotesScreen', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.history.replaceState({}, '', '/');
    state.commit.mockResolvedValue('');
    state.pause.mockResolvedValue(undefined);
    state.resume.mockResolvedValue(undefined);
    state.start.mockResolvedValue(undefined);
    state.stop.mockResolvedValue(undefined);
    state.closeRequested = undefined;
    state.dictationOptions = undefined;
    state.dictationState = 'idle';
    state.dictationWarning = undefined;
    state.permissions = { microphone: 'granted', systemAudio: 'granted' };
    state.getMeetingAudioPermissions.mockImplementation(async () => state.permissions);
    state.prepareMeetingAudioPermissions.mockImplementation(async () => state.permissions);
    state.userId = '00000000-0000-4000-8000-000000000114';
    const detail = noteDetail();
    state.api.clientFeatureFlags.mockResolvedValue({
      developerSettings: false,
      controlTowerRefreshSeconds: 60,
    });
    state.api.createNote.mockResolvedValue(detail);
    state.api.updateNote.mockImplementation(async (_id: string, input: Record<string, unknown>) => ({ ...detail, ...input }));
    state.api.appendNoteTranscriptSegment.mockImplementation(async (_id: string, input: Record<string, unknown>) => ({
      id: '00000000-0000-4000-8000-000000000115',
      noteId: detail.id,
      sequenceNumber: 1,
      startOffsetMs: input.startOffsetMs,
      endOffsetMs: input.endOffsetMs,
      capturedAt: input.capturedAt,
      speakerLabel: null,
      text: input.text,
      createdAt: input.capturedAt,
    }));
    state.api.generateNoteNotes.mockResolvedValue({
      ...detail,
      liveNotes: '## Summary\n\nA launch date was agreed.',
      notesThroughSequence: 1,
      generatedAt: '2026-08-07T18:30:00.000Z',
    });
  });

  it('keeps transcript segments readable', () => {
    expect(appendMeetingSegment('First point.', ' Second point. ')).toBe('First point.\n\nSecond point.');
    expect(appendMeetingSegment('', ' Opening note. ')).toBe('Opening note.');
  });

  it('falls back to the flag default cadence, which is the same value the service serves', () => {
    expect(DEFAULT_MEETING_NOTES_INTERVAL_MS).toBe(CONTROL_TOWER_REFRESH_SECONDS.default * 1_000);
    expect(DEFAULT_MEETING_NOTES_INTERVAL_MS).toBe(60_000);
  });

  it('commits a segment and refreshes Control Tower on the cadence the service serves', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      state.api.clientFeatureFlags.mockResolvedValue({
        developerSettings: false,
        controlTowerRefreshSeconds: 15,
      });
      state.commit.mockResolvedValue('A committed minute of talk.');

      const view = render(<Tooltip.Provider><MeetingNotesScreen /></Tooltip.Provider>);
      await screen.findByDisplayValue('Meeting notes');
      await waitFor(() => expect(state.api.clientFeatureFlags).toHaveBeenCalled());
      await waitFor(() => expect(state.start).toHaveBeenCalledOnce());

      // The segment timer arms on the transition into `listening`, which is how
      // it re-arms after every commit; the hook is mocked, so drive it by hand.
      state.dictationState = 'listening';
      view.rerender(<Tooltip.Provider><MeetingNotesScreen /></Tooltip.Provider>);

      // The default cadence has not elapsed, so a screen still on 60s would not
      // have committed anything yet.
      await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
      await waitFor(() => expect(state.commit).toHaveBeenCalledOnce());
      await waitFor(() => expect(state.api.appendNoteTranscriptSegment).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ text: 'A committed minute of talk.' }),
      ));
      // The cadence this meeting settled on travels with the request, so the
      // briefing is written for the schedule the client is actually keeping.
      await waitFor(() => expect(state.api.generateNoteNotes).toHaveBeenCalledWith(
        expect.any(String),
        'live',
        'partial',
        15,
      ));
      const appendOrder = state.api.appendNoteTranscriptSegment.mock.invocationCallOrder[0]!;
      const generateOrder = state.api.generateNoteNotes.mock.invocationCallOrder[0]!;
      expect(appendOrder).toBeLessThan(generateOrder);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps elapsed time monotonic across multiple saved one-minute segments', () => {
    const priorRecordingMs = 45_000;
    const activeStartedAtMs = 1_000_000;
    let recordedBeforeActiveMs = priorRecordingMs;

    const firstBoundaryMs = meetingRecordedMs(
      recordedBeforeActiveMs,
      activeStartedAtMs,
      activeStartedAtMs + DEFAULT_MEETING_NOTES_INTERVAL_MS,
    );
    recordedBeforeActiveMs = mergeSavedMeetingSegmentDuration(
      recordedBeforeActiveMs,
      firstBoundaryMs,
      activeStartedAtMs,
    );
    const secondBoundaryMs = meetingRecordedMs(
      recordedBeforeActiveMs,
      activeStartedAtMs,
      activeStartedAtMs + (2 * DEFAULT_MEETING_NOTES_INTERVAL_MS),
    );

    expect(firstBoundaryMs).toBe(priorRecordingMs + DEFAULT_MEETING_NOTES_INTERVAL_MS);
    expect(recordedBeforeActiveMs).toBe(priorRecordingMs);
    expect(secondBoundaryMs).toBe(priorRecordingMs + (2 * DEFAULT_MEETING_NOTES_INTERVAL_MS));
    expect(mergeSavedMeetingSegmentDuration(recordedBeforeActiveMs, secondBoundaryMs, null))
      .toBe(secondBoundaryMs);
  });

  it('accepts only API-compatible UUID note IDs from the window URL', () => {
    const fallback = '00000000-0000-4000-8000-000000000199';
    expect(noteIdFromSearch('?noteId=00000000-0000-4000-8000-000000000111', () => fallback))
      .toBe('00000000-0000-4000-8000-000000000111');
    expect(noteIdFromSearch('?noteId=not-a-uuid', () => fallback)).toBe(fallback);
    expect(noteIdFromSearch('?meetingId=00000000-0000-4000-8000-000000000111', () => fallback)).toBe(fallback);
  });

  it('starts recording immediately and can generate notes from the live transcript', async () => {
    render(<Tooltip.Provider><MeetingNotesScreen /></Tooltip.Provider>);

    await screen.findByDisplayValue('Meeting notes');
    await waitFor(() => expect(state.start).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole('button', { name: 'End' })).toBeVisible();

    act(() => state.onTranscript?.('We agreed to launch Tuesday.'));
    expect(screen.getByText('We agreed to launch Tuesday.')).toBeVisible();

    fireEvent.click(await screen.findByRole('button', { name: 'End' }));
    await waitFor(() => expect(state.api.appendNoteTranscriptSegment).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        startOffsetMs: expect.any(Number),
        endOffsetMs: expect.any(Number),
        capturedAt: expect.any(String),
        text: 'We agreed to launch Tuesday.',
      }),
    ));
    await waitFor(() => expect(state.api.generateNoteNotes).toHaveBeenCalledWith(
      expect.any(String),
      'final',
      'complete',
      60,
    ));
    expect(screen.getByRole('heading', { name: 'Control Tower' })).toBeVisible();
    expect(await screen.findByRole('heading', { name: 'Summary' })).toBeVisible();
  });

  it('records a new note only when the window carries a proved creation entrypoint', async () => {
    window.history.replaceState({}, '', '/?noteId=00000000-0000-4000-8000-000000000111&meetingEntrypoint=sidebar');
    render(<Tooltip.Provider><MeetingNotesScreen /></Tooltip.Provider>);

    await screen.findByDisplayValue('Meeting notes');
    await waitFor(() => expect(state.reportTelemetryProductIntent).toHaveBeenCalledWith({
      kind: 'note_created', noteId: '00000000-0000-4000-8000-000000000111',
      visibility: 'private', noteType: 'meeting_or_voice', entrypoint: 'sidebar',
    }));
  });

  it('offers Pause and End while recording, then Resume and End while paused', async () => {
    state.dictationState = 'listening';
    const view = render(<Tooltip.Provider><MeetingNotesScreen /></Tooltip.Provider>);

    await screen.findByDisplayValue('Meeting notes');
    await waitFor(() => expect(state.start).toHaveBeenCalledOnce());
    await waitFor(() => expect(state.reportTelemetryProductIntent).toHaveBeenCalledWith({
      kind: 'transcription_state_changed', noteId: expect.any(String), state: 'started',
      visibility: 'private', audioSource: 'microphone_and_system',
    }));
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    await waitFor(() => expect(state.pause).toHaveBeenCalledOnce());
    expect(state.reportTelemetryProductIntent).toHaveBeenCalledWith({
      kind: 'transcription_state_changed', noteId: expect.any(String), state: 'paused',
      visibility: 'private', audioSource: 'microphone_and_system',
    });
    expect(await screen.findByRole('button', { name: 'End' })).toBeVisible();

    state.dictationState = 'paused';
    view.rerender(<Tooltip.Provider><MeetingNotesScreen /></Tooltip.Provider>);
    expect(screen.getByText('Paused')).toBeVisible();
    expect(screen.getByText('Audio capture paused')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(state.resume).toHaveBeenCalledOnce());
    expect(state.reportTelemetryProductIntent).toHaveBeenCalledWith({
      kind: 'transcription_state_changed', noteId: expect.any(String), state: 'resumed',
      visibility: 'private', audioSource: 'microphone_and_system',
    });
    expect(await screen.findByRole('button', { name: 'End' })).toBeVisible();
  });

  it('waits for the native permission decision before marking the note as recording', async () => {
    const permissionDecision = deferred<typeof state.permissions>();
    state.prepareMeetingAudioPermissions.mockImplementationOnce(() => permissionDecision.promise);

    render(<Tooltip.Provider><MeetingNotesScreen /></Tooltip.Provider>);
    await screen.findByDisplayValue('Meeting notes');

    expect(await screen.findByText('Requesting audio access…')).toBeVisible();
    expect(state.start).not.toHaveBeenCalled();
    expect(state.api.updateNote).not.toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ recordingStatus: 'recording' }),
    );

    await act(async () => permissionDecision.resolve({ microphone: 'granted', systemAudio: 'granted' }));
    await waitFor(() => expect(state.start).toHaveBeenCalledOnce());
    expect(await screen.findByRole('button', { name: 'End' })).toBeVisible();
  });

  it('waits for the final provider transcript, persistence, and summary before marking the note complete', async () => {
    const finalTranscript = deferred<void>();
    state.dictationState = 'listening';
    state.stop.mockImplementation(async () => {
      await finalTranscript.promise;
      state.onTranscript?.('The last buffered sentence.');
    });

    render(<Tooltip.Provider><MeetingNotesScreen /></Tooltip.Provider>);
    await screen.findByDisplayValue('Meeting notes');
    await waitFor(() => expect(state.start).toHaveBeenCalledOnce());

    fireEvent.click(await screen.findByRole('button', { name: 'End' }));
    expect(await screen.findByRole('button', { name: 'Finalizing…' })).toBeDisabled();
    expect(state.api.updateNote).not.toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ recordingStatus: 'complete' }),
    );

    await act(async () => finalTranscript.resolve());
    await waitFor(() => expect(state.api.appendNoteTranscriptSegment).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ text: 'The last buffered sentence.' }),
    ));
    await waitFor(() => expect(state.api.updateNote).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ recordingStatus: 'complete' }),
    ));

    const appendOrder = state.api.appendNoteTranscriptSegment.mock.invocationCallOrder[0]!;
    const generateOrder = state.api.generateNoteNotes.mock.invocationCallOrder[0]!;
    const completeCallIndex = state.api.updateNote.mock.calls.findIndex(([, patch]) => patch.recordingStatus === 'complete');
    const completeOrder = state.api.updateNote.mock.invocationCallOrder[completeCallIndex]!;
    expect(appendOrder).toBeLessThan(generateOrder);
    expect(generateOrder).toBeLessThan(completeOrder);
    expect(state.api.generateNoteNotes).toHaveBeenCalledWith(expect.any(String), 'final', 'complete', 60);
  });

  it('closes the window on End and hands the main window the note it produced', async () => {
    state.dictationState = 'listening';
    state.stop.mockImplementation(async () => {
      state.onTranscript?.('The closing sentence.');
    });

    render(<Tooltip.Provider><MeetingNotesScreen /></Tooltip.Provider>);
    await screen.findByDisplayValue('Meeting notes');
    await waitFor(() => expect(state.start).toHaveBeenCalledOnce());

    fireEvent.click(await screen.findByRole('button', { name: 'End' }));

    await waitFor(() => expect(state.closeMeetingNotes).toHaveBeenCalledOnce());
    expect(state.reportTelemetryProductIntent).toHaveBeenCalledWith({
      kind: 'transcription_state_changed', noteId: expect.any(String), state: 'completed',
      visibility: 'private', audioSource: 'microphone_and_system',
    });
    // The note id, so the main window can be taken to it rather than left on
    // whatever the meeting window was covering.
    expect(state.closeMeetingNotes).toHaveBeenCalledWith(expect.stringMatching(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
    ));
    // …and only once the note is finished, so it opens complete.
    const closeOrder = state.closeMeetingNotes.mock.invocationCallOrder[0]!;
    const completeCallIndex = state.api.updateNote.mock.calls.findIndex(([, patch]) => patch.recordingStatus === 'complete');
    expect(state.api.updateNote.mock.invocationCallOrder[completeCallIndex]).toBeLessThan(closeOrder);
  });

  it('keeps the window open on End when the final summary failed', async () => {
    state.dictationState = 'listening';
    state.api.generateNoteNotes.mockRejectedValue(new Error('Avalon could not create the final meeting summary.'));

    render(<Tooltip.Provider><MeetingNotesScreen /></Tooltip.Provider>);
    await screen.findByDisplayValue('Meeting notes');
    await waitFor(() => expect(state.start).toHaveBeenCalledOnce());

    fireEvent.click(await screen.findByRole('button', { name: 'End' }));

    // The note is marked complete either way — the recording really did end —
    // but nothing in the note screen can ask for the summary again, so closing
    // over the error is how a person ends up with a note silently missing it.
    await waitFor(() => expect(state.api.updateNote).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ recordingStatus: 'complete' }),
    ));
    expect(await screen.findByText('Avalon could not create the final meeting summary.')).toBeVisible();
    expect(state.closeMeetingNotes).not.toHaveBeenCalled();
  });

  it('coalesces a live refresh raised while one is still running', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      state.api.clientFeatureFlags.mockResolvedValue({
        developerSettings: false,
        controlTowerRefreshSeconds: 15,
      });
      const slowGeneration = deferred<void>();
      const detail = noteDetail();
      state.api.generateNoteNotes.mockImplementation(async () => {
        await slowGeneration.promise;
        return { ...detail, liveNotes: '## Right now\n\n- Still going.', notesThroughSequence: 1 };
      });
      state.commit.mockResolvedValue('More talk.');

      const view = render(<Tooltip.Provider><MeetingNotesScreen /></Tooltip.Provider>);
      await screen.findByDisplayValue('Meeting notes');
      await waitFor(() => expect(state.api.clientFeatureFlags).toHaveBeenCalled());
      await waitFor(() => expect(state.start).toHaveBeenCalledOnce());
      state.dictationState = 'listening';
      view.rerender(<Tooltip.Provider><MeetingNotesScreen /></Tooltip.Provider>);

      // Three cadences pass while the first briefing is still being written.
      // The real hook leaves `listening` for each commit and returns, which is
      // what re-arms the timer; drive that transition by hand each tick.
      for (let tick = 0; tick < 3; tick += 1) {
        await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
        state.dictationState = 'transcribing';
        view.rerender(<Tooltip.Provider><MeetingNotesScreen /></Tooltip.Provider>);
        state.dictationState = 'listening';
        view.rerender(<Tooltip.Provider><MeetingNotesScreen /></Tooltip.Provider>);
      }

      // Every minute of speech is still committed — that is the durable half.
      expect(state.api.appendNoteTranscriptSegment.mock.calls.length).toBeGreaterThan(1);

      // The backlog, if there were one, drains here. Queued refreshes would now
      // each run in turn: three more inferences, for minutes the very next pass
      // already covers, with finalization waiting behind all of them.
      await act(async () => { slowGeneration.resolve(); });
      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      expect(state.api.generateNoteNotes).toHaveBeenCalledOnce();

      // And the loop is refreshing again rather than latched off.
      state.dictationState = 'transcribing';
      view.rerender(<Tooltip.Provider><MeetingNotesScreen /></Tooltip.Provider>);
      state.dictationState = 'listening';
      view.rerender(<Tooltip.Provider><MeetingNotesScreen /></Tooltip.Provider>);
      await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
      await waitFor(() => expect(state.api.generateNoteNotes).toHaveBeenCalledTimes(2));
    } finally {
      vi.useRealTimers();
    }
  });

  it('records on the default when the cadence request never answers, without waiting on it to start', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      // A request that never settles, which is what a captive portal looks like.
      state.api.clientFeatureFlags.mockImplementation(() => new Promise(() => undefined));
      state.commit.mockResolvedValue('Talk on the default cadence.');

      const view = render(<Tooltip.Provider><MeetingNotesScreen /></Tooltip.Provider>);
      await screen.findByDisplayValue('Meeting notes');

      // Capture is never made to wait for a feature flag.
      await waitFor(() => expect(state.start).toHaveBeenCalledOnce());
      state.dictationState = 'listening';
      view.rerender(<Tooltip.Provider><MeetingNotesScreen /></Tooltip.Provider>);

      // The segment timer does, but only until the request is given up on.
      await act(async () => { await vi.advanceTimersByTimeAsync(MEETING_CADENCE_REQUEST_TIMEOUT_MS - 1); });
      expect(state.commit).not.toHaveBeenCalled();

      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      state.dictationState = 'transcribing';
      view.rerender(<Tooltip.Provider><MeetingNotesScreen /></Tooltip.Provider>);
      state.dictationState = 'listening';
      view.rerender(<Tooltip.Provider><MeetingNotesScreen /></Tooltip.Provider>);
      await act(async () => { await vi.advanceTimersByTimeAsync(DEFAULT_MEETING_NOTES_INTERVAL_MS); });

      await waitFor(() => expect(state.commit).toHaveBeenCalled());
      await waitFor(() => expect(state.api.generateNoteNotes).toHaveBeenCalledWith(
        expect.any(String),
        'live',
        'partial',
        CONTROL_TOWER_REFRESH_SECONDS.default,
      ));
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps one cadence for the whole meeting once it has settled', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const cadence = deferred<{ developerSettings: boolean; controlTowerRefreshSeconds: number }>();
      state.api.clientFeatureFlags.mockReturnValue(cadence.promise);
      state.commit.mockResolvedValue('Talk.');

      const view = render(<Tooltip.Provider><MeetingNotesScreen /></Tooltip.Provider>);
      await screen.findByDisplayValue('Meeting notes');
      await waitFor(() => expect(state.start).toHaveBeenCalledOnce());
      await act(async () => cadence.resolve({ developerSettings: false, controlTowerRefreshSeconds: 15 }));
      state.dictationState = 'listening';
      view.rerender(<Tooltip.Provider><MeetingNotesScreen /></Tooltip.Provider>);

      // A later answer — a remount, a retry — cannot replace the cadence this
      // meeting is already recording on, because a boundary that moves
      // mid-recording moves the transcript with it.
      state.api.clientFeatureFlags.mockResolvedValue({
        developerSettings: false,
        controlTowerRefreshSeconds: 600,
      });
      await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
      await waitFor(() => expect(state.api.generateNoteNotes).toHaveBeenCalledWith(
        expect.any(String),
        'live',
        'partial',
        15,
      ));
    } finally {
      vi.useRealTimers();
    }
  });

  it('describes the cadence it was actually served', async () => {
    state.api.clientFeatureFlags.mockResolvedValue({
      developerSettings: false,
      controlTowerRefreshSeconds: 300,
    });

    render(<Tooltip.Provider><MeetingNotesScreen /></Tooltip.Provider>);
    await screen.findByDisplayValue('Meeting notes');

    expect(await screen.findByText(/keeps you current every 5 minutes/u)).toBeVisible();
    expect(meetingRefreshCadenceLabel(60_000)).toBe('every minute');
    expect(meetingRefreshCadenceLabel(15_000)).toBe('every 15 seconds');
    expect(meetingRefreshCadenceLabel(90_000)).toBe('every 90 seconds');
  });

  it('keeps the window open on End when the note could not be marked complete', async () => {
    state.dictationState = 'listening';
    const detail = noteDetail();
    state.api.updateNote.mockImplementation(async (_id: string, input: Record<string, unknown>) => {
      if (input.recordingStatus === 'complete') throw new Error('Final status save failed');
      return { ...detail, ...input };
    });

    render(<Tooltip.Provider><MeetingNotesScreen /></Tooltip.Provider>);
    await screen.findByDisplayValue('Meeting notes');
    await waitFor(() => expect(state.start).toHaveBeenCalledOnce());

    fireEvent.click(await screen.findByRole('button', { name: 'End' }));

    // Closing here would take the only report of the failure with it. The
    // native close path is the one that must close regardless, because a window
    // that will not shut also blocks app quit.
    expect(await screen.findByText('Final status save failed')).toBeVisible();
    expect(state.closeMeetingNotes).not.toHaveBeenCalled();
  });

  it('finalizes a recording before allowing a quit to close the meeting window', async () => {
    state.dictationState = 'listening';
    state.stop.mockImplementation(async () => {
      state.onTranscript?.('Close-safe final sentence.');
    });

    render(<Tooltip.Provider><MeetingNotesScreen /></Tooltip.Provider>);
    await screen.findByDisplayValue('Meeting notes');
    await waitFor(() => expect(state.closeRequested).toBeTypeOf('function'));

    act(() => state.closeRequested?.('quit'));

    await waitFor(() => expect(state.closeMeetingNotes).toHaveBeenCalledOnce());
    expect(state.api.appendNoteTranscriptSegment).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ text: 'Close-safe final sentence.' }),
    );
    expect(state.api.generateNoteNotes).toHaveBeenCalledOnce();
    expect(state.api.generateNoteNotes).toHaveBeenCalledWith(expect.any(String), 'final', 'complete', 60);
    const closeOrder = state.closeMeetingNotes.mock.invocationCallOrder[0]!;
    const completeCallIndex = state.api.updateNote.mock.calls.findIndex(([, patch]) => patch.recordingStatus === 'complete');
    expect(state.api.updateNote.mock.invocationCallOrder[completeCallIndex]).toBeLessThan(closeOrder);
  });

  it('closes the native meeting window even when the final status save fails', async () => {
    state.dictationState = 'listening';
    const detail = noteDetail();
    state.api.updateNote.mockImplementation(async (_id: string, input: Record<string, unknown>) => {
      if (input.recordingStatus === 'complete') throw new Error('Final status save failed');
      return { ...detail, ...input };
    });

    render(<Tooltip.Provider><MeetingNotesScreen /></Tooltip.Provider>);
    await screen.findByDisplayValue('Meeting notes');
    await waitFor(() => expect(state.start).toHaveBeenCalledOnce());
    await waitFor(() => expect(state.closeRequested).toBeTypeOf('function'));

    act(() => state.closeRequested?.('quit'));

    await waitFor(() => expect(state.api.updateNote).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ recordingStatus: 'complete' }),
    ));
    await waitFor(() => expect(state.closeMeetingNotes).toHaveBeenCalledOnce());
  });

  it('asks before a person closes a window that is still recording', async () => {
    state.dictationState = 'listening';

    render(<Tooltip.Provider><MeetingNotesScreen /></Tooltip.Provider>);
    await screen.findByDisplayValue('Meeting notes');
    await waitFor(() => expect(state.start).toHaveBeenCalledOnce());
    await waitFor(() => expect(state.closeRequested).toBeTypeOf('function'));

    act(() => state.closeRequested?.('user'));

    expect(await screen.findByRole('dialog', { name: 'This meeting is still recording' })).toBeVisible();
    // Nothing has ended yet: the window stays up, and so does the recording.
    expect(state.stop).not.toHaveBeenCalled();
    expect(state.closeMeetingNotes).not.toHaveBeenCalled();
  });

  it('ends the recording and closes once the person confirms', async () => {
    state.dictationState = 'listening';
    state.stop.mockImplementation(async () => {
      state.onTranscript?.('A sentence spoken just before the window closed.');
    });

    render(<Tooltip.Provider><MeetingNotesScreen /></Tooltip.Provider>);
    await screen.findByDisplayValue('Meeting notes');
    await waitFor(() => expect(state.start).toHaveBeenCalledOnce());
    await waitFor(() => expect(state.closeRequested).toBeTypeOf('function'));

    act(() => state.closeRequested?.('user'));
    const dialog = await screen.findByRole('dialog', { name: 'This meeting is still recording' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'End and close' }));

    await waitFor(() => expect(state.closeMeetingNotes).toHaveBeenCalledOnce());
    expect(state.stop).toHaveBeenCalled();
    expect(state.api.appendNoteTranscriptSegment).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ text: 'A sentence spoken just before the window closed.' }),
    );
    expect(state.api.generateNoteNotes).toHaveBeenCalledWith(expect.any(String), 'final', 'complete', 60);
    const closeOrder = state.closeMeetingNotes.mock.invocationCallOrder[0]!;
    const completeCallIndex = state.api.updateNote.mock.calls.findIndex(([, patch]) => patch.recordingStatus === 'complete');
    expect(state.api.updateNote.mock.invocationCallOrder[completeCallIndex]).toBeLessThan(closeOrder);
  });

  it('leaves the meeting running when the person keeps recording', async () => {
    state.dictationState = 'listening';

    render(<Tooltip.Provider><MeetingNotesScreen /></Tooltip.Provider>);
    await screen.findByDisplayValue('Meeting notes');
    await waitFor(() => expect(state.start).toHaveBeenCalledOnce());
    await waitFor(() => expect(state.closeRequested).toBeTypeOf('function'));

    act(() => state.closeRequested?.('user'));
    const dialog = await screen.findByRole('dialog', { name: 'This meeting is still recording' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep recording' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(state.stop).not.toHaveBeenCalled();
    expect(state.closeMeetingNotes).not.toHaveBeenCalled();
    expect(await screen.findByRole('button', { name: 'End' })).toBeVisible();
  });

  it('takes the question away when the recording ends underneath it', async () => {
    state.dictationState = 'listening';

    const view = render(<Tooltip.Provider><MeetingNotesScreen /></Tooltip.Provider>);
    await screen.findByDisplayValue('Meeting notes');
    await waitFor(() => expect(state.start).toHaveBeenCalledOnce());
    await waitFor(() => expect(state.closeRequested).toBeTypeOf('function'));

    act(() => state.closeRequested?.('user'));
    await screen.findByRole('dialog', { name: 'This meeting is still recording' });

    // Dictation failing finalizes the meeting on its own. Asking whether to end
    // a recording that has already stopped is a question about nothing, over a
    // window whose remaining news is the error that stopped it.
    state.dictationState = 'error';
    view.rerender(<Tooltip.Provider><MeetingNotesScreen /></Tooltip.Provider>);

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(state.closeMeetingNotes).not.toHaveBeenCalled();
  });

  it('closes a window with nothing to lose without asking', async () => {
    state.api.createNote.mockResolvedValue(noteDetail({
      recordingStatus: 'complete',
      liveNotes: '## Summary\n\nThe meeting already ended.',
    }));

    render(<Tooltip.Provider><MeetingNotesScreen /></Tooltip.Provider>);
    await screen.findByDisplayValue('Meeting notes');
    await waitFor(() => expect(state.closeRequested).toBeTypeOf('function'));

    act(() => state.closeRequested?.('user'));

    // A finished note is durable; a confirmation here would be a question about
    // nothing, asked every time the window is closed.
    await waitFor(() => expect(state.closeMeetingNotes).toHaveBeenCalledOnce());
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('finishes with a partial final summary when the last transcript segment cannot be saved', async () => {
    state.dictationState = 'listening';
    state.stop.mockImplementation(async () => {
      state.onTranscript?.('A final sentence that could not be persisted.');
    });
    state.api.appendNoteTranscriptSegment.mockRejectedValueOnce(new Error('Segment save failed'));

    render(<Tooltip.Provider><MeetingNotesScreen /></Tooltip.Provider>);
    await screen.findByDisplayValue('Meeting notes');
    await waitFor(() => expect(state.start).toHaveBeenCalledOnce());

    fireEvent.click(await screen.findByRole('button', { name: 'End' }));

    await waitFor(() => expect(state.api.generateNoteNotes).toHaveBeenCalledWith(
      expect.any(String),
      'final',
      'partial',
      60,
    ));
    await waitFor(() => expect(state.api.updateNote).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ recordingStatus: 'complete' }),
    ));
    expect(screen.getByText('Segment save failed')).toBeVisible();
  });

  it('requests computer audio and the operating-system default microphone automatically', async () => {
    render(<Tooltip.Provider><MeetingNotesScreen /></Tooltip.Provider>);
    await screen.findByDisplayValue('Meeting notes');

    expect(state.dictationOptions).toEqual({
      includeSystemAudio: true,
      useSystemDefaultMicrophone: true,
    });
    await waitFor(() => expect(state.start).toHaveBeenCalledOnce());
    expect(state.prepareMeetingAudioPermissions).toHaveBeenCalledOnce();
    expect(state.prepareMeetingAudioPermissions.mock.invocationCallOrder[0])
      .toBeLessThan(state.start.mock.invocationCallOrder[0]!);
    expect(screen.queryByRole('checkbox', { name: 'Computer audio' })).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText('Type or paste notes here…')).not.toBeInTheDocument();
  });

  it('keeps the recording active and shows a visible warning when only the microphone is available', async () => {
    state.dictationWarning = 'Recording microphone only. Computer audio access is blocked.';
    state.permissions = { microphone: 'granted', systemAudio: 'denied' };

    render(<Tooltip.Provider><MeetingNotesScreen /></Tooltip.Provider>);
    await screen.findByDisplayValue('Meeting notes');

    await waitFor(() => expect(state.start).toHaveBeenCalledOnce());
    expect(await screen.findByRole('button', { name: 'End' })).toBeVisible();
    expect(screen.getByRole('status')).toHaveTextContent('Recording microphone only');
    expect(screen.getByText('Listening to your microphone')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Open System Settings' }));
    await waitFor(() => expect(state.openMeetingAudioSettings).toHaveBeenCalledWith('system-audio'));
  });

  it('does not mark the note recording when every audio permission is blocked', async () => {
    state.permissions = { microphone: 'denied', systemAudio: 'denied' };

    render(<Tooltip.Provider><MeetingNotesScreen /></Tooltip.Provider>);
    await screen.findByDisplayValue('Meeting notes');

    await waitFor(() => expect(state.prepareMeetingAudioPermissions).toHaveBeenCalledOnce());
    expect(state.start).not.toHaveBeenCalled();
    expect(state.api.updateNote).not.toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ recordingStatus: 'recording' }),
    );
    expect(screen.getByText(/microphone and computer audio access are blocked/i)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Retry recording' })).toBeVisible();
  });

  it('marks the final summary transcript partial when provider finalization fails', async () => {
    state.dictationState = 'listening';
    state.stop.mockRejectedValueOnce(new Error('Final transcript timed out'));

    render(<Tooltip.Provider><MeetingNotesScreen /></Tooltip.Provider>);
    await screen.findByDisplayValue('Meeting notes');

    fireEvent.click(await screen.findByRole('button', { name: 'End' }));

    await waitFor(() => expect(state.api.generateNoteNotes).toHaveBeenCalledWith(
      expect.any(String),
      'final',
      'partial',
      60,
    ));
    expect(screen.getByText('Final transcript timed out')).toBeVisible();
  });

  it('can make a private note public to the workspace', async () => {
    render(<Tooltip.Provider><MeetingNotesScreen /></Tooltip.Provider>);
    const visibility = await screen.findByRole('combobox', { name: 'Note visibility' });

    fireEvent.change(visibility, { target: { value: 'workspace' } });

    await waitFor(() => expect(state.api.updateNote).toHaveBeenCalledWith(
      expect.any(String),
      { scope: 'workspace' },
    ));
    expect(state.reportTelemetryProductIntent).toHaveBeenCalledWith({
      kind: 'note_action_completed', noteId: expect.any(String), action: 'make_public',
      visibility: 'public', recordingState: 'idle',
    });
  });

  it('opens another creator’s public note as read-only', async () => {
    state.userId = '00000000-0000-4000-8000-000000000999';
    state.api.createNote.mockResolvedValue(noteDetail({
      scope: 'workspace',
      title: 'Shared meeting notes',
      recordingStatus: 'complete',
      liveNotes: '## Shared summary\n\nA shared note.',
    }));

    render(<Tooltip.Provider><MeetingNotesScreen /></Tooltip.Provider>);

    expect(await screen.findByText('Shared read-only note')).toBeVisible();
    expect(screen.getByDisplayValue('Shared meeting notes')).toBeDisabled();
    expect(screen.getByRole('heading', { name: 'Shared summary' })).toBeVisible();
    expect(screen.getByRole('combobox', { name: 'Note visibility' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Start recording' })).toBeDisabled();
    expect(state.prepareMeetingAudioPermissions).not.toHaveBeenCalled();
  });
});
