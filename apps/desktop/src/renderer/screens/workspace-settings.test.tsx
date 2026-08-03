import * as Tooltip from '@radix-ui/react-tooltip';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Workspace, WorkspaceInvitation } from '../lib/types';
import { WorkspaceSettingsScreen } from './workspace-settings';

const api = vi.hoisted(() => ({
  createWorkspaceInvitation: vi.fn(),
  getWorkspaceInvitations: vi.fn(),
  getWorkspaceMembers: vi.fn(),
  getConnections: vi.fn(),
  startProviderConnection: vi.fn(),
  reconnectConnection: vi.fn(),
  testConnection: vi.fn(),
  disconnectConnection: vi.fn(),
  revokeWorkspaceInvitation: vi.fn(),
}));
const copyText = vi.hoisted(() => vi.fn());
const openExternal = vi.hoisted(() => vi.fn());
const signOut = vi.hoisted(() => vi.fn());

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
vi.mock('../lib/platform', () => ({ desktopBridge: () => ({ copyText, openExternal }) }));

const owner = { id: 'user-1', name: 'Adam', email: 'adam@example.com', timezone: 'America/Los_Angeles', role: 'owner' };
const member = { id: 'user-2', name: 'Sam', email: 'sam@example.com', timezone: 'America/Los_Angeles', role: 'member' };
const workspace: Workspace = {
  id: 'workspace-1',
  name: 'Avalon Studio',
  region: 'eu',
  timezone: 'Europe/London',
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

function renderSettings(nextWorkspace: Workspace = workspace): void {
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  render(
    <Tooltip.Provider>
      <QueryClientProvider client={client}>
        <WorkspaceSettingsScreen workspace={nextWorkspace} />
      </QueryClientProvider>
    </Tooltip.Provider>,
  );
}

function openSettingsSection(name: 'General' | 'Account' | 'Workspace' | 'Connections' | 'Application'): void {
  const navigation = screen.getByRole('navigation', { name: 'Settings sections' });
  fireEvent.click(within(navigation).getByRole('button', { name }));
}

describe('Workspace settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getWorkspaceMembers.mockResolvedValue([owner, member]);
    api.getWorkspaceInvitations.mockResolvedValue([invitation]);
    api.getConnections.mockResolvedValue([]);
    api.startProviderConnection.mockResolvedValue('https://accounts.google.com/o/oauth2/v2/auth?state=opaque');
    api.createWorkspaceInvitation.mockResolvedValue({ invitation, inviteUrl, emailDelivery: 'sent' });
    api.revokeWorkspaceInvitation.mockResolvedValue(undefined);
    copyText.mockResolvedValue(undefined);
    openExternal.mockResolvedValue(undefined);
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
        'A Linear workspace connection is already installed. Manage it below.',
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

    expect(await screen.findByText('Google · adam@example.com')).toBeVisible();
    expect(screen.getByText('Personal · 2 capabilities')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Connected' }));
    expect(screen.getByText('Google Mail + Calendar')).toBeVisible();
    expect(screen.queryByText('Google Drive + Docs + Sheets')).not.toBeInTheDocument();
  });

  it('shows the immutable EU region and lets an owner create, copy, and revoke an invite', async () => {
    renderSettings();

    expect(await screen.findByText('Data region')).toBeVisible();
    expect(screen.getByText('European Union')).toBeVisible();
    expect(screen.getByText('Locked')).toBeVisible();
    openSettingsSection('Workspace');
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
    expect(within(navigation).getByRole('button', { name: 'General' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('heading', { level: 1, name: 'General' })).toBeVisible();

    openSettingsSection('Account');
    expect(within(navigation).getByRole('button', { name: 'Account' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('heading', { level: 1, name: 'Account' })).toBeVisible();
    expect(screen.getByText('adam@example.com')).toBeVisible();

    const search = screen.getByRole('searchbox', { name: 'Search settings' });
    fireEvent.change(search, { target: { value: 'connector' } });
    expect(within(navigation).getByRole('button', { name: 'Connections' })).toBeVisible();
    expect(within(navigation).queryByRole('button', { name: 'Account' })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: 'Connections' })).toBeVisible());

    fireEvent.change(search, { target: { value: 'does not exist' } });
    expect(screen.getByText('No settings found')).toBeVisible();
  });
});
