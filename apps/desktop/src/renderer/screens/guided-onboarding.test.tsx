import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountOnboardingGate, WorkspaceOnboardingJourney } from './guided-onboarding';
import { act } from '@testing-library/react';
import type { Workspace } from '../lib/types';

const state = vi.hoisted(() => ({
  signedIn: true,
  account: { eligible: true, introduced: true, presentation: null, revision: 0 },
  getAccount: vi.fn(), saveAccount: vi.fn(), journey: vi.fn(), updateJourney: vi.fn(),
  invitations: vi.fn(), invite: vi.fn(), members: vi.fn(), connections: vi.fn(), connectors: vi.fn(),
}));
vi.mock('../lib/platform', () => ({ desktopBridge: () => ({ getAccountOnboarding: state.getAccount, updateAccountOnboarding: state.saveAccount }) }));
vi.mock('../lib/app-session', () => ({ useAppSession: () => ({
  session: state.signedIn ? { user: { id: 'user-1', email: 'person@example.com', name: 'Person' }, workspace: { id: 'workspace-1' } } : null,
  api: { getWorkspaceInvitations: state.invitations, createWorkspaceInvitation: state.invite, getWorkspaceMembers: state.members, getOnboardingJourney: state.journey,
    updateOnboardingJourney: state.updateJourney, getConnections: state.connections, getAvailableConnectorTypes: state.connectors },
  signOut: vi.fn(), setPendingConnectorOAuth: vi.fn(),
}) }));
const workspace = { id: 'workspace-1', region: 'global', name: 'Team', currentUser: { id: 'user-1', name: 'Person', role: 'member' } } as Workspace;
function show() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><AccountOnboardingGate><WorkspaceOnboardingJourney workspace={workspace}><div>Ordinary workspace</div></WorkspaceOnboardingJourney></AccountOnboardingGate></QueryClientProvider>);
  return client;
}
beforeEach(() => {
  vi.clearAllMocks();
  state.signedIn = true;
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  state.getAccount.mockResolvedValue(state.account);
  state.invitations.mockResolvedValue([]);
  state.members.mockResolvedValue([]); state.connections.mockResolvedValue([]); state.connectors.mockResolvedValue(['google']);
  state.journey.mockResolvedValue({ path: 'member', stage: 'profile', revision: 0, starterWorkstreamId: null, starterMessageId: 'message-1', connectorIds: [] });
});
describe('new-account learning paths', () => {
  it('introduces the platform before offering sign-in without fetching private account data', async () => {
    state.signedIn = false;
    show();
    expect(screen.getByRole('heading', { name: 'Meet Rally. Work moves forward together.' })).toBeInTheDocument();
    expect(state.getAccount).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Ordinary workspace')).toBeInTheDocument();
  });
  it('lets exempt accounts enter without creating a journey', async () => {
    state.getAccount.mockResolvedValue({ ...state.account, eligible: false }); show();
    expect(await screen.findByText('Ordinary workspace')).toBeInTheDocument();
    expect(state.journey).not.toHaveBeenCalled();
  });
  it('sends members directly to personal setup and saves their chosen appearance before opening New', async () => {
    state.saveAccount.mockResolvedValue({ ...state.account, revision: 1, presentation: { color: 'rose', avatar: 'circle', revision: 1 } });
    state.updateJourney.mockResolvedValue({ path: 'member', stage: 'complete', revision: 1, starterWorkstreamId: null, starterMessageId: 'message-1', connectorIds: [] });
    show(); await screen.findByRole('heading', { name: 'This is you in Rally' });
    expect(screen.queryByText('Bring context for your first task')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'rose' }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue with this look' }));
    await screen.findByText('Ordinary workspace');
    expect(state.saveAccount).toHaveBeenCalledWith({ expectedRevision: 0, presentation: { color: 'rose', avatar: 'circle', displayName: 'Person', initials: 'P' } });
    expect(state.updateJourney).toHaveBeenCalledWith({ expectedRevision: 0, stage: 'complete' });
  });
  it('retains personal setup when the account save fails', async () => {
    state.saveAccount.mockRejectedValue(new Error('Profile changed in another session')); show();
    await screen.findByRole('heading', { name: 'This is you in Rally' });
    fireEvent.click(screen.getByRole('button', { name: 'Continue with this look' }));
    await screen.findByText('Profile changed in another session');
    expect(state.updateJourney).not.toHaveBeenCalled();
  });
  it('starts creators at connectors and offers a skip', async () => {
    state.journey.mockResolvedValue({ path: 'creator', stage: 'connectors', revision: 0, starterWorkstreamId: null, starterMessageId: 'message-1', connectorIds: [] });
    state.updateJourney.mockResolvedValue({ path: 'creator', stage: 'profile', revision: 1, starterWorkstreamId: null, starterMessageId: 'message-1', connectorIds: [] });
    show(); await screen.findByRole('heading', { name: 'Connect tools for your workspace' });
    fireEvent.click(screen.getByRole('button', { name: 'Skip for now' }));
    await screen.findByRole('heading', { name: 'Connect your personal tools' });
    fireEvent.click(screen.getByRole('button', { name: 'Skip for now' }));
    await waitFor(() => expect(state.updateJourney).toHaveBeenCalledWith({ expectedRevision: 0, stage: 'profile' }));
  });
  it('keeps an authenticated workspace available when the identity service is unavailable', async () => {
    state.getAccount.mockRejectedValue(new Error('Identity unavailable'));
    show();
    expect(await screen.findByText('Ordinary workspace')).toBeInTheDocument();
  });
  it('refreshes an open appearance draft when a newer account revision arrives', async () => {
    const client = show();
    await screen.findByRole('heading', { name: 'This is you in Rally' });
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Old draft' } });
    act(() => client.setQueryData(['account-onboarding', 'person@example.com'], {
      ...state.account, revision: 2, presentation: { color: 'rose', avatar: 'circle', displayName: 'Harper', initials: 'H', revision: 2 },
    }));
    await waitFor(() => expect(screen.getByLabelText('Name')).toHaveValue('Harper'));
    expect(screen.getByLabelText('Avatar initials')).toHaveValue('H');
    fireEvent.click(screen.getByRole('button', { name: 'Continue with this look' }));
    await waitFor(() => expect(state.saveAccount).toHaveBeenCalledWith({ expectedRevision: 2,
      presentation: { color: 'rose', avatar: 'circle', displayName: 'Harper', initials: 'H' } }));
  });

  it('retains workspace selections and unsaved personal selections across refetches', async () => {
    const journey = { path: 'creator', stage: 'connectors', revision: 0, starterWorkstreamId: null, starterMessageId: 'message-1', connectorIds: [] };
    state.journey.mockResolvedValue(journey);
    state.updateJourney.mockImplementation(async (update) => ({ ...journey, ...update, revision: update.expectedRevision + 1 }));
    const client = show();
    await screen.findByRole('heading', { name: 'Connect tools for your workspace' });
    fireEvent.click(await screen.findByRole('button', { name: 'Google Drive + Docs + Sheets' }));
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));
    await screen.findByRole('heading', { name: 'Connect your personal tools' });
    fireEvent.click(screen.getByRole('button', { name: 'Google Mail + Calendar' }));
    state.journey.mockResolvedValue({
      ...journey, revision: 2, connectorIds: ['workspace:google-drive-workspace'],
    });
    await act(async () => { await client.refetchQueries({ queryKey: ['onboarding-journey'] });
      // React Query batches observer notifications onto the next timer task.
      await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(screen.getByRole('button', { name: 'Google Mail + Calendar' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(state.updateJourney).toHaveBeenLastCalledWith({ expectedRevision: 2, stage: 'connectors',
      connectorIds: ['workspace:google-drive-workspace', 'you:google-mail-calendar'] }));
  });
  it('reconciles invitations after a lost response and retries only undelivered addresses', async () => {
    state.journey.mockResolvedValue({ path: 'creator', stage: 'people', revision: 2, starterWorkstreamId: null, starterMessageId: 'message-1', connectorIds: [] });
    state.invite.mockRejectedValueOnce(new Error('Response lost'));
    state.updateJourney.mockResolvedValue({ path: 'creator', stage: 'complete', revision: 3, starterWorkstreamId: null, starterMessageId: 'message-1', connectorIds: [] });
    show();
    const field = await screen.findByLabelText('Email addresses');
    fireEvent.change(field, { target: { value: 'aspen@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Invite 1 teammate' }));
    await screen.findByText(/Could not invite:/u);
    state.invitations.mockResolvedValue([{ email: 'aspen@example.com', status: 'pending' }]);
    fireEvent.click(screen.getByRole('button', { name: 'Invite 1 teammate' }));
    await screen.findByText('Ordinary workspace');
    expect(state.invite).toHaveBeenCalledTimes(1);
  });

});
