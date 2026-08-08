import * as Tooltip from '@radix-ui/react-tooltip';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  appendMeetingSegment,
  meetingRecordedMs,
  MEETING_NOTES_INTERVAL_MS,
  MEETING_TRANSCRIPTION_SEGMENT_MS,
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
    createNote: vi.fn(),
    generateNoteNotes: vi.fn(),
    getTranscriptionSocketTicket: vi.fn(),
    updateNote: vi.fn(),
  },
  closeMeetingNotes: vi.fn(async () => undefined),
  closeRequested: undefined as undefined | (() => void),
  copyText: vi.fn(),
  getMeetingAudioPermissions: vi.fn(),
  openMeetingAudioSettings: vi.fn(async () => undefined),
  permissions: { microphone: 'granted', systemAudio: 'granted' } as {
    microphone: 'not-determined' | 'granted' | 'denied' | 'restricted' | 'unknown';
    systemAudio: 'not-determined' | 'granted' | 'denied' | 'restricted' | 'unknown';
  },
  prepareMeetingAudioPermissions: vi.fn(),
  commit: vi.fn(async () => ''),
  dictationState: 'idle' as 'idle' | 'requesting' | 'connecting' | 'listening' | 'transcribing' | 'finalizing' | 'error',
  dictationWarning: undefined as string | undefined,
  dictationOptions: undefined as undefined | {
    includeSystemAudio?: boolean;
    useSystemDefaultMicrophone?: boolean;
  },
  onTranscript: undefined as undefined | ((transcript: string) => void),
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
    onMeetingCloseRequested: (listener: () => void) => {
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
    state.commit.mockResolvedValue('');
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
    expect(MEETING_NOTES_INTERVAL_MS).toBe(5 * 60 * 1_000);
    expect(MEETING_TRANSCRIPTION_SEGMENT_MS).toBe(MEETING_NOTES_INTERVAL_MS);
  });

  it('keeps elapsed time monotonic across multiple saved five-minute segments', () => {
    const priorRecordingMs = 45_000;
    const activeStartedAtMs = 1_000_000;
    let recordedBeforeActiveMs = priorRecordingMs;

    const firstBoundaryMs = meetingRecordedMs(
      recordedBeforeActiveMs,
      activeStartedAtMs,
      activeStartedAtMs + MEETING_TRANSCRIPTION_SEGMENT_MS,
    );
    recordedBeforeActiveMs = mergeSavedMeetingSegmentDuration(
      recordedBeforeActiveMs,
      firstBoundaryMs,
      activeStartedAtMs,
    );
    const secondBoundaryMs = meetingRecordedMs(
      recordedBeforeActiveMs,
      activeStartedAtMs,
      activeStartedAtMs + (2 * MEETING_TRANSCRIPTION_SEGMENT_MS),
    );

    expect(firstBoundaryMs).toBe(priorRecordingMs + MEETING_TRANSCRIPTION_SEGMENT_MS);
    expect(recordedBeforeActiveMs).toBe(priorRecordingMs);
    expect(secondBoundaryMs).toBe(priorRecordingMs + (2 * MEETING_TRANSCRIPTION_SEGMENT_MS));
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
    expect(screen.getByRole('button', { name: 'Stop recording' })).toBeVisible();

    act(() => state.onTranscript?.('We agreed to launch Tuesday.'));
    expect(screen.getByText('We agreed to launch Tuesday.')).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Stop recording' }));
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
    ));
    expect(screen.getByRole('heading', { name: 'Control Tower' })).toBeVisible();
    expect(await screen.findByRole('heading', { name: 'Summary' })).toBeVisible();
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
    expect(screen.getByRole('button', { name: 'Stop recording' })).toBeVisible();
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

    fireEvent.click(screen.getByRole('button', { name: 'Stop recording' }));
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
    expect(state.api.generateNoteNotes).toHaveBeenCalledWith(expect.any(String), 'final', 'complete');
  });

  it('finalizes a recording before allowing the native meeting window to close', async () => {
    state.dictationState = 'listening';
    state.stop.mockImplementation(async () => {
      state.onTranscript?.('Close-safe final sentence.');
    });

    render(<Tooltip.Provider><MeetingNotesScreen /></Tooltip.Provider>);
    await screen.findByDisplayValue('Meeting notes');
    await waitFor(() => expect(state.closeRequested).toBeTypeOf('function'));

    act(() => state.closeRequested?.());

    await waitFor(() => expect(state.closeMeetingNotes).toHaveBeenCalledOnce());
    expect(state.api.appendNoteTranscriptSegment).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ text: 'Close-safe final sentence.' }),
    );
    expect(state.api.generateNoteNotes).toHaveBeenCalledOnce();
    expect(state.api.generateNoteNotes).toHaveBeenCalledWith(expect.any(String), 'final', 'complete');
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

    act(() => state.closeRequested?.());

    await waitFor(() => expect(state.api.updateNote).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ recordingStatus: 'complete' }),
    ));
    await waitFor(() => expect(state.closeMeetingNotes).toHaveBeenCalledOnce());
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

    fireEvent.click(screen.getByRole('button', { name: 'Stop recording' }));

    await waitFor(() => expect(state.api.generateNoteNotes).toHaveBeenCalledWith(
      expect.any(String),
      'final',
      'partial',
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
    expect(screen.getByRole('button', { name: 'Stop recording' })).toBeVisible();
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

    fireEvent.click(await screen.findByRole('button', { name: 'Stop recording' }));

    await waitFor(() => expect(state.api.generateNoteNotes).toHaveBeenCalledWith(
      expect.any(String),
      'final',
      'partial',
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
