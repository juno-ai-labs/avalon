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

const state = vi.hoisted(() => ({
  api: {
    appendNoteTranscriptSegment: vi.fn(),
    createNote: vi.fn(),
    generateNoteNotes: vi.fn(),
    getTranscriptionSocketTicket: vi.fn(),
    updateNote: vi.fn(),
  },
  copyText: vi.fn(),
  commit: vi.fn(async () => ''),
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
  desktopBridge: () => ({ copyText: state.copyText }),
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
      state: 'idle',
      stop: state.stop,
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
    state.dictationOptions = undefined;
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
    await waitFor(() => expect(state.api.generateNoteNotes).toHaveBeenCalledWith(expect.any(String)));
    expect(await screen.findByRole('heading', { name: 'Summary' })).toBeVisible();
  });

  it('automatically captures computer audio and the operating-system default microphone', async () => {
    render(<Tooltip.Provider><MeetingNotesScreen /></Tooltip.Provider>);
    await screen.findByDisplayValue('Meeting notes');

    expect(state.dictationOptions).toEqual({
      includeSystemAudio: true,
      useSystemDefaultMicrophone: true,
    });
    await waitFor(() => expect(state.start).toHaveBeenCalledOnce());
    expect(screen.queryByRole('checkbox', { name: 'Computer audio' })).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText('Type or paste notes here…')).not.toBeInTheDocument();
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
  });
});
