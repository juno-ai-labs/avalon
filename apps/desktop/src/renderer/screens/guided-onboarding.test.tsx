import { useConversationAdmission } from '../lib/conversation-admission';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountOnboardingGate, PersonalSetup, WorkspaceOnboardingJourney } from './guided-onboarding';
import { act } from '@testing-library/react';
import type { Workspace } from '../lib/types';
import { MemoryRouter, useLocation, useNavigationType } from 'react-router-dom';
import { ErrorNoticeProvider } from '@rally/ui/components/error-notice';

const state = vi.hoisted(() => ({
  signedIn: true,
  hasWorkspace: true,
  account: { eligible: true, introduced: true, presentation: null, revision: 0 },
  getAccount: vi.fn(), saveAccount: vi.fn(), journey: vi.fn(), updateJourney: vi.fn(),
  invitations: vi.fn(), invite: vi.fn(), members: vi.fn(), connections: vi.fn(), connectors: vi.fn(),
  openSettings: vi.fn(), openExternal: vi.fn(), startProviderConnection: vi.fn(),
}));
vi.mock('../lib/platform', () => ({
  desktopBridge: () => ({
    getAccountOnboarding: state.getAccount,
    updateAccountOnboarding: state.saveAccount,
    openSettings: state.openSettings,
    openExternal: state.openExternal,
  }),
  desktopServicesAvailable: () => false,
}));
vi.mock('../lib/app-session', () => ({ useAppSession: () => ({
  session: state.signedIn ? { user: { id: 'user-1', email: 'person@example.com', name: 'Person' }, workspace: state.hasWorkspace ? { id: 'workspace-1' } : null } : null,
  api: { getWorkspaceInvitees: state.invitations, createWorkspaceInvitation: state.invite, getWorkspaceMembers: state.members, getOnboardingJourney: state.journey,
    updateOnboardingJourney: state.updateJourney, getConnections: state.connections, getAvailableConnectorTypes: state.connectors,
    startProviderConnection: state.startProviderConnection },
  signOut: vi.fn(), setPendingConnectorOAuth: vi.fn(),
  getAccountOnboarding: state.getAccount, updateAccountOnboarding: state.saveAccount,
}) }));
const workspace = { id: 'workspace-1', region: 'global', name: 'Team', currentUser: { id: 'user-1', name: 'Person', role: 'member' } } as Workspace;
function Route(): React.JSX.Element {
  const location = useLocation();
  return <div data-testid="route">{`${useNavigationType()} ${location.pathname}`}</div>;
}
function WorkspaceView(): React.JSX.Element {
  const allowed = useConversationAdmission();
  return <><div>Ordinary organization</div><output data-testid="admission">{allowed ? 'allowed' : 'blocked'}</output></>;
}
function show() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // The journey renders inside the app's HashRouter and leaves through it, so
  // the harness gives it a router and reports where it went.
  render(<ErrorNoticeProvider><MemoryRouter initialEntries={['/onboarding']}><QueryClientProvider client={client}><AccountOnboardingGate><WorkspaceOnboardingJourney workspace={workspace}><WorkspaceView /></WorkspaceOnboardingJourney></AccountOnboardingGate></QueryClientProvider><Route /></MemoryRouter></ErrorNoticeProvider>);
  return client;
}
beforeEach(() => {
  vi.clearAllMocks();
  state.signedIn = true;
  state.hasWorkspace = true;
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  state.getAccount.mockResolvedValue(state.account);
  state.invitations.mockResolvedValue([]);
  state.members.mockResolvedValue([]); state.connections.mockResolvedValue([]); state.connectors.mockResolvedValue(['google']);
  state.journey.mockResolvedValue({ path: 'member', stage: 'profile', revision: 0, connectorIds: [] });
  state.startProviderConnection.mockResolvedValue({ attemptId: 'attempt-1', url: 'https://provider.example/authorize' });
});
describe('new-account learning paths', () => {
  it('goes straight to sign-in without fetching private account data', () => {
    state.signedIn = false;
    show();
    expect(screen.getByText('Ordinary organization')).toBeInTheDocument();
    expect(state.getAccount).not.toHaveBeenCalled();
  });
  it('lets exempt accounts enter without creating a journey', async () => {
    state.getAccount.mockResolvedValue({ ...state.account, eligible: false }); show();
    expect(await screen.findByText('Ordinary organization')).toBeInTheDocument();
    expect(state.journey).not.toHaveBeenCalled();
  });
  it('sends members directly to personal setup and saves their chosen appearance before opening the Canvases home', async () => {
    state.saveAccount.mockResolvedValue({ ...state.account, revision: 1, presentation: { color: 'rose', avatar: 'circle', revision: 1 } });
    state.updateJourney.mockResolvedValue({ path: 'member', stage: 'complete', revision: 1, connectorIds: [] });
    show(); await screen.findByRole('heading', { name: 'This is you in Rally' });
    expect(screen.queryByText('Bring context for your first task')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'rose' }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue with this look' }));
    await screen.findByText('Ordinary organization');
    expect(state.saveAccount).toHaveBeenCalledWith({ expectedRevision: 0, presentation: { color: 'rose', avatar: 'circle', displayName: 'Person', initials: 'P' } });
    expect(state.updateJourney).toHaveBeenCalledWith({ expectedRevision: 0, stage: 'complete' });
    // The finished journey is replaced by the landing, not left behind for Back.
    // Awaited rather than read straight away: `finishOnboarding` completes the
    // journey and *then* navigates, so the stage flipping to `complete` is what
    // renders "Ordinary workspace" above — one commit before the navigation this
    // asserts on. Reading it synchronously raced that second commit and failed
    // as `POP /onboarding` under a loaded machine. This still fails if the
    // journey pushes instead of replacing, or never leaves at all.
    //
    // Anchored, because `toHaveTextContent` matches a string as a substring.
    await waitFor(() => expect(screen.getByTestId('route')).toHaveTextContent(/^REPLACE \/canvases$/u));
  });
  it('starts personal setup on a random color when the account has no saved look', async () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.3);
    try {
      show(); await screen.findByRole('heading', { name: 'This is you in Rally' });
      const swatches = screen.getByRole('group', { name: 'Your color' });
      expect(within(swatches).getByRole('button', { name: 'lime' })).toHaveAttribute('aria-pressed', 'true');
      expect(within(swatches).getAllByRole('button').filter((button) => button.getAttribute('aria-pressed') === 'true')).toHaveLength(1);
    } finally { random.mockRestore(); }
  });
  it('retains personal setup when the account save fails', async () => {
    state.saveAccount.mockRejectedValue(new Error('Profile changed in another session')); show();
    await screen.findByRole('heading', { name: 'This is you in Rally' });
    fireEvent.click(screen.getByRole('button', { name: 'Continue with this look' }));
    await screen.findByText('Profile changed in another session');
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    expect(state.updateJourney).not.toHaveBeenCalled();
  });
  it('starts creators at personal setup, then invitations, with no connector step', async () => {
    state.journey.mockResolvedValue({ path: 'creator', stage: 'profile', revision: 0, connectorIds: [] });
    state.saveAccount.mockResolvedValue({ ...state.account, revision: 1, presentation: { color: 'blue', avatar: 'circle', revision: 1 } });
    state.updateJourney.mockResolvedValue({ path: 'creator', stage: 'people', revision: 1, connectorIds: [] });
    show(); await screen.findByRole('heading', { name: 'This is you in Rally' });
    fireEvent.click(screen.getByRole('button', { name: 'Continue with this look' }));
    await screen.findByRole('heading', { name: 'Invite your teammates' });
    expect(state.updateJourney).toHaveBeenCalledWith({ expectedRevision: 0, stage: 'people' });
    expect(state.connectors).not.toHaveBeenCalled();
  });
  it('opens a restored organization before account lookup and keeps it mounted when details arrive', async () => {
    let resolveLookup!: (account: typeof state.account) => void;
    state.getAccount.mockImplementation(() => new Promise((resolve) => { resolveLookup = resolve; }));
    const client = show();
    const workspaceElement = screen.getByText('Ordinary organization');
    expect(screen.getByTestId('admission')).toHaveTextContent('blocked');
    expect(screen.queryByRole('heading', { name: 'Opening Rally' })).not.toBeInTheDocument();
    expect(state.getAccount).toHaveBeenCalledTimes(1);
    await act(async () => { resolveLookup({ ...state.account, eligible: false }); });
    await waitFor(() => expect(client.getQueryState(['account-onboarding', 'person@example.com'])?.status).toBe('success'));
    expect(screen.getByText('Ordinary organization')).toBe(workspaceElement);
    await waitFor(() => expect(screen.getByTestId('admission')).toHaveTextContent('allowed'));
  });
  it('keeps a returning organization mounted while journey progress loads and completes', async () => {
    let resolveJourney!: (journey: { path: string; stage: string; revision: number; connectorIds: string[] }) => void;
    state.journey.mockImplementation(() => new Promise((resolve) => { resolveJourney = resolve; }));
    const client = show();
    const workspaceElement = screen.getByText('Ordinary organization');
    await waitFor(() => expect(state.journey).toHaveBeenCalledTimes(1));
    expect(screen.getByText('Ordinary organization')).toBe(workspaceElement);
    expect(screen.queryByRole('heading', { name: 'Opening your organization' })).not.toBeInTheDocument();
    expect(screen.getByTestId('admission')).toHaveTextContent('blocked');
    await act(async () => { resolveJourney({ path: 'member', stage: 'complete', revision: 1, connectorIds: [] }); });
    await waitFor(() => expect(client.getQueryState(['onboarding-journey', 'global', 'workspace-1', 'user-1'])?.status).toBe('success'));
    expect(screen.getByText('Ordinary organization')).toBe(workspaceElement);
    await waitFor(() => expect(screen.getByTestId('admission')).toHaveTextContent('allowed'));
  });
  it('keeps a new identity gated until its introduction status arrives', async () => {
    state.hasWorkspace = false;
    let resolveLookup!: (account: typeof state.account) => void;
    state.getAccount.mockImplementation(() => new Promise((resolve) => { resolveLookup = resolve; }));
    show();
    expect(screen.getByRole('heading', { name: 'Opening Rally' })).toBeInTheDocument();
    expect(screen.queryByText('Ordinary organization')).not.toBeInTheDocument();
    state.saveAccount.mockReturnValue(new Promise(() => {}));
    await act(async () => { resolveLookup({ ...state.account, introduced: false }); });
    await waitFor(() => expect(state.saveAccount).toHaveBeenCalledWith({ expectedRevision: 0, introduced: true }));
    expect(screen.getByRole('heading', { name: 'Opening Rally' })).toBeInTheDocument();
    expect(screen.queryByText('Ordinary organization')).not.toBeInTheDocument();
  });
  it('records the introduction without showing it, then opens the organization', async () => {
    state.getAccount.mockResolvedValueOnce({ ...state.account, introduced: false });
    state.saveAccount.mockResolvedValue({ ...state.account, introduced: true, revision: 1 });
    state.journey.mockResolvedValue({ path: 'member', stage: 'complete', revision: 0, connectorIds: [] });
    show();
    await waitFor(() => expect(state.saveAccount).toHaveBeenCalledWith({ expectedRevision: 0, introduced: true }));
    expect(await screen.findByText('Ordinary organization')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('admission')).toHaveTextContent('allowed'));
  });
  it('retries recording the introduction against the revision another session saved', async () => {
    state.getAccount.mockResolvedValueOnce({ ...state.account, introduced: false })
      .mockResolvedValue({ ...state.account, introduced: false, revision: 1 });
    state.saveAccount.mockRejectedValueOnce(new Error('Profile changed in another session'));
    show();
    expect(await screen.findByText('Profile changed in another session')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    await waitFor(() => expect(state.getAccount).toHaveBeenCalledTimes(2));
    state.saveAccount.mockReturnValue(new Promise(() => {}));
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(state.saveAccount).toHaveBeenLastCalledWith({ expectedRevision: 1, introduced: true });
  });
  it('withholds admission when pending journey progress resolves to unfinished setup', async () => {
    let finishJourney!: (value: { path: string; stage: string; revision: number; connectorIds: string[] }) => void;
    state.journey.mockImplementation(() => new Promise((resolve) => { finishJourney = resolve; }));
    show();
    await waitFor(() => expect(state.journey).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('admission')).toHaveTextContent('blocked');
    await act(async () => { finishJourney({ path: 'member', stage: 'profile', revision: 0, connectorIds: [] }); });
    expect(await screen.findByRole('heading', { name: 'This is you in Rally' })).toBeInTheDocument();
    expect(screen.queryByText('Ordinary organization')).not.toBeInTheDocument();
  });
  it('shows account profile loading without a false error or editable placeholders', async () => {
    let finishAccount!: (value: typeof state.account) => void;
    state.getAccount.mockImplementation(() => new Promise((resolve) => { finishAccount = resolve; }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><AccountOnboardingGate><PersonalSetup variant="settings" /></AccountOnboardingGate></QueryClientProvider>);
    expect(screen.getByRole('status')).toHaveTextContent('Loading account profile…');
    expect(screen.queryByText('Account profile is unavailable.')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Name')).not.toBeInTheDocument();
    await act(async () => { finishAccount({ ...state.account, eligible: false }); });
    expect(await screen.findByLabelText('Name')).toHaveValue('Person');
  });
  it('keeps an identity without an organization gated after a failed lookup and during retry', async () => {
    state.hasWorkspace = false;
    state.getAccount.mockRejectedValue(new Error('Identity unavailable'));
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'OK' }));
    expect(await screen.findByRole('heading', { name: "Let's pick up where you left off" })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
    expect(screen.queryByText('Ordinary organization')).not.toBeInTheDocument();
    let rejectLookup!: (error: Error) => void;
    state.getAccount.mockImplementation(() => new Promise((_resolve, reject) => { rejectLookup = reject; }));
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('heading', { name: 'Opening Rally' })).toBeInTheDocument();
    expect(state.getAccount).toHaveBeenCalledTimes(2);
    expect(screen.queryByText('Ordinary organization')).not.toBeInTheDocument();
    await act(async () => { rejectLookup(new Error('Identity still unavailable')); });
    fireEvent.click(await screen.findByRole('button', { name: 'OK' }));
    expect(await screen.findByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
    expect(screen.queryByText('Ordinary organization')).not.toBeInTheDocument();
  });
  it('keeps an authenticated organization available when the identity service is unavailable', async () => {
    state.getAccount.mockRejectedValue(new Error('Identity unavailable'));
    show();
    expect(await screen.findByText('Ordinary organization')).toBeInTheDocument();
  });
  it('keeps the organization mounted while retrying a failed account lookup', async () => {
    state.getAccount.mockRejectedValue(new Error('Identity unavailable'));
    const client = show();
    const workspaceElement = await screen.findByText('Ordinary organization');
    let rejectLookup!: (error: Error) => void;
    state.getAccount.mockImplementation(() => new Promise((_resolve, reject) => { rejectLookup = reject; }));
    await act(async () => {
      void client.invalidateQueries({ queryKey: ['account-onboarding'] });
      // Flush React Query's batched observer notification while the lookup stays pending.
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(state.getAccount).toHaveBeenCalledTimes(2);
    expect(workspaceElement).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Opening Rally' })).not.toBeInTheDocument();
    await act(async () => { rejectLookup(new Error('Identity still unavailable')); });
    expect(screen.getByText('Ordinary organization')).toBe(workspaceElement);
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

  it('keeps initials drawn from the sign-in name when a newer revision saves no initials', async () => {
    const client = show();
    await screen.findByRole('heading', { name: 'This is you in Rally' });
    fireEvent.change(screen.getByLabelText('Avatar initials'), { target: { value: 'X' } });
    act(() => client.setQueryData(['account-onboarding', 'person@example.com'], { ...state.account, revision: 2, presentation: null }));
    await waitFor(() => expect(screen.getByLabelText('Avatar initials')).toHaveValue('P'));
  });
  it('validates mixed invitation input only on click and reopens the notice on another attempt', async () => {
    state.journey.mockResolvedValue({ path: 'creator', stage: 'people', revision: 2, connectorIds: [] });
    show();
    const field = await screen.findByLabelText('Email addresses');
    state.members.mockClear(); // Exclude the account gate's initial directory read.
    fireEvent.change(field, { target: { value: 'aspen@example.com' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    fireEvent.change(field, { target: { value: 'x' } });
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    const invite = screen.getByRole('button', { name: 'Invite 2 teammates' });
    expect(invite).toBeEnabled();

    for (let attempt = 0; attempt < 2; attempt += 1) {
      fireEvent.click(invite);
      expect(await screen.findByRole('alertdialog')).toHaveTextContent('One or more of the addresses are not a valid email address.');
      expect(screen.getByText('aspen@example.com')).toBeInTheDocument();
      expect(field).toHaveValue('x');
      expect(state.invitations).not.toHaveBeenCalled();
      expect(state.members).not.toHaveBeenCalled();
      expect(state.invite).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: 'OK' }));
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    }
  });

  it('explains an empty invitation submission without fetching or sending invitations', async () => {
    state.journey.mockResolvedValue({ path: 'creator', stage: 'people', revision: 2, connectorIds: [] });
    show();
    await screen.findByLabelText('Email addresses');
    state.members.mockClear();
    const invite = screen.getByRole('button', { name: 'Invite teammates' });
    expect(invite).toBeEnabled();
    fireEvent.click(invite);
    expect(await screen.findByRole('alertdialog')).toHaveTextContent('Enter at least one email address.');
    expect(state.invitations).not.toHaveBeenCalled();
    expect(state.members).not.toHaveBeenCalled();
    expect(state.invite).not.toHaveBeenCalled();
  });

  it.each(['x', 'x@@y'])('marks the invalid committed address %s without interrupting editing', async (email) => {
    state.journey.mockResolvedValue({ path: 'creator', stage: 'people', revision: 2, connectorIds: [] });
    show();
    const field = await screen.findByLabelText('Email addresses');
    fireEvent.change(field, { target: { value: email } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(screen.getByText(email).closest('.invite-email-chip')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Invite 1 teammate' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Invite 1 teammate' }));
    expect(await screen.findByRole('alertdialog')).toHaveTextContent('One or more of the addresses are not a valid email address.');
    expect(state.invite).not.toHaveBeenCalled();
  });

  it('submits a single-label domain through the lightweight client check', async () => {
    state.journey.mockResolvedValue({ path: 'creator', stage: 'people', revision: 2, connectorIds: [] });
    state.invite.mockResolvedValue({});
    state.updateJourney.mockResolvedValue({ path: 'creator', stage: 'complete', revision: 3, connectorIds: [] });
    show();
    const field = await screen.findByLabelText('Email addresses');
    fireEvent.change(field, { target: { value: 'x@y' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(screen.getByText('x@y').closest('.invite-email-chip')).not.toHaveAttribute('aria-invalid');
    fireEvent.click(screen.getByRole('button', { name: 'Invite 1 teammate' }));
    await screen.findByText('Ordinary organization');
    expect(state.invite).toHaveBeenCalledWith('x@y', 'member');
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('reconciles invitations after a lost response and retries only undelivered addresses', async () => {
    state.journey.mockResolvedValue({ path: 'creator', stage: 'people', revision: 2, connectorIds: [] });
    state.invite.mockRejectedValueOnce(new Error('Response lost'));
    state.updateJourney.mockResolvedValue({ path: 'creator', stage: 'complete', revision: 3, connectorIds: [] });
    show();
    const field = await screen.findByLabelText('Email addresses');
    fireEvent.change(field, { target: { value: 'aspen@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Invite 1 teammate' }));
    await screen.findByText(/Could not invite:/u);
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    state.invitations.mockResolvedValue([{ email: 'aspen@example.com', invitedAt: '2026-10-24T00:00:00.000Z' }]);
    fireEvent.click(screen.getByRole('button', { name: 'Invite 1 teammate' }));
    await screen.findByText('Ordinary organization');
    expect(state.invite).toHaveBeenCalledTimes(1);
  });

});


describe('Account profile settings', () => {
  it('given an account holding a retired accent, when the picker opens, then the swatch it resolves to reads as selected', async () => {
    // Existing accounts are exactly the population holding `teal`, `green`,
    // `amber` or `slate`, and settings is the surface they open. Comparing the
    // stored name against the pickable keys leaves every swatch unpressed, so
    // the avatar shows emerald above a row that says nothing is chosen — and a
    // screen reader reports all eight as unpressed.
    //
    // The resolved account overrides only this test's mock: `state.account` is
    // module-level and nothing restores it, so assigning to it would follow the
    // rest of the file.
    state.getAccount.mockResolvedValue({ eligible: true, introduced: true, revision: 3,
      presentation: { displayName: 'Person', initials: 'P', avatar: 'circle', color: 'teal', revision: 3 } });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><AccountOnboardingGate><PersonalSetup variant="settings" /></AccountOnboardingGate></QueryClientProvider>);
    await screen.findByLabelText('Avatar initials');

    const swatches = screen.getByRole('group', { name: 'Color' });
    expect(within(swatches).getByRole('button', { name: 'emerald' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(swatches).getAllByRole('button').filter((button) => button.getAttribute('aria-pressed') === 'true')).toHaveLength(1);
  });

  it('saves field edits without a save action and keeps pending updates when leaving the pane', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let release!: (account: unknown) => void;
    state.saveAccount.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }))
      .mockImplementation(async (input) => ({ ...state.account, revision: input.expectedRevision + 1, presentation: { ...input.presentation, revision: input.expectedRevision + 1 } }));
    const view = render(<QueryClientProvider client={client}><AccountOnboardingGate><PersonalSetup variant="settings" /></AccountOnboardingGate></QueryClientProvider>);
    await screen.findByLabelText('Avatar initials');
    expect(screen.queryByRole('button', { name: 'Save profile' })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'New Name' } });
    expect(state.saveAccount).toHaveBeenCalledWith({ expectedRevision: 0, presentation: { displayName: 'New Name', initials: 'P', avatar: 'circle', color: 'blue' } });
    fireEvent.change(screen.getByLabelText('Avatar initials'), { target: { value: 'NN' } });
    fireEvent.click(screen.getByRole('button', { name: 'violet' }));
    expect(screen.getByLabelText('Name')).toHaveValue('New Name');
    expect(screen.getByRole('button', { name: 'violet' })).toHaveAttribute('aria-pressed', 'true');
    view.rerender(<QueryClientProvider client={client}><AccountOnboardingGate><div>Application settings</div></AccountOnboardingGate></QueryClientProvider>);
    await act(async () => release({ ...state.account, revision: 1, presentation: { displayName: 'New Name', initials: 'P', color: 'blue', avatar: 'circle', revision: 1 } }));
    await waitFor(() => expect(state.saveAccount).toHaveBeenCalledTimes(2));
    expect(state.saveAccount.mock.lastCall?.[0]).toMatchObject({ expectedRevision: 1, presentation: { displayName: 'New Name', initials: 'NN', color: 'violet' } });
    expect(client.getQueryData(['account-onboarding', 'person@example.com'])).toMatchObject({ revision: 2, presentation: { displayName: 'New Name', initials: 'NN', color: 'violet' } });
  });
});
