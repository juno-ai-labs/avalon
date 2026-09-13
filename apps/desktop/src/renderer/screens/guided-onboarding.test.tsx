import { useConversationAdmission } from '../lib/conversation-admission';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountOnboardingGate, PersonalSetup, WorkspaceOnboardingJourney } from './guided-onboarding';
import { act } from '@testing-library/react';
import type { Workspace } from '../lib/types';
import { MemoryRouter, useLocation, useNavigationType } from 'react-router-dom';

const state = vi.hoisted(() => ({
  signedIn: true,
  hasWorkspace: true,
  account: { eligible: true, introduced: true, presentation: null, revision: 0 },
  getAccount: vi.fn(), saveAccount: vi.fn(), journey: vi.fn(), updateJourney: vi.fn(),
  invitations: vi.fn(), invite: vi.fn(), members: vi.fn(), connections: vi.fn(), connectors: vi.fn(),
  openSettings: vi.fn(), openExternal: vi.fn(), startProviderConnection: vi.fn(),
}));
vi.mock('../lib/platform', () => ({ desktopBridge: () => ({ getAccountOnboarding: state.getAccount, updateAccountOnboarding: state.saveAccount,
  openSettings: state.openSettings, openExternal: state.openExternal }) }));
vi.mock('../lib/app-session', () => ({ useAppSession: () => ({
  session: state.signedIn ? { user: { id: 'user-1', email: 'person@example.com', name: 'Person' }, workspace: state.hasWorkspace ? { id: 'workspace-1' } : null } : null,
  api: { getWorkspaceInvitations: state.invitations, createWorkspaceInvitation: state.invite, getWorkspaceMembers: state.members, getOnboardingJourney: state.journey,
    updateOnboardingJourney: state.updateJourney, getConnections: state.connections, getAvailableConnectorTypes: state.connectors,
    startProviderConnection: state.startProviderConnection },
  signOut: vi.fn(), setPendingConnectorOAuth: vi.fn(),
}) }));
const workspace = { id: 'workspace-1', region: 'global', name: 'Team', currentUser: { id: 'user-1', name: 'Person', role: 'member' } } as Workspace;
function Route(): React.JSX.Element {
  const location = useLocation();
  return <div data-testid="route">{`${useNavigationType()} ${location.pathname}`}</div>;
}
function WorkspaceView(): React.JSX.Element {
  const allowed = useConversationAdmission();
  return <><div>Ordinary workspace</div><output data-testid="admission">{allowed ? 'allowed' : 'blocked'}</output></>;
}
function show() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // The journey renders inside the app's HashRouter and leaves through it, so
  // the harness gives it a router and reports where it went.
  render(<MemoryRouter initialEntries={['/onboarding']}><QueryClientProvider client={client}><AccountOnboardingGate><WorkspaceOnboardingJourney workspace={workspace}><WorkspaceView /></WorkspaceOnboardingJourney></AccountOnboardingGate></QueryClientProvider><Route /></MemoryRouter>);
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
  it('sends members directly to personal setup and saves their chosen appearance before opening the first work stream', async () => {
    state.saveAccount.mockResolvedValue({ ...state.account, revision: 1, presentation: { color: 'rose', avatar: 'circle', revision: 1 } });
    state.updateJourney.mockResolvedValue({ path: 'member', stage: 'complete', revision: 1, connectorIds: [] });
    show(); await screen.findByRole('heading', { name: 'This is you in Rally' });
    expect(screen.queryByText('Bring context for your first task')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'rose' }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue with this look' }));
    await screen.findByText('Ordinary workspace');
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
    // Anchored, because `toHaveTextContent` matches a string as a substring:
    // "REPLACE /workstreams/x" would satisfy the bare "REPLACE /". Today
    // `useOpenFirstWorkstream` always navigates to `WORKSTREAM_LANDING_ROUTE`
    // and the landing resolves the stream to open within that route, so no
    // such pathname can reach here — the anchor is what keeps that true if the
    // landing ever redirects instead.
    await waitFor(() => expect(screen.getByTestId('route')).toHaveTextContent(/^REPLACE \/$/u));
  });
  it('retains personal setup when the account save fails', async () => {
    state.saveAccount.mockRejectedValue(new Error('Profile changed in another session')); show();
    await screen.findByRole('heading', { name: 'This is you in Rally' });
    fireEvent.click(screen.getByRole('button', { name: 'Continue with this look' }));
    await screen.findByText('Profile changed in another session');
    expect(state.updateJourney).not.toHaveBeenCalled();
  });
  it('starts creators at connectors and offers a skip', async () => {
    state.journey.mockResolvedValue({ path: 'creator', stage: 'connectors', revision: 0, connectorIds: [] });
    state.updateJourney.mockResolvedValue({ path: 'creator', stage: 'profile', revision: 1, connectorIds: [] });
    show(); await screen.findByRole('heading', { name: 'Connect tools for your workspace' });
    fireEvent.click(screen.getByRole('button', { name: 'Skip for now' }));
    await screen.findByRole('heading', { name: 'Connect your personal tools' });
    fireEvent.click(screen.getByRole('button', { name: 'Skip for now' }));
    await waitFor(() => expect(state.updateJourney).toHaveBeenCalledWith({ expectedRevision: 0, stage: 'profile' }));
  });
  it.each([{ provider: 'ashby', name: 'Ashby' }, { provider: 'granola', name: 'Granola' }])('opens Settings for $name workspace setup', async ({ provider, name }) => {
    const journey = { path: 'creator', stage: 'connectors', revision: 0, connectorIds: [] };
    state.connectors.mockResolvedValue([provider]);
    state.journey.mockResolvedValue(journey);
    state.updateJourney.mockImplementation(async (update) => ({ ...journey, ...update, revision: update.expectedRevision + 1 }));
    show();
    fireEvent.click(await screen.findByRole('button', { name }));
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Connect for workspace' }));
    await waitFor(() => expect(state.openSettings).toHaveBeenCalledWith('connections'));
    expect(state.startProviderConnection).not.toHaveBeenCalled();
    expect(state.openExternal).not.toHaveBeenCalled();
  });
  it('keeps personal Ashby onboarding on browser authorization', async () => {
    const journey = { path: 'creator', stage: 'connectors', revision: 0, connectorIds: [] };
    state.connectors.mockResolvedValue(['ashby']);
    state.journey.mockResolvedValue(journey);
    state.updateJourney.mockImplementation(async (update) => ({ ...journey, ...update, revision: update.expectedRevision + 1 }));
    show();
    await screen.findByRole('heading', { name: 'Connect tools for your workspace' });
    fireEvent.click(screen.getByRole('button', { name: 'Skip for now' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Ashby' }));
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Connect for me' }));
    await waitFor(() => expect(state.openExternal).toHaveBeenCalledWith('https://provider.example/authorize'));
    expect(state.startProviderConnection).toHaveBeenCalledWith('ashby', 'you', ['ashby.personal.mcp']);
    expect(state.openSettings).not.toHaveBeenCalled();
  });
  it('opens a restored workspace before account lookup and keeps it mounted when details arrive', async () => {
    let resolveLookup!: (account: typeof state.account) => void;
    state.getAccount.mockImplementation(() => new Promise((resolve) => { resolveLookup = resolve; }));
    const client = show();
    const workspaceElement = screen.getByText('Ordinary workspace');
    expect(screen.getByTestId('admission')).toHaveTextContent('blocked');
    expect(screen.queryByRole('heading', { name: 'Opening Rally' })).not.toBeInTheDocument();
    expect(state.getAccount).toHaveBeenCalledTimes(1);
    await act(async () => { resolveLookup({ ...state.account, eligible: false }); });
    await waitFor(() => expect(client.getQueryState(['account-onboarding', 'person@example.com'])?.status).toBe('success'));
    expect(screen.getByText('Ordinary workspace')).toBe(workspaceElement);
    await waitFor(() => expect(screen.getByTestId('admission')).toHaveTextContent('allowed'));
  });
  it('keeps a returning workspace mounted while journey progress loads and completes', async () => {
    let resolveJourney!: (journey: { path: string; stage: string; revision: number; connectorIds: string[] }) => void;
    state.journey.mockImplementation(() => new Promise((resolve) => { resolveJourney = resolve; }));
    const client = show();
    const workspaceElement = screen.getByText('Ordinary workspace');
    await waitFor(() => expect(state.journey).toHaveBeenCalledTimes(1));
    expect(screen.getByText('Ordinary workspace')).toBe(workspaceElement);
    expect(screen.queryByRole('heading', { name: 'Opening your workspace' })).not.toBeInTheDocument();
    expect(screen.getByTestId('admission')).toHaveTextContent('blocked');
    await act(async () => { resolveJourney({ path: 'member', stage: 'complete', revision: 1, connectorIds: [] }); });
    await waitFor(() => expect(client.getQueryState(['onboarding-journey', 'global', 'workspace-1', 'user-1'])?.status).toBe('success'));
    expect(screen.getByText('Ordinary workspace')).toBe(workspaceElement);
    await waitFor(() => expect(screen.getByTestId('admission')).toHaveTextContent('allowed'));
  });
  it('keeps a new identity gated until its introduction status arrives', async () => {
    state.hasWorkspace = false;
    let resolveLookup!: (account: typeof state.account) => void;
    state.getAccount.mockImplementation(() => new Promise((resolve) => { resolveLookup = resolve; }));
    show();
    expect(screen.getByRole('heading', { name: 'Opening Rally' })).toBeInTheDocument();
    expect(screen.queryByText('Ordinary workspace')).not.toBeInTheDocument();
    await act(async () => { resolveLookup({ ...state.account, introduced: false }); });
    expect(await screen.findByRole('heading', { name: 'Meet Rally. Work moves forward together.' })).toBeInTheDocument();
    expect(screen.queryByText('Ordinary workspace')).not.toBeInTheDocument();
  });
  it('still introduces an eligible workspace account when its background lookup completes', async () => {
    let resolveLookup!: (account: typeof state.account) => void;
    state.getAccount.mockImplementation(() => new Promise((resolve) => { resolveLookup = resolve; }));
    show();
    expect(screen.getByText('Ordinary workspace')).toBeInTheDocument();
    expect(screen.getByTestId('admission')).toHaveTextContent('blocked');
    await act(async () => { resolveLookup({ ...state.account, introduced: false }); });
    expect(await screen.findByRole('heading', { name: 'Meet Rally. Work moves forward together.' })).toBeInTheDocument();
    expect(screen.queryByText('Ordinary workspace')).not.toBeInTheDocument();
  });
  it('withholds admission when pending journey progress resolves to unfinished setup', async () => {
    let finishJourney!: (value: { path: string; stage: string; revision: number; connectorIds: string[] }) => void;
    state.journey.mockImplementation(() => new Promise((resolve) => { finishJourney = resolve; }));
    show();
    await waitFor(() => expect(state.journey).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('admission')).toHaveTextContent('blocked');
    await act(async () => { finishJourney({ path: 'member', stage: 'profile', revision: 0, connectorIds: [] }); });
    expect(await screen.findByRole('heading', { name: 'This is you in Rally' })).toBeInTheDocument();
    expect(screen.queryByText('Ordinary workspace')).not.toBeInTheDocument();
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
  it('keeps an identity without a workspace gated after a failed lookup and during retry', async () => {
    state.hasWorkspace = false;
    state.getAccount.mockRejectedValue(new Error('Identity unavailable'));
    show();
    expect(await screen.findByRole('heading', { name: "Let's pick up where you left off" })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
    expect(screen.queryByText('Ordinary workspace')).not.toBeInTheDocument();
    let rejectLookup!: (error: Error) => void;
    state.getAccount.mockImplementation(() => new Promise((_resolve, reject) => { rejectLookup = reject; }));
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('heading', { name: 'Opening Rally' })).toBeInTheDocument();
    expect(state.getAccount).toHaveBeenCalledTimes(2);
    expect(screen.queryByText('Ordinary workspace')).not.toBeInTheDocument();
    await act(async () => { rejectLookup(new Error('Identity still unavailable')); });
    expect(await screen.findByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
    expect(screen.queryByText('Ordinary workspace')).not.toBeInTheDocument();
  });
  it('keeps an authenticated workspace available when the identity service is unavailable', async () => {
    state.getAccount.mockRejectedValue(new Error('Identity unavailable'));
    show();
    expect(await screen.findByText('Ordinary workspace')).toBeInTheDocument();
  });
  it('keeps the workspace mounted while retrying a failed account lookup', async () => {
    state.getAccount.mockRejectedValue(new Error('Identity unavailable'));
    const client = show();
    const workspaceElement = await screen.findByText('Ordinary workspace');
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
    expect(screen.getByText('Ordinary workspace')).toBe(workspaceElement);
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
    const journey = { path: 'creator', stage: 'connectors', revision: 0, connectorIds: [] };
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
    state.journey.mockResolvedValue({ path: 'creator', stage: 'people', revision: 2, connectorIds: [] });
    state.invite.mockRejectedValueOnce(new Error('Response lost'));
    state.updateJourney.mockResolvedValue({ path: 'creator', stage: 'complete', revision: 3, connectorIds: [] });
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
