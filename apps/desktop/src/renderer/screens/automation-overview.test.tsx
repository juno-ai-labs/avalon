import * as Tooltip from '@radix-ui/react-tooltip';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, RouterProvider, createMemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AutomationDetail } from '../lib/types';
import { AutomationOverviewScreen } from './automation-overview';

const api = vi.hoisted(() => ({
  adoptAutomationUpdate: vi.fn(),
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

  it('turns a delivery destination off from the automation itself', async () => {
    api.getAutomation.mockResolvedValue({
      ...detail,
      deliveryTargets: [{ type: 'email', connectionId: null, displayName: 'owner@example.com', status: 'active' }],
    });
    api.updateAutomation.mockResolvedValue({ ...detail, deliveryTargets: [] });
    renderScreen();

    const email = await screen.findByRole('checkbox', { name: /owner@example.com/ });
    expect(email).toBeChecked();
    fireEvent.click(email);

    // The only way to stop these emails used to be deleting the automation.
    await waitFor(() => expect(api.updateAutomation).toHaveBeenCalledWith(automationId, { deliveryTargets: [] }));
  });

  it('adds a destination without dropping the one already chosen', async () => {
    api.getConnections.mockResolvedValue([
      {
        id: 'connection-slack',
        modelPluginId: 'plugin_slack',
        connectorType: 'slack',
        displayName: 'Acme',
        scope: 'workspace',
        status: 'healthy',
        capabilities: ['slack.agent'],
        userDelivery: { targetType: 'slack_agent_dm', label: 'Slack DM', description: 'Avalon Agent DM.' },
      },
    ]);
    api.getAutomation.mockResolvedValue({
      ...detail,
      deliveryTargets: [{ type: 'email', connectionId: null, displayName: 'owner@example.com', status: 'active' }],
    });
    api.updateAutomation.mockResolvedValue(detail);
    renderScreen();

    fireEvent.click(await screen.findByRole('checkbox', { name: /Slack DM · Acme/ }));

    // The API replaces the whole set, so a payload carrying only the box that
    // moved would silently turn the email off.
    await waitFor(() => expect(api.updateAutomation).toHaveBeenCalledWith(automationId, {
      deliveryTargets: [{ type: 'email' }, { type: 'slack_agent_dm', connectionId: 'connection-slack' }],
    }));
  });

  it('still offers a destination whose connection is gone, so it can be turned off', async () => {
    // Unlinking or disabling a connection retains the delivery-target row. Built
    // from the live connection list alone the row vanished from the screen while
    // still delivering, and — because every payload this screen sends carries
    // the whole set — it was replayed into each one and rejected, so no
    // destination could be changed at all until the automation was deleted.
    api.getConnections.mockResolvedValue([]);
    api.getAutomation.mockResolvedValue({
      ...detail,
      deliveryTargets: [
        { type: 'email', connectionId: null, displayName: 'owner@example.com', status: 'active' },
        { type: 'slack_agent_dm', connectionId: 'connection-slack', displayName: 'Slack DM · Acme', status: 'active' },
      ],
    });
    api.updateAutomation.mockResolvedValue(detail);
    renderScreen();

    const orphan = await screen.findByRole('checkbox', { name: /Slack DM · Acme/ });
    expect(orphan).toBeChecked();
    expect(screen.getByText('Disconnected — turn off to stop trying')).toBeInTheDocument();

    fireEvent.click(orphan);

    await waitFor(() => expect(api.updateAutomation).toHaveBeenCalledWith(automationId, {
      deliveryTargets: [{ type: 'email' }],
    }));
  });

  it('replaces a same-kind destination rather than composing a set the API refuses', async () => {
    api.getConnections.mockResolvedValue([
      {
        id: 'connection-slack',
        modelPluginId: 'plugin_slack',
        connectorType: 'slack',
        displayName: 'Acme',
        scope: 'workspace',
        status: 'healthy',
        capabilities: ['slack.agent'],
        userDelivery: { targetType: 'slack_agent_dm', label: 'Slack DM', description: 'Avalon Agent DM.' },
      },
      {
        id: 'connection-slack-2',
        modelPluginId: 'plugin_slack_personal',
        connectorType: 'slack',
        displayName: 'Side project',
        scope: 'personal',
        status: 'healthy',
        capabilities: ['slack.agent'],
        userDelivery: { targetType: 'slack_agent_dm', label: 'Slack DM', description: 'Avalon Agent DM.' },
      },
    ]);
    api.getAutomation.mockResolvedValue({
      ...detail,
      deliveryTargets: [{ type: 'slack_agent_dm', connectionId: 'connection-slack', displayName: 'Slack DM · Acme', status: 'active' }],
    });
    api.updateAutomation.mockResolvedValue(detail);
    renderScreen();

    fireEvent.click(await screen.findByRole('checkbox', { name: /Slack DM · Side project/ }));

    // The table holds one row per kind, so two installations offering the same
    // surface are one destination. Appending the second composed a set the API
    // rejects, and the reader got an unexplained failure for a plain click.
    await waitFor(() => expect(api.updateAutomation).toHaveBeenCalledWith(automationId, {
      deliveryTargets: [{ type: 'slack_agent_dm', connectionId: 'connection-slack-2' }],
    }));
  });

  it('says when a destination stopped delivering', async () => {
    api.getAutomation.mockResolvedValue({
      ...detail,
      deliveryTargets: [{ type: 'email', connectionId: null, displayName: 'owner@example.com', status: 'needs_input' }],
    });
    renderScreen();

    // A frozen address that starts bouncing is marked needs_input and stops
    // delivering; without this the automation looks like it is still emailing.
    expect(await screen.findByText('Last delivery failed')).toBeInTheDocument();
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
