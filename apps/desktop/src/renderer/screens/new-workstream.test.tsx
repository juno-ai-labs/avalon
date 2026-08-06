import * as Tooltip from '@radix-ui/react-tooltip';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Workspace, WorkstreamSummary } from '../lib/types';
import { NewWorkstreamScreen } from './new-workstream';

const api = vi.hoisted(() => ({
  createWorkstream: vi.fn(),
  getWorkspaceMembers: vi.fn(),
  getWorkstreams: vi.fn(),
}));

vi.mock('../lib/app-session', () => ({ useAppSession: () => ({ api }) }));

const currentUser = { id: 'user-1', name: 'Adam Juhasz', email: 'adam@example.com', timezone: 'America/Los_Angeles' };
const teammate = { id: 'user-2', name: 'Samantha Lee', email: 'samantha@example.com', timezone: 'America/Los_Angeles' };
const workspace: Workspace = {
  id: 'workspace-1',
  name: 'Avalon Studio',
  region: 'global',
  timezone: 'America/Los_Angeles',
  logAgentInference: false,
  currentUser,
};
const createdWorkstream = {
  workstream: workstream('new-workstream', 'Prepare the launch brief', 'running'),
  messageId: 'message-new-workstream',
  clientMessageId: 'client-new-workstream',
  createdAt: '2026-07-31T20:00:00.000Z',
};

function workstream(id: string, title: string, harnessStatus: WorkstreamSummary['harnessStatus']): WorkstreamSummary {
  return {
    id,
    title,
    origin: 'ad_hoc',
    harnessStatus,
    lastActivityAt: '2026-07-31T20:00:00.000Z',
    latestAttentionSequenceNumber: 0,
    readThroughSequenceNumber: 0,
    manualUnreadFromSequenceNumber: null,
    manualUnreadGeneration: 0,
    hasUnread: false,
    firstUnreadSequenceNumber: null,
    preview: `${title} preview`,
  };
}

function renderScreen(): QueryClient {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  render(
    <Tooltip.Provider>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/workstreams/new']}>
          <Routes>
            <Route element={<NewWorkstreamScreen workspace={workspace} />} path="/workstreams/new" />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </Tooltip.Provider>,
  );
  return queryClient;
}

describe('New work-stream home', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('ResizeObserver', class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    });
    api.getWorkspaceMembers.mockResolvedValue([currentUser, teammate]);
    api.getWorkstreams.mockResolvedValue([
      workstream('waiting', 'Board decision', 'needs_input'),
      workstream('running', 'Pricing restructure', 'running'),
      workstream('completed', 'Release notes', 'completed'),
      workstream('failed', 'Broken connector', 'failed'),
    ]);
    api.createWorkstream.mockResolvedValue(createdWorkstream);
  });

  it('shows only work streams explicitly waiting for input', async () => {
    renderScreen();

    expect(await screen.findByRole('heading', { name: 'Welcome back, Adam' })).toBeVisible();
    const waiting = await screen.findByRole('region', { name: 'Waiting for input' });
    expect(within(waiting).getByRole('link', { name: /Board decision/u })).toHaveAttribute('href', '/workstreams/waiting');
    expect(within(waiting).getByText('Needs input')).toBeVisible();
    expect(screen.queryByText('Pricing restructure')).not.toBeInTheDocument();
    expect(screen.queryByText('Release notes')).not.toBeInTheDocument();
    expect(screen.queryByText('Broken connector')).not.toBeInTheDocument();
  });

  it('uses the shared mention, attachment, and dictation controls', async () => {
    renderScreen();

    expect(await screen.findByRole('button', { name: 'Mention a participant or connection' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Attach a file' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Click or hold to dictate' })).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Mention a participant or connection' }));
    expect(await screen.findByRole('dialog', { name: 'Add people' })).toBeVisible();
  });

  it('keeps participant selection above the composer and sends selected people', async () => {
    renderScreen();

    const modifier = await screen.findByRole('button', { name: 'Manage participants: Adam Juhasz' });
    expect(modifier).toBeVisible();
    fireEvent.click(modifier);

    const dialog = await screen.findByRole('dialog', { name: 'Add people' });
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /Samantha Lee/u }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Done' }));

    expect(screen.getByRole('button', { name: 'Manage participants: Adam Juhasz, Samantha Lee' })).toHaveTextContent('Adam Juhasz, Samantha Lee');
    expect(screen.getByRole('button', { name: 'Add people' })).toBeVisible();
    const composer = screen.getByRole('textbox', { name: 'Opening work-stream message' });
    fireEvent.change(composer, { target: { value: '  Prepare the launch brief  ' } });
    fireEvent.keyDown(composer, { key: 'Enter' });

    await waitFor(() => expect(api.createWorkstream).toHaveBeenCalledWith({
      openingMessage: 'Prepare the launch brief',
      participantIds: ['user-2'],
    }));
  });

  it('clears the submitted message before the create request settles and blocks duplicate submission', async () => {
    let resolveCreate!: (value: typeof createdWorkstream) => void;
    api.createWorkstream.mockReturnValue(new Promise((resolve) => {
      resolveCreate = resolve;
    }));
    renderScreen();

    const composer = await screen.findByRole('textbox', { name: 'Opening work-stream message' });
    fireEvent.change(composer, { target: { value: 'Create this once' } });
    fireEvent.keyDown(composer, { key: 'Enter' });
    fireEvent.keyDown(composer, { key: 'Enter' });

    expect(composer).toHaveValue('');
    await waitFor(() => expect(api.createWorkstream).toHaveBeenCalledTimes(1));
    expect(api.createWorkstream).toHaveBeenCalledWith({
      openingMessage: 'Create this once',
      participantIds: [],
    });

    resolveCreate(createdWorkstream);
    await waitFor(() => expect(api.createWorkstream).toHaveBeenCalledTimes(1));
  });

  it('seeds the new work-stream detail and opening message before navigation', async () => {
    const queryClient = renderScreen();
    const composer = await screen.findByRole('textbox', { name: 'Opening work-stream message' });
    fireEvent.change(composer, { target: { value: 'Prepare the launch brief' } });
    fireEvent.keyDown(composer, { key: 'Enter' });

    await waitFor(() => expect(queryClient.getQueryData(['workstream', 'new-workstream'])).toMatchObject({
      id: 'new-workstream',
      participants: [{ id: currentUser.id, role: 'creator' }],
    }));
    expect(queryClient.getQueryData(['messages', 'new-workstream'])).toEqual([
      expect.objectContaining({
        id: createdWorkstream.messageId,
        clientMessageId: createdWorkstream.clientMessageId,
        text: 'Prepare the launch brief',
      }),
    ]);
  });

  it('restores an immediately cleared message when creation fails without replacing a newer draft', async () => {
    api.createWorkstream.mockRejectedValueOnce(new Error('offline'));
    renderScreen();

    const composer = await screen.findByRole('textbox', { name: 'Opening work-stream message' });
    fireEvent.change(composer, { target: { value: 'Retry this request' } });
    fireEvent.keyDown(composer, { key: 'Enter' });

    expect(composer).toHaveValue('');
    await waitFor(() => expect(composer).toHaveValue('Retry this request'));
    expect(await screen.findByText('offline')).toBeVisible();
  });

});
