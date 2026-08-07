import * as Tooltip from '@radix-ui/react-tooltip';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  appendMeetingSegment,
  MEETING_NOTES_INTERVAL_MS,
  MEETING_TRANSCRIPTION_SEGMENT_MS,
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
  useRealtimeDictation: (_api: unknown, onTranscript: (transcript: string) => void) => {
    state.onTranscript = onTranscript;
    return {
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
    expect(MEETING_TRANSCRIPTION_SEGMENT_MS).toBeLessThan(MEETING_NOTES_INTERVAL_MS);
  });

  it('accepts only API-compatible UUID note IDs from the window URL', () => {
    const fallback = '00000000-0000-4000-8000-000000000199';
    expect(noteIdFromSearch('?noteId=00000000-0000-4000-8000-000000000111', () => fallback))
      .toBe('00000000-0000-4000-8000-000000000111');
    expect(noteIdFromSearch('?noteId=not-a-uuid', () => fallback)).toBe(fallback);
    expect(noteIdFromSearch('?meetingId=00000000-0000-4000-8000-000000000111', () => fallback)).toBe(fallback);
  });

  it('starts recording and can generate notes from the live transcript', async () => {
    render(<Tooltip.Provider><MeetingNotesScreen /></Tooltip.Provider>);

    await screen.findByDisplayValue('Meeting notes');

    fireEvent.click(screen.getByRole('button', { name: 'Start recording' }));
    await waitFor(() => expect(state.start).toHaveBeenCalledTimes(1));

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

  it('saves typed or pasted notes without starting a recording', async () => {
    render(<Tooltip.Provider><MeetingNotesScreen /></Tooltip.Provider>);
    const editor = await screen.findByPlaceholderText('Type or paste notes here…');

    fireEvent.change(editor, { target: { value: 'Pasted customer notes' } });

    await waitFor(() => expect(state.api.updateNote).toHaveBeenCalledWith(
      expect.any(String),
      { manualNotes: 'Pasted customer notes' },
    ));
    expect(state.start).not.toHaveBeenCalled();
  });

  it('does not erase newer typing when an older autosave response arrives', async () => {
    let resolveOlderSave!: (value: ReturnType<typeof noteDetail>) => void;
    state.api.updateNote.mockImplementationOnce(() => new Promise((resolve) => {
      resolveOlderSave = resolve;
    }));
    render(<Tooltip.Provider><MeetingNotesScreen /></Tooltip.Provider>);
    const editor = await screen.findByPlaceholderText('Type or paste notes here…');

    fireEvent.change(editor, { target: { value: 'First draft' } });
    await waitFor(() => expect(state.api.updateNote).toHaveBeenCalledWith(
      expect.any(String),
      { manualNotes: 'First draft' },
    ));
    fireEvent.change(editor, { target: { value: 'First draft with a newer sentence' } });
    act(() => resolveOlderSave(noteDetail({ manualNotes: 'First draft' })));

    expect(editor).toHaveValue('First draft with a newer sentence');
    await waitFor(() => expect(state.api.updateNote).toHaveBeenCalledWith(
      expect.any(String),
      { manualNotes: 'First draft with a newer sentence' },
    ));
  });

  it('does not erase locally dirty notes when live-note generation finishes', async () => {
    const segment = {
      id: '00000000-0000-4000-8000-000000000115',
      noteId: '00000000-0000-4000-8000-000000000111',
      sequenceNumber: 1,
      startOffsetMs: 0,
      endOffsetMs: 1_000,
      capturedAt: '2026-08-07T18:00:01.000Z',
      speakerLabel: null,
      text: 'Existing transcript.',
      createdAt: '2026-08-07T18:00:01.000Z',
    };
    const initial = noteDetail({ segments: [segment] });
    state.api.createNote.mockResolvedValue(initial);
    let resolveGeneration!: (value: ReturnType<typeof noteDetail>) => void;
    state.api.generateNoteNotes.mockImplementationOnce(() => new Promise((resolve) => {
      resolveGeneration = resolve;
    }));
    render(<Tooltip.Provider><MeetingNotesScreen /></Tooltip.Provider>);
    const editor = await screen.findByPlaceholderText('Type or paste notes here…');

    fireEvent.change(editor, { target: { value: 'Local draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Update now' }));
    await waitFor(() => expect(state.api.generateNoteNotes).toHaveBeenCalledTimes(1));
    fireEvent.change(editor, { target: { value: 'Local draft still being typed' } });
    act(() => resolveGeneration(noteDetail({
      segments: [segment],
      liveNotes: '## Summary\n\nGenerated.',
      generatedAt: '2026-08-07T18:01:00.000Z',
    })));

    expect(await screen.findByRole('heading', { name: 'Summary' })).toBeVisible();
    expect(editor).toHaveValue('Local draft still being typed');
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
      manualNotes: 'A shared note.',
    }));

    render(<Tooltip.Provider><MeetingNotesScreen /></Tooltip.Provider>);

    expect(await screen.findByText('Shared read-only note')).toBeVisible();
    expect(screen.getByDisplayValue('Shared meeting notes')).toBeDisabled();
    expect(screen.getByDisplayValue('A shared note.')).toBeDisabled();
    expect(screen.getByRole('combobox', { name: 'Note visibility' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Start recording' })).toBeDisabled();
  });
});
