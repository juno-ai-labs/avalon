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

const owner = { id: 'user-1', name: 'Adam', email: 'adam@example.com', role: 'owner' };
const member = { id: 'user-2', name: 'Sam', email: 'sam@example.com', role: 'member' };
const workspace: Workspace = {
  id: 'workspace-1',
  name: 'Avalon Studio',
  region: 'eu',
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
