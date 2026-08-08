import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NoteDetailScreen } from './note-detail';

const state = vi.hoisted(() => ({
  getNote: vi.fn(),
}));

vi.mock('../lib/app-session', () => ({
  useAppSession: () => ({ api: { getNote: state.getNote } }),
}));

function detail(overrides: Record<string, unknown> = {}) {
  return {
    id: '00000000-0000-4000-8000-000000000111',
    workspaceId: '00000000-0000-4000-8000-000000000112',
    resourceId: '00000000-0000-4000-8000-000000000113',
    ownerUserId: '00000000-0000-4000-8000-000000000114',
    scope: 'personal' as const,
    title: 'Customer interview',
    recordingStatus: 'complete' as const,
    manualNotes: '',
    liveNotes: '## Decisions\n\nShip the smaller onboarding flow.',
    notesThroughSequence: 1,
    segments: [{
      id: '00000000-0000-4000-8000-000000000115',
      noteId: '00000000-0000-4000-8000-000000000111',
      sequenceNumber: 1,
      startOffsetMs: 5_000,
      endOffsetMs: 16_000,
      capturedAt: '2026-08-07T18:00:05.000Z',
      speakerLabel: null,
      text: 'The customer wants a smaller onboarding flow.',
      createdAt: '2026-08-07T18:00:16.000Z',
    }],
    recordedMs: 16_000,
    startedAt: '2026-08-07T18:00:00.000Z',
    endedAt: '2026-08-07T18:00:16.000Z',
    generatedAt: '2026-08-07T18:01:00.000Z',
    lastActivityAt: '2026-08-07T18:01:00.000Z',
    createdAt: '2026-08-07T18:00:00.000Z',
    updatedAt: '2026-08-07T18:01:00.000Z',
    archivedAt: null,
    ...overrides,
  };
}

function renderScreen(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/notes/00000000-0000-4000-8000-000000000111']}>
        <Routes>
          <Route element={<NoteDetailScreen />} path="/notes/:id" />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('NoteDetailScreen', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.getNote.mockResolvedValue(detail());
  });

  it('renders the AI summary in the main area and raw text in a transcript rail', async () => {
    renderScreen();

    expect(await screen.findByRole('heading', { name: 'Customer interview' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Decisions' })).toBeVisible();
    const rail = screen.getByRole('complementary', { name: 'Raw transcript' });
    expect(within(rail).getByText('The customer wants a smaller onboarding flow.')).toBeVisible();
    expect(within(rail).queryByText(/00:05|5,000|16,000/u)).not.toBeInTheDocument();
    expect(screen.getByText('Private')).toBeVisible();
  });

  it('shows handwritten content when a note has no generated summary', async () => {
    state.getNote.mockResolvedValue(detail({
      liveNotes: '',
      manualNotes: 'Pasted research notes',
      segments: [],
    }));
    renderScreen();

    expect(await screen.findByText('Pasted research notes')).toBeVisible();
    expect(screen.getByText('No transcript yet')).toBeVisible();
  });
});
