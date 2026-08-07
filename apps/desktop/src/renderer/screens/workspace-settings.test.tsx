import * as Tooltip from '@radix-ui/react-tooltip';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Workspace, WorkspaceInvitation } from '../lib/types';
import { WorkspaceSettingsScreen } from './workspace-settings';

const api = vi.hoisted(() => ({
  createWorkspaceInvitation: vi.fn(),
  getWorkspaceInvitations: vi.fn(),
  getWorkspaceMembers: vi.fn(),
  getConnections: vi.fn(),
  createXConnection: vi.fn(),
  getConnectorOAuthAttempt: vi.fn(),
  startProviderConnection: vi.fn(),
  reconnectConnection: vi.fn(),
  testConnection: vi.fn(),
  getSlackAgentPolicy: vi.fn(),
  updateSlackAgentPolicy: vi.fn(),
  disconnectConnection: vi.fn(),
  revokeWorkspaceInvitation: vi.fn(),
  updateWorkspaceLogAgentInference: vi.fn(),
}));
const copyText = vi.hoisted(() => vi.fn());
const openExternal = vi.hoisted(() => vi.fn());
const getApplicationIcon = vi.hoisted(() => vi.fn());
const setApplicationIcon = vi.hoisted(() => vi.fn());
const resetApplicationIcon = vi.hoisted(() => vi.fn());
const getApplicationSettings = vi.hoisted(() => vi.fn());
const setLockdownMode = vi.hoisted(() => vi.fn());
const signOut = vi.hoisted(() => vi.fn());
const settingsSectionRequest = vi.hoisted(() => ({
  listener: null as ((section: string) => void) | null,
}));

vi.mock('../lib/app-session', () => ({
  useAppSession: () => ({
    api,
    runtime: {
      appVersion: '0.1.0',
      isPackaged: false,
      platform: 'darwin',
      api: { global: 'https://api.with-avalon.com', eu: 'https://eu.api.with-avalon.com' },
      devAuthEnabled: true,
    },
    session: { apiBaseUrl: 'https://eu.api.with-avalon.com' },
    signOut,
  }),
}));
vi.mock('../lib/platform', () => ({
  desktopBridge: () => ({
    copyText,
    getApplicationSettings,
    setLockdownMode,
    onApplicationSettingsChanged: () => () => undefined,
    getApplicationIcon,
    setApplicationIcon,
    resetApplicationIcon,
    onApplicationIconChanged: () => () => undefined,
    openExternal,
    onSettingsSectionRequested: (listener: (section: string) => void) => {
      settingsSectionRequest.listener = listener;
      return () => {
        if (settingsSectionRequest.listener === listener) settingsSectionRequest.listener = null;
      };
    },
  }),
}));

const owner = { id: 'user-1', name: 'Adam', email: 'adam@example.com', timezone: 'America/Los_Angeles', role: 'owner' };
const member = { id: 'user-2', name: 'Sam', email: 'sam@example.com', timezone: 'America/Los_Angeles', role: 'member' };
const workspace: Workspace = {
  id: 'workspace-1',
  name: 'Avalon Studio',
  region: 'eu',
  timezone: 'Europe/London',
  logAgentInference: false,
  currentUser: owner,
};
const invitation: WorkspaceInvitation = {
  id: '00000000-0000-7000-8000-000000000009',
  email: 'invitee@example.com',
  role: 'member',
  status: 'pending',
  invitedByName: 'Adam',
  expiresAt: '2026-08-08T00:00:00.000Z',
  acceptedAt: null,
  createdAt: '2026-08-01T00:00:00.000Z',
};
const inviteUrl = 'https://with-avalon.com/invite/#region=eu&token=private-token-value-long-enough';

function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
}

function renderSettings(nextWorkspace: Workspace = workspace, client = createTestQueryClient()): void {
  render(
    <Tooltip.Provider>
      <QueryClientProvider client={client}>
        <WorkspaceSettingsScreen workspace={nextWorkspace} />
      </QueryClientProvider>
    </Tooltip.Provider>,
  );
}

function openSettingsSection(name: 'Account' | 'Workspace' | 'Connections' | 'Application'): void {
  const navigation = screen.getByRole('navigation', { name: 'Settings sections' });
  fireEvent.click(within(navigation).getByRole('button', { name }));
}

describe('Workspace settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('ResizeObserver', class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    });
    window.history.replaceState({}, '', '/');
    settingsSectionRequest.listener = null;
    api.getWorkspaceMembers.mockResolvedValue([owner, member]);
    api.getWorkspaceInvitations.mockResolvedValue([invitation]);
    api.getConnections.mockResolvedValue([]);
    api.getSlackAgentPolicy.mockResolvedValue({
      allowUnlinkedWorkspaceTasks: true,
      publicChannelMode: 'all_invited',
      privateChannelMode: 'disabled',
      allowDirectMessages: true,
      allowCommands: true,
      allowShortcuts: true,
      allowlistedChannels: [],
    });
    api.updateSlackAgentPolicy.mockImplementation(async (_id, policy) => policy);
    api.startProviderConnection.mockResolvedValue({
      url: 'https://accounts.google.com/o/oauth2/v2/auth?state=opaque',
      attemptId: 'a'.repeat(43),
    });
    api.reconnectConnection.mockResolvedValue({
      url: 'https://accounts.google.com/o/oauth2/v2/auth?state=opaque',
      attemptId: 'b'.repeat(43),
    });
    api.getConnectorOAuthAttempt.mockResolvedValue({
      attemptId: 'a'.repeat(43),
      provider: 'google',
      status: 'succeeded',
      connectionId: '00000000-0000-7000-8000-000000000004',
      errorCode: null,
      expiresAt: '2026-08-08T00:00:00.000Z',
    });
    api.createWorkspaceInvitation.mockResolvedValue({ invitation, inviteUrl, emailDelivery: 'sent' });
    api.revokeWorkspaceInvitation.mockResolvedValue(undefined);
    api.updateWorkspaceLogAgentInference.mockImplementation(async (enabled: boolean) => ({
      ...workspace,
      logAgentInference: enabled,
    }));
    copyText.mockResolvedValue(undefined);
    openExternal.mockResolvedValue(undefined);
    getApplicationIcon.mockResolvedValue({ activeIcon: 'dark', isAutomatic: true, supported: true });
    getApplicationSettings.mockResolvedValue({ lockdownMode: false, lockdownAvailable: true });
    setLockdownMode.mockImplementation(async (lockdownMode: boolean) => ({
      lockdownMode,
      lockdownAvailable: true,
    }));
    setApplicationIcon.mockImplementation(async (activeIcon: string) => ({
      activeIcon,
      isAutomatic: false,
      supported: true,
    }));
    resetApplicationIcon.mockResolvedValue({ activeIcon: 'dark', isAutomatic: true, supported: true });
  });

  it('lets workspace admins enable full agent inference logging', async () => {
    renderSettings();
    openSettingsSection('Workspace');

    const toggle = screen.getByRole('switch', { name: 'Log agent inference' });
    expect(toggle).not.toBeChecked();
    fireEvent.click(toggle);

    await waitFor(() => expect(api.updateWorkspaceLogAgentInference).toHaveBeenCalledWith(true));
    expect(toggle).toBeChecked();
  });

  it('opens the exact section requested by a native settings-window URL', async () => {
    window.history.replaceState({}, '', '/?surface=settings&settingsSection=workspace#/settings');
    renderSettings();

    const navigation = screen.getByRole('navigation', { name: 'Settings sections' });
    expect(within(navigation).getByRole('button', { name: 'Workspace' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('heading', { level: 1, name: 'Workspace' })).toBeVisible();
    expect(await screen.findByText('Sam')).toBeVisible();
  });

  it('refreshes members whenever settings opens even when the cached list is fresh', async () => {
    const client = createTestQueryClient();
    client.setQueryData(['workspace-members'], [owner]);

    renderSettings(workspace, client);
    openSettingsSection('Workspace');

    expect(screen.getByText('Adam')).toBeVisible();
    await waitFor(() => expect(api.getWorkspaceMembers).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('Sam')).toBeVisible();
  });

  it('targets an already-open singleton settings window and ignores invalid section events', async () => {
    renderSettings();
    expect(screen.getByRole('heading', { level: 1, name: 'Account' })).toBeVisible();

    act(() => settingsSectionRequest.listener?.('connections'));
    expect(screen.getByRole('heading', { level: 1, name: 'Connections' })).toBeVisible();

    act(() => settingsSectionRequest.listener?.('not-a-section'));
    expect(screen.getByRole('heading', { level: 1, name: 'Connections' })).toBeVisible();
  });

  it('falls back to Account for the removed General settings section', () => {
    window.history.replaceState({}, '', '/?surface=settings&settingsSection=general#/settings');
    renderSettings();

    expect(screen.getByRole('heading', { level: 1, name: 'Account' })).toBeVisible();
  });

  it('offers separate Google presets with their exact personal and workspace capabilities', async () => {
    renderSettings();
    openSettingsSection('Connections');

    const mailCard = (await screen.findByText('Google Mail + Calendar')).closest('article');
    expect(mailCard).not.toBeNull();
    expect(within(mailCard!).queryByRole('button', { name: 'Connect workspace' })).not.toBeInTheDocument();
    fireEvent.click(within(mailCard!).getByRole('button', { name: 'Connect for me' }));
    await waitFor(() => expect(api.startProviderConnection).toHaveBeenCalledWith(
      'google',
      'you',
      ['gmail.read', 'gmail.draft', 'gmail.send', 'calendar.read', 'calendar.write'],
    ));

    const driveCard = screen.getByText('Google Drive + Docs + Sheets').closest('article');
    expect(driveCard).not.toBeNull();
    await waitFor(() => expect(within(driveCard!).getByRole('button', { name: 'Connect workspace' })).toBeEnabled());
    fireEvent.click(within(driveCard!).getByRole('button', { name: 'Connect workspace' }));
    await waitFor(() => expect(api.startProviderConnection).toHaveBeenLastCalledWith(
      'google',
      'workspace',
      ['drive.read', 'docs.read', 'docs.write', 'sheets.read', 'sheets.write'],
    ));
    expect(openExternal).toHaveBeenCalledTimes(2);
  });

  it('reconciles a denied connector attempt from the regional API when no deep link arrives', async () => {
    api.getConnectorOAuthAttempt.mockResolvedValueOnce({
      attemptId: 'a'.repeat(43),
      provider: 'google',
      status: 'denied',
      connectionId: null,
      errorCode: 'oauth_denied',
      expiresAt: '2026-08-08T00:00:00.000Z',
    });
    renderSettings();
    openSettingsSection('Connections');

    const mailCard = (await screen.findByText('Google Mail + Calendar')).closest('article');
    fireEvent.click(within(mailCard!).getByRole('button', { name: 'Connect for me' }));

    expect(await screen.findByText('Google authorization was cancelled.')).toBeVisible();
    expect(api.getConnectorOAuthAttempt).toHaveBeenCalledWith('a'.repeat(43));
  });

  it('uses the server-owned attempt provider for reconnect status messaging', async () => {
    api.getConnections.mockResolvedValue([{
      id: '00000000-0000-7000-8000-000000000010',
      connectorType: 'google',
      scope: 'you',
      displayName: 'Imported connection label',
      capabilities: ['drive.read'],
      status: 'reconnect_required',
    }]);
    api.getConnectorOAuthAttempt
      .mockResolvedValueOnce({
        attemptId: 'b'.repeat(43),
        provider: 'notion',
        status: 'pending',
        connectionId: null,
        errorCode: null,
        expiresAt: '2026-08-08T00:00:00.000Z',
      })
      .mockResolvedValueOnce({
        attemptId: 'b'.repeat(43),
        provider: 'notion',
        status: 'denied',
        connectionId: null,
        errorCode: 'oauth_denied',
        expiresAt: '2026-08-08T00:00:00.000Z',
      });
    renderSettings();
    openSettingsSection('Connections');

    fireEvent.click(await screen.findByRole('button', { name: 'Reconnect Imported connection label' }));

    const dialog = screen.getByRole('dialog', { name: 'Do you want to re-connect Imported connection label?' });
    expect(dialog).toHaveAccessibleDescription('You’ll be sent to the provider to authorize this connection again.');
    expect(api.reconnectConnection).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Re-connect' }));

    expect(await screen.findByText('Notion authorization was cancelled.')).toBeVisible();
    expect(api.reconnectConnection).toHaveBeenCalledWith('00000000-0000-7000-8000-000000000010');
    expect(api.getConnectorOAuthAttempt).toHaveBeenNthCalledWith(1, 'b'.repeat(43));
  });

  it('lets a healthy installed connection start reconnect after confirmation', async () => {
    api.getConnections.mockResolvedValue([{
      id: '00000000-0000-7000-8000-000000000010',
      connectorType: 'google',
      scope: 'you',
      displayName: 'Google · adam@example.com',
      capabilities: ['drive.read'],
      status: 'healthy',
    }]);
    renderSettings();
    openSettingsSection('Connections');

    fireEvent.click(await screen.findByRole('button', { name: 'Reconnect Google · adam@example.com' }));
    const dialog = screen.getByRole('dialog', { name: 'Do you want to re-connect Google · adam@example.com?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Re-connect' }));

    await waitFor(() => expect(api.reconnectConnection).toHaveBeenCalledWith('00000000-0000-7000-8000-000000000010'));
    expect(openExternal).toHaveBeenCalledWith('https://accounts.google.com/o/oauth2/v2/auth?state=opaque');
  });

  it('disables reconnect actions while a reconnect request is pending', async () => {
    let resolveReconnect!: (value: { url: string; attemptId: string }) => void;
    api.getConnections.mockResolvedValue([{
      id: '00000000-0000-7000-8000-000000000010',
      connectorType: 'google',
      scope: 'you',
      displayName: 'Google · adam@example.com',
      capabilities: ['drive.read'],
      status: 'healthy',
    }]);
    api.reconnectConnection.mockImplementationOnce(() => new Promise((resolve) => {
      resolveReconnect = resolve;
    }));
    renderSettings();
    openSettingsSection('Connections');

    const reconnectButton = await screen.findByRole('button', { name: 'Reconnect Google · adam@example.com' });
    fireEvent.click(reconnectButton);
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Re-connect' }));

    await waitFor(() => expect(reconnectButton).toBeDisabled());
    await act(async () => resolveReconnect({
      url: 'https://accounts.google.com/o/oauth2/v2/auth?state=opaque',
      attemptId: 'b'.repeat(43),
    }));
    await waitFor(() => expect(openExternal).toHaveBeenCalled());
  });

  it('disables reconnect actions while another provider authorization is pending', async () => {
    api.getConnections.mockResolvedValue([{
      id: '00000000-0000-7000-8000-000000000010',
      connectorType: 'google',
      scope: 'you',
      displayName: 'Google · adam@example.com',
      capabilities: ['drive.read'],
      status: 'healthy',
    }]);
    api.getConnectorOAuthAttempt.mockResolvedValue({
      attemptId: 'a'.repeat(43),
      provider: 'google',
      status: 'pending',
      connectionId: null,
      errorCode: null,
      expiresAt: '2026-08-08T00:00:00.000Z',
    });
    renderSettings();
    openSettingsSection('Connections');

    const mailCard = (await screen.findByText('Google Mail + Calendar')).closest('article');
    fireEvent.click(within(mailCard!).getByRole('button', { name: 'Connect for me' }));

    expect(await within(mailCard!).findByText('Waiting…')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Reconnect Google · adam@example.com' })).toBeDisabled();
  });

  it('offers personal and workspace Linear authorization without granting agent identity personally', async () => {
    renderSettings();
    openSettingsSection('Connections');

    const linearCard = (await screen.findByText('Linear')).closest('article');
    expect(linearCard).not.toBeNull();
    fireEvent.click(within(linearCard!).getByRole('button', { name: 'Connect for me' }));
    await waitFor(() => expect(api.startProviderConnection).toHaveBeenCalledWith(
      'linear',
      'you',
      ['linear.read', 'linear.issue.create', 'linear.comment.create', 'linear.write'],
    ));

    await waitFor(() => expect(within(linearCard!).getByRole('button', { name: 'Connect workspace' })).toBeEnabled());
    fireEvent.click(within(linearCard!).getByRole('button', { name: 'Connect workspace' }));
    await waitFor(() => expect(api.startProviderConnection).toHaveBeenLastCalledWith(
      'linear',
      'workspace',
      ['linear.read', 'linear.issue.create', 'linear.comment.create', 'linear.write'],
    ));
  });

  it('offers one Slack card with personal MCP and workspace Agent authorization', async () => {
    renderSettings();
    openSettingsSection('Connections');

    const slackCard = (await screen.findByText('Slack')).closest('article');
    expect(slackCard).not.toBeNull();
    expect(screen.queryByText('Slack knowledge')).not.toBeInTheDocument();
    expect(screen.queryByText('Slack actions')).not.toBeInTheDocument();
    expect(screen.queryByText('Avalon Agent for Slack')).not.toBeInTheDocument();

    fireEvent.click(within(slackCard!).getByRole('button', { name: 'Connect for me' }));
    await waitFor(() => expect(api.startProviderConnection).toHaveBeenCalledWith(
      'slack',
      'you',
      [
        'slack.search',
        'slack.messages.read',
        'slack.files.read',
        'slack.users.read',
        'slack.messages.write',
        'slack.conversations.write',
        'slack.reactions.write',
        'slack.canvases.read',
        'slack.canvases.write',
      ],
    ));

    await waitFor(() => expect(within(slackCard!).getByRole('button', { name: 'Connect workspace' })).toBeEnabled());
    fireEvent.click(within(slackCard!).getByRole('button', { name: 'Connect workspace' }));
    await waitFor(() => expect(api.startProviderConnection).toHaveBeenLastCalledWith(
      'slack',
      'workspace',
      ['slack.agent', 'slack.notifications.write'],
    ));
  });

  it('lets a workspace owner inspect and update the Slack Agent policy', async () => {
    api.getConnections.mockResolvedValue([{
      id: '00000000-0000-7000-8000-000000000015',
      connectorType: 'slack',
      scope: 'workspace',
      displayName: 'Slack · Avalon',
      capabilities: ['slack.agent'],
      status: 'healthy',
    }]);
    renderSettings();
    openSettingsSection('Connections');

    fireEvent.click(await screen.findByRole('button', { name: 'Policy' }));
    const dialog = await screen.findByRole('dialog', { name: 'Slack Agent policy · Slack · Avalon' });
    await waitFor(() => expect(api.getSlackAgentPolicy).toHaveBeenCalledWith(
      '00000000-0000-7000-8000-000000000015',
      expect.any(AbortSignal),
    ));
    const directMessages = await within(dialog).findByRole('checkbox', { name: /Direct messages/u });
    fireEvent.click(directMessages);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save policy' }));

    await waitFor(() => expect(api.updateSlackAgentPolicy).toHaveBeenCalledWith(
      '00000000-0000-7000-8000-000000000015',
      expect.objectContaining({ allowDirectMessages: false }),
    ));
  });

  it('rejects a channel ID entered in both Slack Agent allowlists', async () => {
    api.getConnections.mockResolvedValue([{
      id: '00000000-0000-7000-8000-000000000015',
      connectorType: 'slack',
      scope: 'workspace',
      displayName: 'Slack · Avalon',
      capabilities: ['slack.agent'],
      status: 'healthy',
    }]);
    renderSettings();
    openSettingsSection('Connections');

    fireEvent.click(await screen.findByRole('button', { name: 'Policy' }));
    const dialog = await screen.findByRole('dialog', { name: 'Slack Agent policy · Slack · Avalon' });
    const publicChannels = await within(dialog).findByRole('textbox', { name: 'Public-channel IDs' });
    const privateChannels = within(dialog).getByRole('textbox', { name: 'Private-channel IDs' });
    const save = within(dialog).getByRole('button', { name: 'Save policy' });

    fireEvent.change(publicChannels, { target: { value: 'CSHARED' } });
    fireEvent.change(privateChannels, { target: { value: 'CSHARED' } });

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Channel CSHARED cannot be listed as both public and private.',
    );
    expect(save).toBeDisabled();
    expect(api.updateSlackAgentPolicy).not.toHaveBeenCalled();

    fireEvent.change(privateChannels, { target: { value: 'GPRIVATE' } });
    await waitFor(() => expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument());
    expect(save).toBeEnabled();
    fireEvent.click(save);
    await waitFor(() => expect(api.updateSlackAgentPolicy).toHaveBeenCalledWith(
      '00000000-0000-7000-8000-000000000015',
      expect.objectContaining({
        allowlistedChannels: [
          { channelId: 'CSHARED', channelType: 'public' },
          { channelId: 'GPRIVATE', channelType: 'private' },
        ],
      }),
    ));
  });

  it('offers the read-only X connector only at workspace scope', async () => {
    renderSettings();
    openSettingsSection('Connections');

    const xCard = (await screen.findByText('X')).closest('article');
    expect(xCard).not.toBeNull();
    expect(within(xCard!).queryByRole('button', { name: 'Connect for me' })).not.toBeInTheDocument();

    await waitFor(() => expect(within(xCard!).getByRole('button', { name: 'Connect workspace' })).toBeEnabled());
    fireEvent.click(within(xCard!).getByRole('button', { name: 'Connect workspace' }));
    await waitFor(() => expect(api.createXConnection).toHaveBeenCalledWith(['x.read']));
    expect(api.startProviderConnection).not.toHaveBeenCalledWith('x', expect.anything(), expect.anything());
  });

  it('disables duplicate workspace X connections', async () => {
    api.getConnections.mockResolvedValue([{
      id: '00000000-0000-7000-8000-000000000017',
      connectorType: 'x',
      scope: 'workspace',
      displayName: 'X',
      capabilities: ['x.read'],
      status: 'healthy',
    }]);

    renderSettings();
    openSettingsSection('Connections');

    const xCard = (await screen.findByText('X')).closest('article');
    expect(xCard).not.toBeNull();
    expect(within(xCard!).queryByRole('button', { name: 'Connect for me' })).not.toBeInTheDocument();
    const workspaceButton = within(xCard!).getByRole('button', { name: 'Connect workspace' });
    await waitFor(() => {
      expect(workspaceButton).toBeDisabled();
      expect(workspaceButton).toHaveAttribute(
        'title',
        'An X workspace connection is already installed. Manage it above.',
      );
    });
    expect(screen.queryByRole('button', { name: 'Reconnect X' })).not.toBeInTheDocument();
  });

  it.each(['healthy', 'reconnect_required'] as const)(
    'disables duplicate Slack workspace authorization for an existing %s installation',
    async (status) => {
      api.getConnections.mockResolvedValue([{
        id: '00000000-0000-7000-8000-000000000015',
        connectorType: 'slack',
        scope: 'workspace',
        displayName: 'Slack · Avalon',
        capabilities: ['slack.agent', 'slack.notifications.write'],
        status,
      }]);

      renderSettings();
      openSettingsSection('Connections');

      const slackCard = (await screen.findByText('Slack')).closest('article');
      expect(slackCard).not.toBeNull();
      expect(within(slackCard!).getByRole('button', { name: 'Connect for me' })).toBeEnabled();
      expect(within(slackCard!).queryByRole('button', { name: 'Connect another workspace' })).not.toBeInTheDocument();
      const workspaceButton = within(slackCard!).getByRole('button', { name: 'Connect workspace' });
      await waitFor(() => expect(workspaceButton).toBeDisabled());
      expect(workspaceButton).toHaveAttribute(
        'title',
        'A Slack workspace connection is already installed. Manage it above.',
      );
      fireEvent.click(workspaceButton);
      expect(api.startProviderConnection).not.toHaveBeenCalled();
    },
  );

  it('allows replacing a disabled Slack workspace installation', async () => {
    api.getConnections.mockResolvedValue([{
      id: '00000000-0000-7000-8000-000000000016',
      connectorType: 'slack',
      scope: 'workspace',
      displayName: 'Slack · Avalon',
      capabilities: ['slack.agent', 'slack.notifications.write'],
      status: 'disabled',
    }]);

    renderSettings();
    openSettingsSection('Connections');

    const slackCard = (await screen.findByText('Slack')).closest('article');
    expect(slackCard).not.toBeNull();
    const workspaceButton = within(slackCard!).getByRole('button', { name: 'Connect workspace' });
    await waitFor(() => expect(workspaceButton).toBeEnabled());
    fireEvent.click(workspaceButton);
    await waitFor(() => expect(api.startProviderConnection).toHaveBeenCalledWith(
      'slack',
      'workspace',
      ['slack.agent', 'slack.notifications.write'],
    ));
  });

  it.each(['healthy', 'reconnect_required'] as const)(
    'disables duplicate workspace authorization for an existing %s Linear installation',
    async (status) => {
      api.getConnections.mockResolvedValue([{
        id: '00000000-0000-7000-8000-000000000011',
        connectorType: 'linear',
        scope: 'workspace',
        displayName: 'Linear · Avalon',
        capabilities: ['linear.read'],
        status,
      }]);

      renderSettings();
      openSettingsSection('Connections');

      const linearCard = (await screen.findByText('Linear')).closest('article');
      expect(linearCard).not.toBeNull();
      expect(within(linearCard!).getByRole('button', { name: 'Connect for me' })).toBeEnabled();
      const workspaceButton = within(linearCard!).getByRole('button', { name: 'Connect workspace' });
      await waitFor(() => expect(workspaceButton).toBeDisabled());
      expect(workspaceButton).toHaveAttribute(
        'title',
        'A Linear workspace connection is already installed. Manage it above.',
      );
      fireEvent.click(workspaceButton);
      expect(api.startProviderConnection).not.toHaveBeenCalled();
    },
  );

  it('allows a replacement workspace authorization after the existing connection is disabled', async () => {
    api.getConnections.mockResolvedValue([{
      id: '00000000-0000-7000-8000-000000000012',
      connectorType: 'linear',
      scope: 'workspace',
      displayName: 'Linear · Avalon',
      capabilities: ['linear.read'],
      status: 'disabled',
    }]);

    renderSettings();
    openSettingsSection('Connections');

    const linearCard = (await screen.findByText('Linear')).closest('article');
    expect(linearCard).not.toBeNull();
    const workspaceButton = within(linearCard!).getByRole('button', { name: 'Connect workspace' });
    await waitFor(() => expect(workspaceButton).toBeEnabled());
    fireEvent.click(workspaceButton);
    await waitFor(() => expect(api.startProviderConnection).toHaveBeenCalledWith(
      'linear',
      'workspace',
      ['linear.read', 'linear.issue.create', 'linear.comment.create', 'linear.write'],
    ));
  });

  it('uses provider-level workspace connection detection without blocking personal authorization', async () => {
    api.getConnections.mockResolvedValue([{
      id: '00000000-0000-7000-8000-000000000013',
      connectorType: 'google',
      scope: 'workspace',
      displayName: 'Google Workspace · Avalon',
      capabilities: ['gmail.read', 'calendar.read'],
      status: 'healthy',
    }, {
      id: '00000000-0000-7000-8000-000000000014',
      connectorType: 'linear',
      scope: 'you',
      displayName: 'Linear · Adam',
      capabilities: ['linear.read'],
      status: 'healthy',
    }]);

    renderSettings();
    openSettingsSection('Connections');

    const driveCard = (await screen.findByText('Google Drive + Docs + Sheets')).closest('article');
    expect(driveCard).not.toBeNull();
    await waitFor(() => expect(within(driveCard!).getByRole('button', { name: 'Connect workspace' })).toBeDisabled());
    expect(within(driveCard!).getByRole('button', { name: 'Connect for me' })).toBeEnabled();

    const linearCard = screen.getByText('Linear').closest('article');
    expect(linearCard).not.toBeNull();
    expect(within(linearCard!).getByRole('button', { name: 'Connect workspace' })).toBeEnabled();
  });

  it('lets members connect Linear personally without offering a workspace installation', async () => {
    renderSettings({ ...workspace, currentUser: member });
    openSettingsSection('Connections');

    const linearCard = (await screen.findByText('Linear')).closest('article');
    expect(linearCard).not.toBeNull();
    expect(within(linearCard!).getByRole('button', { name: 'Connect for me' })).toBeEnabled();
    expect(within(linearCard!).queryByRole('button', { name: 'Connect workspace' })).not.toBeInTheDocument();
  });

  it('shows existing Google connections in the connection list', async () => {
    api.getConnections.mockResolvedValue([{
      id: '00000000-0000-7000-8000-000000000010',
      workspaceId: workspace.id,
      connectorType: 'google',
      scope: 'you',
      ownerUserId: owner.id,
      ownerName: owner.name,
      displayName: 'Google · adam@example.com',
      capabilities: ['gmail.read', 'calendar.read'],
      status: 'healthy',
      lastSyncAt: null,
      createdAt: '2026-08-01T00:00:00.000Z',
    }]);

    renderSettings();
    openSettingsSection('Connections');

    const connectionName = await screen.findByText('Google · adam@example.com');
    expect(connectionName).toBeVisible();
    expect(screen.getByText('Personal · 2 capabilities')).toBeVisible();
    const installedHeading = screen.getByRole('heading', { level: 2, name: 'Installed connections' });
    const mailCard = screen.getByText('Google Mail + Calendar').closest('article');
    expect(installedHeading.compareDocumentPosition(mailCard!) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);

    const reconnectButton = screen.getByRole('button', { name: 'Reconnect Google · adam@example.com' });
    const disconnectButton = screen.getByRole('button', { name: 'Disconnect Google · adam@example.com' });
    expect(reconnectButton.nextElementSibling).toBe(disconnectButton);
    fireEvent.click(reconnectButton);
    const dialog = screen.getByRole('dialog', { name: 'Do you want to re-connect Google · adam@example.com?' });
    expect(api.reconnectConnection).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Connected' }));
    expect(screen.getByText('Google Mail + Calendar')).toBeVisible();
    expect(screen.queryByText('Google Drive + Docs + Sheets')).not.toBeInTheDocument();
  });

  it('counts only connections rendered in the installed list', async () => {
    api.getConnections.mockResolvedValue([{
      id: '00000000-0000-7000-8000-000000000099',
      connectorType: 'generic_webhook',
      scope: 'workspace',
      displayName: 'Inbound webhook',
      capabilities: [],
      status: 'healthy',
    }]);
    renderSettings();
    openSettingsSection('Connections');

    const installedHeading = await screen.findByRole('heading', { level: 2, name: 'Installed connections' });
    const headingGroup = installedHeading.closest<HTMLElement>('.settings-pane-heading');
    expect(within(headingGroup!).getByText('0')).toBeVisible();
    expect(screen.getByText('No connections yet')).toBeVisible();
    expect(screen.queryByText('Inbound webhook')).not.toBeInTheDocument();
  });

  it('shows the immutable EU region and lets an owner create, copy, and revoke an invite', async () => {
    renderSettings();
    openSettingsSection('Workspace');

    expect(await screen.findByText('Data region')).toBeVisible();
    expect(screen.getByText('European Union')).toBeVisible();
    expect(screen.getByText('Locked')).toBeVisible();
    expect(await screen.findByText('Sam')).toBeVisible();

    fireEvent.change(screen.getByRole('textbox', { name: 'Email address' }), {
      target: { value: 'new-admin@example.com' },
    });
    fireEvent.change(screen.getByRole('combobox', { name: 'Role' }), { target: { value: 'admin' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send invitation' }));

    await waitFor(() => expect(api.createWorkspaceInvitation).toHaveBeenCalledWith('new-admin@example.com', 'admin'));
    expect(await screen.findByText('Invitation emailed')).toBeVisible();
    fireEvent.click(await screen.findByRole('button', { name: 'Copy link' }));
    await waitFor(() => expect(copyText).toHaveBeenCalledWith(inviteUrl));

    fireEvent.click(screen.getByRole('button', { name: `Revoke invitation for ${invitation.email}` }));
    await waitFor(() => expect(api.revokeWorkspaceInvitation).toHaveBeenCalledWith(invitation.id));
  });

  it('does not expose invitation management to regular members', async () => {
    renderSettings({ ...workspace, currentUser: member });
    openSettingsSection('Workspace');
    expect(await screen.findByText('Adam')).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Invitations' })).not.toBeInTheDocument();
    expect(api.getWorkspaceInvitations).not.toHaveBeenCalled();
  });

  it('uses searchable section navigation and keeps one active settings pane', async () => {
    renderSettings();

    const navigation = screen.getByRole('navigation', { name: 'Settings sections' });
    expect(within(navigation).queryByRole('button', { name: 'General' })).not.toBeInTheDocument();
    expect(within(navigation).getByRole('button', { name: 'Account' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('heading', { level: 1, name: 'Account' })).toBeVisible();

    expect(screen.getByText('adam@example.com')).toBeVisible();

    const search = screen.getByRole('searchbox', { name: 'Search settings' });
    fireEvent.change(search, { target: { value: 'region' } });
    expect(within(navigation).getByRole('button', { name: 'Workspace' })).toBeVisible();
    expect(within(navigation).queryByRole('button', { name: 'Account' })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: 'Workspace' })).toBeVisible());
    expect(screen.getByText('Data region')).toBeVisible();

    fireEvent.change(search, { target: { value: 'connector' } });
    expect(within(navigation).getByRole('button', { name: 'Connections' })).toBeVisible();
    expect(within(navigation).queryByRole('button', { name: 'Account' })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: 'Connections' })).toBeVisible());

    fireEvent.change(search, { target: { value: 'does not exist' } });
    expect(screen.getByText('No settings found')).toBeVisible();
  });

  it('selects a macOS app icon with an immediate jump state', async () => {
    renderSettings();
    openSettingsSection('Application');

    const ruby = await screen.findByRole('button', { name: 'Ruby app icon' });
    expect(screen.getByRole('button', { name: 'Dark app icon' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(ruby);

    expect(ruby).toHaveClass('is-jumping');
    expect(ruby).toHaveAttribute('aria-pressed', 'true');
    await waitFor(() => expect(setApplicationIcon).toHaveBeenCalledWith('ruby'));
    expect(await screen.findByText('Ruby is selected.')).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Use the system icon' }));
    await waitFor(() => expect(resetApplicationIcon).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('Using dark automatically with the system appearance.')).toBeVisible();
  });

  it('toggles Lockdown mode for the saved authentication session', async () => {
    renderSettings();
    openSettingsSection('Application');

    const toggle = await screen.findByRole('switch', { name: 'Lockdown mode' });
    expect(toggle).not.toBeChecked();
    fireEvent.click(toggle);

    await waitFor(() => expect(setLockdownMode).toHaveBeenCalledWith(true));
    expect(toggle).toBeChecked();

    fireEvent.click(toggle);
    await waitFor(() => expect(setLockdownMode).toHaveBeenCalledWith(false));
    expect(toggle).not.toBeChecked();
  });

  it('shows the automatic off state when the operating-system keystore is unavailable', async () => {
    getApplicationSettings.mockResolvedValue({ lockdownMode: false, lockdownAvailable: false });
    renderSettings();
    openSettingsSection('Application');

    const toggle = await screen.findByRole('switch', { name: 'Lockdown mode' });
    expect(toggle).not.toBeChecked();
    expect(toggle).toBeDisabled();
    expect(screen.getByText('Lockdown mode is off because this Mac’s keystore is unavailable.'))
      .toBeVisible();
  });

  it('still allows an in-app off transition from a stale unavailable-keystore state', async () => {
    getApplicationSettings.mockResolvedValue({ lockdownMode: true, lockdownAvailable: false });
    renderSettings();
    openSettingsSection('Application');

    const toggle = await screen.findByRole('switch', { name: 'Lockdown mode' });
    expect(toggle).toBeChecked();
    expect(toggle).toBeEnabled();
    fireEvent.click(toggle);

    await waitFor(() => expect(setLockdownMode).toHaveBeenCalledWith(false));
  });

  it('shows application-setting load failures inline', async () => {
    getApplicationSettings.mockRejectedValue(new Error('Application settings could not be read.'));
    renderSettings();
    openSettingsSection('Application');

    expect(await screen.findByText('Application settings could not be read.')).toBeVisible();
  });
});
