import * as Tooltip from '@radix-ui/react-tooltip';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AutomationDetail } from '../lib/types';
import { AutomationOverviewScreen } from './automation-overview';

const api = vi.hoisted(() => ({
  adoptAutomationUpdate: vi.fn(),
  getAutomation: vi.fn(),
  getConnections: vi.fn(),
  runAutomation: vi.fn(),
  setAutomationStatus: vi.fn(),
  shareAutomation: vi.fn(),
  updateAutomation: vi.fn(),
}));
const copyText = vi.hoisted(() => vi.fn());

vi.mock('../lib/app-session', () => ({ useAppSession: () => ({ api }) }));
vi.mock('../components/inspector-rail', () => ({ InspectorRail: () => null }));
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
  emailAddress: 'luminous-tidal-structured-curie@automation.with-avalon.com',
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
    vi.stubGlobal('ResizeObserver', class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    });
    api.getAutomation.mockResolvedValue(detail);
    api.getConnections.mockResolvedValue([]);
    api.adoptAutomationUpdate.mockResolvedValue({
      ...detail,
      statusMessage: undefined,
      versionNumber: 2,
      instructions: 'Summarize changes and decisions.',
      triggerSummary: 'Every Monday',
      scheduleSummary: 'Every Monday',
      templateUpdate: undefined,
    });
  });

  it('uses the shared connecting state while the automation opens', () => {
    api.getAutomation.mockImplementation(() => new Promise(() => undefined));
    renderScreen();

    expect(screen.getByRole('status')).toHaveTextContent('Opening automation…');
    expect(screen.getByTestId('thinking-orb')).toHaveAttribute('data-state', 'connecting');
    expect(screen.getByTestId('thinking-orb')).toHaveAttribute('data-size', '64');
  });

  it('keeps the pinned version until the user reviews and explicitly adopts the update', async () => {
    renderScreen();

    expect(await screen.findByText('Version 2 is available')).toBeVisible();
    expect(screen.getByText('Your automation stays on version 1 until you choose to update.')).toBeVisible();
    expect(api.adoptAutomationUpdate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Review update' }));

    const dialog = await screen.findByRole('dialog', { name: 'Review template update' });
    expect(within(dialog).getByText('Summarize changes.')).toBeVisible();
    expect(within(dialog).getByText('Summarize changes and decisions.')).toBeVisible();
    expect(within(dialog).getByText('Every Friday')).toBeVisible();
    expect(within(dialog).getByText('Every Monday')).toBeVisible();
    expect(within(dialog).getByText('A short weekly brief')).toBeVisible();
    expect(within(dialog).getByText('A concise weekly brief')).toBeVisible();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Adopt version 2' }));

    await waitFor(() => expect(api.adoptAutomationUpdate).toHaveBeenCalledWith(automationId, nextVersionId, {}));
    await waitFor(() => expect(screen.queryByText('Version 2 is available')).not.toBeInTheDocument());
    expect(screen.getByText('Summarize changes and decisions.')).toBeVisible();
  });

  it('preselects only workspace connections when adopting a workspace template update', async () => {
    api.getAutomation.mockResolvedValue({
      ...detail,
      scope: 'workspace',
      executionScope: 'Workspace',
      activitySourcePluginIds: { github_source: 'plugin_github_personal' },
      templateUpdate: {
        ...detail.templateUpdate!,
        activitySources: [{
          bindingKey: 'github_source',
          connectorType: 'github',
          suggestedPluginId: 'plugin_github_personal',
        }],
      },
    });
    api.getConnections.mockResolvedValue([
      {
        id: 'connection-github-personal',
        modelPluginId: 'plugin_github_personal',
        connectorType: 'github',
        displayName: 'GitHub · Personal',
        scope: 'personal',
        status: 'healthy',
        capabilities: [],
      },
      {
        id: 'connection-github-workspace',
        modelPluginId: 'plugin_github_workspace',
        connectorType: 'github',
        displayName: 'GitHub · Workspace',
        scope: 'workspace',
        status: 'healthy',
        capabilities: [],
      },
    ]);
    renderScreen();

    fireEvent.click(await screen.findByRole('button', { name: 'Review update' }));
    const dialog = await screen.findByRole('dialog', { name: 'Review template update' });
    const select = within(dialog).getByRole('combobox', { name: 'Connector for github_source' });
    await waitFor(() => expect(select).toHaveValue('plugin_github_workspace'));
    expect(within(select).queryByRole('option', { name: 'GitHub · Personal' })).not.toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Adopt version 2' }));
    await waitFor(() => expect(api.adoptAutomationUpdate).toHaveBeenCalledWith(
      automationId,
      nextVersionId,
      { github_source: 'plugin_github_workspace' },
    ));
  });

  it('shows the permanent email trigger and copies it from an icon button', async () => {
    renderScreen();

    const emailAddress = await screen.findByText('luminous-tidal-structured-curie@automation.with-avalon.com');
    expect(emailAddress).toBeVisible();
    expect(emailAddress).toHaveClass('automation-email-value');
    expect(screen.getByText('Email this address from your Avalon account email to start a new work stream.')).toBeVisible();

    const copyButton = screen.getByRole('button', { name: 'Copy automation email' });
    expect(copyButton).toHaveAttribute('title', 'Copy automation email');
    expect(copyButton).not.toHaveTextContent('luminous-tidal-structured-curie@automation.with-avalon.com');
    fireEvent.click(copyButton);
    expect(copyText).toHaveBeenCalledWith('luminous-tidal-structured-curie@automation.with-avalon.com');
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

    expect(await screen.findByRole('heading', { name: 'Runs' })).toBeVisible();
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

  it('explains that workspace automation mail must come from a workspace member', async () => {
    api.getAutomation.mockResolvedValue({ ...detail, scope: 'workspace' });
    renderScreen();

    expect(await screen.findByText(
      'Email this address from a workspace member email to start a new work stream.',
    )).toBeVisible();
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
