import * as Tooltip from '@radix-ui/react-tooltip';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setCachedWorkstreams } from '../lib/workstreams-cache';
import type { AutomationDetail } from '../lib/types';
import { AutomationScreen } from './automation';

const getAutomation = vi.hoisted(() => vi.fn());
const getAutomationRuns = vi.hoisted(() => vi.fn());
const setAutomationAppearance = vi.hoisted(() => vi.fn());
const archiveAutomation = vi.hoisted(() => vi.fn());
const getSidekickDelegates = vi.hoisted(() => vi.fn());
const createAutomation = vi.hoisted(() => vi.fn());
const shell = vi.hoisted(() => ({ host: 'desktop' as 'desktop' | 'browser' }));
vi.mock('../lib/collaboration-session', () => ({
  useOptionalCollaborationSession: () => null,
  useCollaborationSession: () => ({ api: { archiveAutomation, getAutomation, getAutomationRuns, setAutomationAppearance, getSidekickDelegates, createAutomation } }),
  useShellCapabilities: () => ({ host: shell.host, guest: false }),
}));
// The conversation beside the profile is its own surface with its own sockets,
// and none of it is what this file is about.
vi.mock('./conversation-surface', () => ({ ConversationSurface: () => <div /> }));

const SIDEKICK_ID = 'sidekick-1';

function detail(overrides: Partial<AutomationDetail> = {}): AutomationDetail {
  return {
    id: SIDEKICK_ID,
    name: 'Weekly changelog',
    description: 'Prepare a concise changelog every Friday.',
    scope: 'workspace',
    status: 'active',
    updatedAt: '2026-09-10T10:00:00.000Z',
    lifecycle: 'active',
    authorUserId: 'user-1',
    runAsUserId: 'user-1',
    currentDefinition: null,
    currentDefinitionRevision: 0,
    acceptedDefinitionRevision: null,
    connectorBindings: {},
    triggerSummaries: [],
    recentRuns: [],
    ...overrides,
  };
}

/**
 * The layout measures its own width to decide whether both panes fit, and jsdom
 * reports zero, so it renders compact — with the profile `inert` behind the
 * Conversation view. Switching to Details is what a person does there, and it
 * is what puts the hexagon in the accessibility tree.
 */
async function showProfile(): Promise<void> {
  fireEvent.click(await screen.findByRole('button', { name: 'Details' }));
}

function renderScreen(client: QueryClient, entry = `/sidekicks/${SIDEKICK_ID}`) {
  return render(
    <QueryClientProvider client={client}>
      <Tooltip.Provider>
        <MemoryRouter initialEntries={[entry]}>
          <Routes>
            <Route element={<AutomationScreen />} path="/sidekicks/:id" />
            <Route element={<div>Sidekicks library</div>} path="/sidekicks" />
          </Routes>
        </MemoryRouter>
      </Tooltip.Provider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  getAutomation.mockReset().mockResolvedValue(detail());
  getAutomationRuns.mockReset().mockResolvedValue([]);
  setAutomationAppearance.mockReset();
  archiveAutomation.mockReset().mockResolvedValue(undefined);
  getSidekickDelegates.mockReset().mockResolvedValue({ sidekickId: SIDEKICK_ID, creatorUserId: 'user-1', you: { userId: 'user-1', allowed: false }, delegates: [] });
  createAutomation.mockReset().mockResolvedValue({ automationId: SIDEKICK_ID });
  shell.host = 'desktop';
  window.location.hash = '';
});

describe('Sidekick creator disclosure', () => {
  it('shows the standing delegation and existing-history disclosure before the create action', async () => {
    renderScreen(new QueryClient({ defaultOptions: { queries: { retry: false } } }), '/sidekicks/new');
    expect(screen.getByText('Creating this Sidekick allows it to act as you. You can stop allowing it at any time.')).toBeInTheDocument();
    expect(screen.getByText(/everyone who can read its existing Sidekick history/u)).toBeInTheDocument();
    expect(createAutomation).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Create Sidekick' }));
    await showProfile();
    expect(screen.getByRole('heading', { name: 'Weekly changelog' })).toBeInTheDocument();
    expect(createAutomation).toHaveBeenCalledTimes(1);
  });

  it('does not take the person back into a creation they have left while it was pending', async () => {
    let acknowledge!: () => void;
    createAutomation.mockImplementation(() => new Promise((resolve) => { acknowledge = () => resolve({ automationId: SIDEKICK_ID }); }));
    renderScreen(new QueryClient({ defaultOptions: { queries: { retry: false } } }), '/sidekicks/new');
    fireEvent.click(screen.getByRole('button', { name: 'Create Sidekick' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByText('Sidekicks library')).toBeInTheDocument();
    await act(async () => acknowledge());
    expect(screen.getByText('Sidekicks library')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Weekly changelog' })).not.toBeInTheDocument();
  });
});

describe('AutomationScreen load failure', () => {
  it('offers a way back to the workspace in a browser tab, where the sidebar is hidden', async () => {
    shell.host = 'browser';
    getAutomation.mockRejectedValue(new Error('Sidekick not found'));
    renderScreen(new QueryClient({ defaultOptions: { queries: { retry: false } } }));
    fireEvent.click(await screen.findByRole('button', { name: 'OK' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(window.location.hash).toBe('#/');
  });

  it('leaves closing to the window in the Mac app', async () => {
    getAutomation.mockRejectedValue(new Error('Sidekick not found'));
    renderScreen(new QueryClient({ defaultOptions: { queries: { retry: false } } }));
    fireEvent.click(await screen.findByRole('button', { name: 'OK' }));
    expect(await screen.findByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();
  });
});

describe('AutomationScreen archival', () => {
  it('refreshes channels and leaves the archived Sidekick route', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    setCachedWorkstreams(client, []);
    renderScreen(client);
    await showProfile();

    fireEvent.pointerDown(screen.getByRole('button', { name: 'More Sidekick actions' }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Archive Sidekick' }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Archive Sidekick' }))
      .getByRole('button', { name: 'Archive' }));

    await screen.findByText('Sidekicks library');
    expect(archiveAutomation).toHaveBeenCalledWith(SIDEKICK_ID);
    expect(client.getQueryState(['workstreams'])?.isInvalidated).toBe(true);
  });
});

describe('AutomationScreen appearance saving', () => {
  it('keeps a newer Sidekick when an older appearance response lands after it', async () => {
    // The pick's response is held open, which is the window the defect lived
    // in: it is a whole Sidekick, and it was written to the cache whatever had
    // happened to that entry meanwhile.
    let settle!: (value: AutomationDetail) => void;
    setAutomationAppearance.mockImplementation(() => new Promise<AutomationDetail>((resolve) => { settle = resolve; }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderScreen(client);
    await showProfile();

    fireEvent.keyDown(await screen.findByRole('button', { name: 'Change Sidekick icon and color' }), { key: 'Enter' });
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'Rocket' }));
    await waitFor(() => expect(setAutomationAppearance).toHaveBeenCalledWith(SIDEKICK_ID, { icon: 'rocket' }));

    // Somebody else pauses it while the pick is still in flight — the shape of
    // every other writer of this entry, including the workspace socket's push.
    client.setQueryData<AutomationDetail>(['automation', SIDEKICK_ID], detail({
      lifecycle: 'paused',
      status: 'paused',
      appearance: { icon: 'rocket', color: null },
      updatedAt: '2026-09-10T10:00:05.000Z',
    }));
    expect(await screen.findByText('Paused')).toBeInTheDocument();

    // The pick's own answer, committed before that pause and so older than it.
    await act(async () => settle(detail({ appearance: { icon: 'rocket', color: null } })));

    // The pause survives. Writing the older response back would show an active
    // Sidekick that the server has already paused, and the push that would have
    // corrected it has been spent.
    expect(screen.getByText('Paused')).toBeInTheDocument();
    expect(screen.queryByText('Active')).toBeNull();
  });

  it('applies its own response when nothing newer arrived', async () => {
    setAutomationAppearance.mockResolvedValue(detail({
      appearance: { icon: 'rocket', color: 'purple' },
      updatedAt: '2026-09-10T10:00:05.000Z',
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderScreen(client);
    await showProfile();

    fireEvent.keyDown(await screen.findByRole('button', { name: 'Change Sidekick icon and color' }), { key: 'Enter' });
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'Purple' }));

    await waitFor(() => expect(client.getQueryData<AutomationDetail>(['automation', SIDEKICK_ID])?.appearance)
      .toEqual({ icon: 'rocket', color: 'purple' }));
  });
});
