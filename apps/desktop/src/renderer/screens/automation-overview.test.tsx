import * as Tooltip from '@radix-ui/react-tooltip';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, RouterProvider, createMemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AutomationDetail } from '../lib/types';
import { AutomationOverviewScreen } from './automation-overview';

const api = vi.hoisted(() => ({
  deleteAutomation: vi.fn(),
  getAutomation: vi.fn(),
  getConnections: vi.fn(),
  runAutomation: vi.fn(),
  setAutomationStatus: vi.fn(),
  shareAutomation: vi.fn(),
  updateAutomation: vi.fn(),
}));
const copyText = vi.hoisted(() => vi.fn());
const featureFlags = vi.hoisted(() => ({
  current: { automationWorkspaceTemplatesEnabled: true },
}));

vi.mock('../lib/app-session', () => ({
  useAppSession: () => ({ api, session: { user: { email: 'owner@example.com' } } }),
}));
vi.mock('../components/inspector-rail', () => ({ InspectorRail: () => null }));
vi.mock('../lib/use-client-feature-flags', () => ({
  useClientFeatureFlags: () => ({ data: featureFlags.current }),
}));
vi.mock('../lib/platform', () => ({
  desktopBridge: () => ({ copyText }),
}));
vi.mock('thinking-orbs', () => ({
  ThinkingOrb: ({ size, state }: { size: number; state: string }) => (
    <span data-size={size} data-state={state} data-testid="thinking-orb" />
  ),
}));

const automationId = '00000000-0000-7000-8000-000000000008';
const nextVersionId = '00000000-0000-7000-8000-000000000011';
const detail: AutomationDetail = {
  id: automationId,
  name: 'Weekly brief',
  emailAddress: 'luminous-tidal-structured-curie@automation.rallywith.ai',
  description: 'A concise weekly status brief.',
  scope: 'you',
  status: 'active',
  statusMessage: 'Update available',
  updatedAt: '2026-08-01T09:00:00.000Z',
  versionNumber: 1,
  overview: 'A short weekly brief of recent changes.',
  instructions: 'Summarize changes.',
  triggerSummary: 'Every Friday',
  scheduleSummary: 'Every Friday',
  capabilities: ['gmail.read'],
  expectedOutputs: ['A short weekly brief'],
  recommendedPlugins: [],
  defaultPluginIds: [],
  activitySourcePluginIds: {},
  activitySources: [],
  executionScope: 'You',
  runs: [],
  templateUpdate: {
    versionId: nextVersionId,
    versionNumber: 2,
    overview: 'A concise weekly brief of changes and decisions.',
    instructions: 'Summarize changes and decisions.',
    triggerSummary: 'Every Monday',
    capabilities: ['gmail.read'],
    expectedOutputs: ['A concise weekly brief'],
    recommendedPlugins: [],
    activitySources: [],
  },
};

function renderScreen(): QueryClient {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  render(
    <Tooltip.Provider>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[`/automations/${automationId}`]}>
          <Routes>
            <Route element={<AutomationOverviewScreen />} path="/automations/:id" />
            <Route element={<p>New work stream</p>} path="/workstreams/new" />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </Tooltip.Provider>,
  );
  return queryClient;
}

describe('Automation template updates', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    copyText.mockResolvedValue(undefined);
    featureFlags.current = { automationWorkspaceTemplatesEnabled: true };
    vi.stubGlobal('ResizeObserver', class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    });
    api.getAutomation.mockResolvedValue(detail);
    api.getConnections.mockResolvedValue([]);
    api.deleteAutomation.mockResolvedValue(undefined);
  });

  it('hides publishing and update adoption while Automation Workspace Templates Enabled is false', async () => {
    featureFlags.current = { automationWorkspaceTemplatesEnabled: false };

    renderScreen();

    expect(await screen.findByRole('heading', { name: 'Weekly brief' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Share' })).not.toBeInTheDocument();
    expect(screen.queryByText('Version 2 is available')).not.toBeInTheDocument();
  });

  it('uses the shared connecting state while the automation opens', () => {
    api.getAutomation.mockImplementation(() => new Promise(() => undefined));
    renderScreen();

    expect(screen.getByRole('status')).toHaveTextContent('Opening automation…');
    expect(screen.getByTestId('thinking-orb')).toHaveAttribute('data-state', 'connecting');
    expect(screen.getByTestId('thinking-orb')).toHaveAttribute('data-size', '64');
  });

  it('shows the permanent email trigger and copies it from an icon button', async () => {
    renderScreen();

    const emailAddress = await screen.findByText('luminous-tidal-structured-curie@automation.rallywith.ai');
    expect(emailAddress).toBeVisible();
    expect(emailAddress).toHaveClass('automation-email-value');
    expect(screen.getByText('Email this address from your Rally account email to start a new work stream.')).toBeVisible();

    const copyButton = screen.getByRole('button', { name: 'Copy automation email' });
    expect(copyButton).toHaveAttribute('title', 'Copy automation email');
    expect(copyButton).not.toHaveTextContent('luminous-tidal-structured-curie@automation.rallywith.ai');
    fireEvent.click(copyButton);
    expect(copyText).toHaveBeenCalledWith('luminous-tidal-structured-curie@automation.rallywith.ai');
    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('Automation email address copied.');
    });
    expect(screen.getByRole('button', { name: 'Copy automation email' })).toHaveAttribute('title', 'Copy automation email');
  });

  it('uses a lime circular status indicator without duplicating status in the header', async () => {
    renderScreen();

    const statusHeading = await screen.findByRole('heading', { name: 'Status' });
    const statusSection = statusHeading.closest('section');
    expect(statusSection?.querySelector('.automation-status-dot')).toHaveClass('active');
    expect(document.querySelector('.automation-overview-header .automation-state')).not.toBeInTheDocument();
  });

  it('shows only supported run filters and omits connected capabilities', async () => {
    renderScreen();

    // "Recent runs", not "Runs": the API returns the newest
    // page rather than every run there has ever been.
    expect(await screen.findByRole('heading', { name: 'Recent runs' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Connected capabilities' })).not.toBeInTheDocument();

    const filters = screen.getByRole('group', { name: 'Filter automation runs' });
    expect(within(filters).getAllByRole('button').map((button) => button.textContent)).toEqual([
      'All',
      'Scheduled',
      'Manual',
    ]);
    expect(within(filters).queryByRole('button', { name: 'Activity' })).not.toBeInTheDocument();
    expect(within(filters).queryByRole('button', { name: 'Webhook' })).not.toBeInTheDocument();
  });

  it('separates one run from the next by what started it and how it ended', async () => {
    api.getAutomation.mockResolvedValue({
      ...detail,
      runs: [
        {
          id: 'run-1',
          workstreamId: 'workstream-1',
          // Every run of an automation is titled after the
          // automation, so the title cannot tell two apart.
          title: 'Weekly brief',
          status: 'failed',
          triggerType: 'scheduled',
          triggerTime: '2026-08-01T09:00:00.000Z',
        },
        {
          id: 'run-2',
          workstreamId: 'workstream-2',
          title: 'Weekly brief',
          status: 'completed',
          triggerType: 'manual',
          triggerTime: '2026-07-25T09:00:00.000Z',
          resultSummary: 'Three merged PRs.',
        },
      ],
    });
    renderScreen();

    await screen.findByRole('heading', { name: 'Recent runs' });
    const rows = document.querySelectorAll('.automation-run-row');
    expect([...rows].map((row) => row.querySelector('strong')?.textContent))
      .toEqual(['On schedule', 'Run now']);
    // A failed run said "No result summary", which reads as an
    // absence rather than as the thing that happened.
    expect([...rows].map((row) => row.querySelector('small')?.textContent))
      .toEqual(['Failed', 'Three merged PRs.']);
    // The compact dot carries no visible label, so without a
    // tooltip its colour is the only thing saying how a run ended.
    expect(rows[0]?.querySelector('.status-indicator')).toHaveClass('status-compact');
    // Tooltip-wrapped, so the colour is explained on hover
    // rather than being the only thing that carries it.
    expect(rows[0]?.querySelector('.status-indicator')).toHaveAttribute('data-state');
    expect(screen.getByText('Last 2')).toBeVisible();
  });

  it('says in words why a carried-over automation stopped, and that it will not run again', async () => {
    api.getAutomation.mockResolvedValue({ ...detail, status: 'paused', attention: 'unsupported_trigger' });
    renderScreen();

    // Before this, the whole account of what happened was the word "Paused"
    // beside a dot — for an automation that is not waiting for anything.
    expect(await screen.findByText('This automation will not run')).toBeVisible();
    expect(screen.getByText(
      'Rally was upgraded, and the trigger that used to start this automation did not survive the move. '
      + 'It will not run again on its own. Create it again with a trigger Rally supports to bring it back.',
    )).toBeVisible();
  });

  it('says nothing extra about an automation nothing is wrong with', async () => {
    renderScreen();

    await screen.findByRole('heading', { name: 'Weekly brief' });
    expect(screen.queryByLabelText('Automation needs attention')).not.toBeInTheDocument();
  });

  it('explains that workspace automation mail must come from a workspace member', async () => {
    api.getAutomation.mockResolvedValue({ ...detail, scope: 'workspace' });
    renderScreen();

    expect(await screen.findByText(
      'Email this address from a workspace member email to start a new work stream.',
    )).toBeVisible();
  });

  it('deletes the automation from the header menu only after the confirmation dialog', async () => {
    const queryClient = renderScreen();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    await screen.findByRole('heading', { name: 'Weekly brief' });

    fireEvent.pointerDown(screen.getByRole('button', { name: 'More automation actions' }), {
      button: 0,
      ctrlKey: false,
    });
    const item = await screen.findByRole('menuitem', { name: 'Delete automation' });
    expect(item).not.toHaveAttribute('data-disabled');
    expect(item).toHaveClass('menu-item-danger');
    fireEvent.click(item);

    const dialog = await screen.findByRole('dialog', { name: 'Delete automation' });
    expect(within(dialog).getByText('Weekly brief')).toBeVisible();
    expect(api.deleteAutomation).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Delete automation' })).not.toBeInTheDocument());
    expect(api.deleteAutomation).not.toHaveBeenCalled();

    fireEvent.pointerDown(screen.getByRole('button', { name: 'More automation actions' }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete automation' }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Delete automation' })).getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(api.deleteAutomation).toHaveBeenCalledWith(automationId));
    // The screen the automation was deleted from cannot stay open on it.
    expect(await screen.findByText('New work stream')).toBeVisible();
    // The automation list is pushed by WorkspaceDO off the delete's own write,
    // so invalidating it here would refetch nothing and imply that it does.
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ['automations'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['workstreams'] });
    // Nothing may render the deleted automation from cache on a later mount.
    expect(queryClient.getQueryData(['automation', automationId])).toBeUndefined();
  });

  it('leaves no history entry that can navigate back into the deleted automation', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
    });
    const router = createMemoryRouter(
      [
        { path: '/workstreams/new', element: <p>New work stream</p> },
        { path: '/automations/:id', element: <AutomationOverviewScreen /> },
      ],
      { initialEntries: ['/workstreams/new', `/automations/${automationId}`], initialIndex: 1 },
    );
    render(
      <Tooltip.Provider>
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </Tooltip.Provider>,
    );
    await screen.findByRole('heading', { name: 'Weekly brief' });

    fireEvent.pointerDown(screen.getByRole('button', { name: 'More automation actions' }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete automation' }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Delete automation' })).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(api.deleteAutomation).toHaveBeenCalledWith(automationId));
    expect(await screen.findByText('New work stream')).toBeVisible();

    // Back must not resurrect the automation that was just deleted: the route
    // it was on was replaced, so there is nothing behind it to return to.
    await act(async () => {
      await router.navigate(-1);
    });
    expect(screen.queryByRole('heading', { name: 'Weekly brief' })).not.toBeInTheDocument();
    expect(router.state.location.pathname).not.toBe(`/automations/${automationId}`);
  });

  it('does not greet a reopened delete dialog with the previous attempt’s error', async () => {
    api.deleteAutomation.mockRejectedValueOnce(new Error('Automation could not be deleted.'));
    renderScreen();
    await screen.findByRole('heading', { name: 'Weekly brief' });

    fireEvent.pointerDown(screen.getByRole('button', { name: 'More automation actions' }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete automation' }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Delete automation' })).getByRole('button', { name: 'Delete' }));
    expect(await screen.findByText('Automation could not be deleted.')).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Delete automation' })).not.toBeInTheDocument());

    fireEvent.pointerDown(screen.getByRole('button', { name: 'More automation actions' }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete automation' }));
    const reopened = await screen.findByRole('dialog', { name: 'Delete automation' });
    expect(within(reopened).queryByText('Automation could not be deleted.')).not.toBeInTheDocument();
  });

  it('keeps the automation open when the delete fails, and says why', async () => {
    api.deleteAutomation.mockRejectedValueOnce(new Error('Automation could not be deleted.'));
    renderScreen();
    await screen.findByRole('heading', { name: 'Weekly brief' });

    fireEvent.pointerDown(screen.getByRole('button', { name: 'More automation actions' }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete automation' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete automation' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

    expect(await within(dialog).findByText('Automation could not be deleted.')).toBeVisible();
    expect(screen.queryByText('New work stream')).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Delete' })).toBeEnabled();
  });

  it('keeps the automation copy control retryable when the clipboard write fails', async () => {
    copyText.mockRejectedValueOnce(new Error('clipboard unavailable'));
    renderScreen();

    fireEvent.click(await screen.findByRole('button', { name: 'Copy automation email' }));
    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('could not be copied');
    });
    expect(screen.getByRole('button', { name: 'Copy automation email' })).toHaveAttribute('title', 'Copy automation email');
  });
});
