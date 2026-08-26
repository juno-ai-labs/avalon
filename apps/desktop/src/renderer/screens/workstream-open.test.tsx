import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as Tooltip from '@radix-ui/react-tooltip';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  clientFeatureFlags: vi.fn(),
  getMessagePage: vi.fn(),
  getWorkspaceMembers: vi.fn(),
  getWorkstream: vi.fn(),
}));
const retainedSocket = vi.hoisted(() => vi.fn());

vi.mock('../lib/app-session', () => ({
  useAppSession: () => ({ api, session: null }),
}));

vi.mock('../lib/use-client-feature-flags', () => ({
  useClientFeatureFlags: () => ({ data: { hypersightEnabled: false } }),
}));

vi.mock('../lib/workstream-socket-pool', () => ({
  useWorkstreamSocketOpenContext: () => () => ({}),
  useRetainedWorkstreamSocket: retainedSocket,
}));

vi.mock('../lib/use-file-attachments', () => ({
  useFileAttachments: () => ({
    addFiles: vi.fn(),
    attachments: [],
    consume: vi.fn(),
    error: undefined,
    ready: [],
    removeAttachment: vi.fn(),
    retryAttachment: vi.fn(),
    uploading: false,
  }),
}));

vi.mock('../lib/use-transcript-follow', () => ({
  TRANSCRIPT_END_SLACK: 24,
  useTranscriptFollow: () => ({
    atEnd: true,
    onScroll: vi.fn(),
    onWheel: vi.fn(),
    release: vi.fn(),
    scrollTo: vi.fn(),
    scrollToEnd: vi.fn(),
  }),
}));

vi.mock('../lib/use-block-dashboard-sockets', () => ({
  useBlockDashboardSockets: () => new Map(),
}));

import { WorkstreamScreen } from './workstream';

const workstreamId = '00000000-0000-7000-8000-000000000650';

function renderScreen(): void {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  render(
    <Tooltip.Provider>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[`/workstreams/${workstreamId}`]}>
          <Routes>
            <Route element={<WorkstreamScreen />} path="/workstreams/:id" />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </Tooltip.Provider>,
  );
}

describe('socket-first work-stream open', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getWorkspaceMembers.mockResolvedValue([]);
    retainedSocket.mockReturnValue({
      activeCompaction: null,
      createMessage: vi.fn(),
      loadMessagePage: vi.fn(),
      sendReady: false,
      state: 'connecting',
      workspaceSocketState: 'connecting',
    });
  });

  it('admits the feed while the snapshot is pending without starting REST boot readers', async () => {
    renderScreen();

    expect(screen.getByText('Opening work stream…')).toBeInTheDocument();
    await waitFor(() => expect(retainedSocket).toHaveBeenCalledWith(api, workstreamId, true));
    expect(api.getWorkstream).not.toHaveBeenCalled();
    expect(api.getMessagePage).not.toHaveBeenCalled();
  });

  it('runs the REST boot only when an unavailable feed is retried explicitly', async () => {
    retainedSocket.mockReturnValue({
      activeCompaction: null,
      createMessage: vi.fn(),
      loadMessagePage: vi.fn(),
      sendReady: false,
      state: 'unavailable',
      workspaceSocketState: 'connecting',
    });
    api.getWorkstream.mockRejectedValue(new Error('recovery unavailable'));
    renderScreen();

    expect(await screen.findByText('Work stream could not be opened')).toBeInTheDocument();
    expect(api.getWorkstream).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    await waitFor(() => expect(api.getWorkstream).toHaveBeenCalledTimes(1));
    expect(api.getMessagePage).not.toHaveBeenCalled();
  });
});
