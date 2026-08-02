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

const currentUser = { id: 'user-1', name: 'Adam Juhasz', email: 'adam@example.com' };
const teammate = { id: 'user-2', name: 'Samantha Lee', email: 'samantha@example.com' };
const workspace: Workspace = {
  id: 'workspace-1',
  name: 'Avalon Studio',
  region: 'global',
  currentUser,
};

function workstream(id: string, title: string, harnessStatus: WorkstreamSummary['harnessStatus']): WorkstreamSummary {
  return {
    id,
    title,
    origin: 'ad_hoc',
    harnessStatus,
    lastActivityAt: '2026-07-31T20:00:00.000Z',
    preview: `${title} preview`,
  };
}

function renderScreen(): void {
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
    api.createWorkstream.mockResolvedValue({ id: 'new-workstream' });
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
});
