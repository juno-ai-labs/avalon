import "../../../../../tests/isolated-region";
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesktopSession } from '../../common/desktop';
import type { PendingWorkspaceInvitation } from '../lib/types';
import {
  InvitationOnboarding,
  RegionOnboarding,
  SignInScreen,
  type SignInDesktopBridge,
} from './onboarding';

const api = vi.hoisted(() => ({
  beginGoogleLogin: vi.fn(),
  beginProviderLogin: vi.fn(),
  observeSignupView: vi.fn(),
}));
const telemetry = vi.hoisted(() => ({
  operationId: '00000000-0000-7000-8000-000000000011',
  reportTelemetryProductIntent: vi.fn(),
}));
const bridge = vi.hoisted(() => ({
  getRuntimeConfig: vi.fn(),
  cancelDesktopAuthAttempt: vi.fn(),
  createDesktopAuthAttempt: vi.fn(),
  openExternal: vi.fn(),
}) satisfies SignInDesktopBridge);
const sessionState = vi.hoisted(() => ({
  acceptInvitation: vi.fn(),
  api,
  clearDeepLinkError: vi.fn(),
  createDevelopmentSession: vi.fn(),
  signInWithPassword: vi.fn(),
  deepLinkError: null as string | null,
  declineInvitation: vi.fn(),
  exchangingTicket: false,
  finishWorkspaceSetup: vi.fn(),
  getOrganizationNameSuggestion: vi.fn(),
  region: 'global' as string,
  runtime: {
    appVersion: 'test',
    isPackaged: true,
    platform: 'darwin',
    api: { global: 'https://api.rallywith.ai', enterprise: 'https://enterprise.api.rallywith.ai' },
    devAuthEnabled: false,
  },
  selectRegion: vi.fn(),
  session: {
    accessToken: 'access-token-longer-than-twenty-characters',
    expiresAt: '2026-08-02T00:00:00.000Z',
    apiBaseUrl: 'https://api.rallywith.ai',
    user: { id: 'user-1', email: 'adam@example.com', name: 'Adam' },
    workspace: null,
  } as DesktopSession,
  signOut: vi.fn(),
  workspaceName: '',
}));

vi.mock('../lib/app-session', () => ({ useAppSession: () => sessionState }));
vi.mock('../lib/platform', () => ({
  desktopBridge: () => bridge,
  desktopServicesAvailable: () => false,
}));
vi.mock('../lib/telemetry', () => ({
  reportTelemetryProductIntent: telemetry.reportTelemetryProductIntent,
  uuidV7: () => telemetry.operationId,
}));

function renderRegionOnboarding(): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={queryClient}><RegionOnboarding /></QueryClientProvider>);
}

const invitation: PendingWorkspaceInvitation = {
  id: '00000000-0000-7000-8000-000000000009',
  workspaceId: '00000000-0000-7000-8000-000000000010',
  workspaceName: 'Rally Studio',
  region: 'enterprise',
  email: 'adam@example.com',
  role: 'member',
  invitedByName: 'Sam',
  expiresAt: '2026-08-08T00:00:00.000Z',
};

describe('identity-first onboarding screens', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    bridge.getRuntimeConfig.mockResolvedValue(sessionState.runtime);
    api.observeSignupView.mockResolvedValue(undefined);
    sessionState.region = 'global';
    sessionState.workspaceName = '';
    api.beginGoogleLogin.mockResolvedValue('https://accounts.google.com/o/oauth2/v2/auth?state=opaque');
    bridge.createDesktopAuthAttempt.mockResolvedValue({
      attemptId: 'a'.repeat(43),
      codeChallenge: 'c'.repeat(43),
    });
    bridge.openExternal.mockResolvedValue(undefined);
    sessionState.acceptInvitation.mockResolvedValue(undefined);
    sessionState.declineInvitation.mockResolvedValue(undefined);
    sessionState.getOrganizationNameSuggestion.mockResolvedValue({ name: null });
  });

  it('uses one global identity entry and does not ask for a login region', async () => {
    sessionState.region = 'enterprise';
    const view = render(<SignInScreen />);
    await waitFor(() => expect(api.observeSignupView).toHaveBeenCalledWith(telemetry.operationId));
    view.rerender(<SignInScreen />);
    expect(api.observeSignupView).toHaveBeenCalledTimes(1);

    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
    await waitFor(() => expect(sessionState.selectRegion).toHaveBeenCalledWith('global'));
    fireEvent.click(screen.getByRole('button', { name: 'Continue with Google' }));

    await waitFor(() => expect(api.beginGoogleLogin).toHaveBeenCalledWith(
      'global',
      'rallywithai://auth/complete',
      { authAttempt: { attemptId: 'a'.repeat(43), codeChallenge: 'c'.repeat(43) }, signupFlowId: telemetry.operationId },
    ));
  });

  it('carries the fresh-install flow through the sign-in screen and Google start', async () => {
    bridge.getRuntimeConfig.mockResolvedValue({ ...sessionState.runtime, firstSignupFlowId: '01a0ee73-d366-7fb9-b5c0-3ceb3156f70a' });
    render(<SignInScreen />);
    await waitFor(() => expect(api.observeSignupView).toHaveBeenCalledWith('01a0ee73-d366-7fb9-b5c0-3ceb3156f70a'));
    fireEvent.click(screen.getByRole('button', { name: 'Continue with Google' }));
    await waitFor(() => expect(api.beginGoogleLogin).toHaveBeenCalledWith('global', 'rallywithai://auth/complete', {
      authAttempt: { attemptId: 'a'.repeat(43), codeChallenge: 'c'.repeat(43) },
      signupFlowId: '01a0ee73-d366-7fb9-b5c0-3ceb3156f70a',
    }));
  });

  it('starts Apple sign-in through the same desktop attempt and opens Apple in the browser', async () => {
    api.beginProviderLogin.mockResolvedValue('https://appleid.apple.com/auth/authorize?state=opaque');
    render(<SignInScreen />);
    fireEvent.click(await screen.findByRole('button', { name: 'Continue with Apple' }));
    await waitFor(() => expect(bridge.openExternal).toHaveBeenCalledWith('https://appleid.apple.com/auth/authorize?state=opaque'));
    expect(api.beginProviderLogin).toHaveBeenCalledWith('apple', 'global', 'rallywithai://auth/complete', {
      authAttempt: { attemptId: 'a'.repeat(43), codeChallenge: 'c'.repeat(43) },
      signupFlowId: telemetry.operationId,
    });
    expect(api.beginGoogleLogin).not.toHaveBeenCalled();
  });

  it('keeps signup available when first-install telemetry cannot be read', async () => {
    bridge.getRuntimeConfig.mockRejectedValue(new Error('runtime unavailable'));
    render(<SignInScreen />);
    await waitFor(() => expect(api.observeSignupView).toHaveBeenCalledWith(telemetry.operationId));
    fireEvent.click(screen.getByRole('button', { name: 'Continue with Google' }));
    await waitFor(() => expect(api.beginGoogleLogin).toHaveBeenCalledWith('global', 'rallywithai://auth/complete', expect.objectContaining({ signupFlowId: telemetry.operationId })));
  });

  it('collects an organization name after authentication and defaults to Global', async () => {
    renderRegionOnboarding();
    fireEvent.change(screen.getByRole('textbox', { name: 'Organization name' }), {
      target: { value: 'Acme Research' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create organization' }));

    await waitFor(() => expect(sessionState.finishWorkspaceSetup).toHaveBeenCalledWith(
      'Acme Research', 'global', telemetry.operationId,
    ));
  });

  it('does not create the organization when Enter only commits an IME composition', async () => {
    renderRegionOnboarding();
    const nameField = screen.getByRole('textbox', { name: 'Organization name' });
    fireEvent.change(nameField, { target: { value: 'Acme Research' } });

    fireEvent.keyDown(nameField, { key: 'Enter', isComposing: true });
    expect(sessionState.finishWorkspaceSetup).not.toHaveBeenCalled();
    // Nor is the funnel told a create was requested: the guard has to sit ahead
    // of the intent reports, or one is emitted per committed IME candidate.
    expect(telemetry.reportTelemetryProductIntent).not.toHaveBeenCalled();

    fireEvent.keyDown(nameField, { key: 'Enter', keyCode: 229 });
    expect(sessionState.finishWorkspaceSetup).not.toHaveBeenCalled();
    expect(telemetry.reportTelemetryProductIntent).not.toHaveBeenCalled();

    fireEvent.keyDown(nameField, { key: 'Enter' });
    await waitFor(() => expect(sessionState.finishWorkspaceSetup).toHaveBeenCalledWith(
      'Acme Research', 'global', telemetry.operationId,
    ));
  });

  it('creates the organization once however many times Enter repeats', async () => {
    let finishSetup: (() => void) | undefined;
    // `Once`, so the pending create cannot outlive this test: the shared session
    // double is cleared between tests but keeps whatever implementation it was
    // last given.
    sessionState.finishWorkspaceSetup.mockImplementationOnce(() => new Promise<void>((resolve) => {
      finishSetup = resolve;
    }));
    renderRegionOnboarding();
    const nameField = screen.getByRole('textbox', { name: 'Organization name' });
    fireEvent.change(nameField, { target: { value: 'Acme Research' } });

    // Auto-repeat: holding Enter down while the first create is in flight. Each
    // repeat would otherwise mint a fresh operation id, so the second create
    // collides with the first's reservation and the funnel counts both.
    fireEvent.keyDown(nameField, { key: 'Enter' });
    await waitFor(() => expect(sessionState.finishWorkspaceSetup).toHaveBeenCalledOnce());
    fireEvent.keyDown(nameField, { key: 'Enter' });
    fireEvent.keyDown(nameField, { key: 'Enter' });

    expect(sessionState.finishWorkspaceSetup).toHaveBeenCalledOnce();
    expect(telemetry.reportTelemetryProductIntent).toHaveBeenCalledTimes(1);
    finishSetup?.();
  });

  it('prefills the organization name from the email domain when the field is untouched', async () => {
    sessionState.getOrganizationNameSuggestion.mockResolvedValue({ name: 'Acme Robotics' });
    renderRegionOnboarding();
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Organization name' })).toHaveValue('Acme Robotics'));
    fireEvent.click(screen.getByRole('button', { name: 'Create organization' }));
    await waitFor(() => expect(sessionState.finishWorkspaceSetup).toHaveBeenCalledWith(
      'Acme Robotics', 'global', telemetry.operationId,
    ));
  });

  it('keeps a name the person typed when the suggestion arrives later', async () => {
    let answer: ((value: { name: string }) => void) | undefined;
    sessionState.getOrganizationNameSuggestion.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    renderRegionOnboarding();
    const nameField = screen.getByRole('textbox', { name: 'Organization name' });
    fireEvent.change(nameField, { target: { value: 'Skunkworks' } });
    await waitFor(() => expect(answer).toBeDefined());
    answer!({ name: 'Acme Robotics' });
    await waitFor(() => expect(sessionState.getOrganizationNameSuggestion).toHaveBeenCalledOnce());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(nameField).toHaveValue('Skunkworks');
  });

  it('does not offer a deployment picker during organization creation', () => {
    renderRegionOnboarding();
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Organization name' })).toBeVisible();
  });

  it('accepts a pending invitation through its own region without another login prompt', async () => {
    render(<InvitationOnboarding invitations={[invitation]} onChanged={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }));

    await waitFor(() => expect(sessionState.acceptInvitation).toHaveBeenCalledWith(
      'enterprise', invitation.id, telemetry.operationId,
    ));
    expect(telemetry.reportTelemetryProductIntent).toHaveBeenCalledWith({
      kind: 'workspace_activation_requested',
      selectedRegion: 'enterprise',
      entrypoint: 'invitation',
      operationId: telemetry.operationId,
    });
  });

  it('declines a pending invitation and reloads the remaining choices', async () => {
    const onChanged = vi.fn();
    render(<InvitationOnboarding invitations={[invitation]} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole('button', { name: 'Decline' }));

    await waitFor(() => expect(sessionState.declineInvitation).toHaveBeenCalledWith('enterprise', invitation.id));
    expect(onChanged).toHaveBeenCalledOnce();
  });

  it('signs in with a password and lets the user return to the other sign-in options', async () => {
    sessionState.signInWithPassword.mockResolvedValue(undefined);
    render(<SignInScreen />);
    fireEvent.click(screen.getByRole('button', { name: 'Sign in with password' }));
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'Reviewer@Example.test' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'example-password-with-spaces ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(sessionState.signInWithPassword).toHaveBeenCalledWith({
      email: 'Reviewer@Example.test', password: 'example-password-with-spaces ',
    }), { timeout: 5_000 });
    await waitFor(() => expect(screen.getByLabelText('Password')).toHaveValue(''), { timeout: 5_000 });
    fireEvent.click(screen.getByRole('button', { name: 'Other sign-in options' }));
    expect(screen.getByRole('button', { name: 'Continue with Google' })).toBeInTheDocument();
  });
});
