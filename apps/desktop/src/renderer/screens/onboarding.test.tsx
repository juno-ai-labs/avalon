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
}));
const telemetry = vi.hoisted(() => ({
  operationId: '00000000-0000-7000-8000-000000000011',
  reportTelemetryProductIntent: vi.fn(),
}));
const bridge = vi.hoisted(() => ({
  cancelDesktopAuthAttempt: vi.fn(),
  createDesktopAuthAttempt: vi.fn(),
  openExternal: vi.fn(),
}) satisfies SignInDesktopBridge);
const sessionState = vi.hoisted(() => ({
  acceptInvitation: vi.fn(),
  api,
  clearDeepLinkError: vi.fn(),
  createDevelopmentSession: vi.fn(),
  deepLinkError: null as string | null,
  declineInvitation: vi.fn(),
  exchangingTicket: false,
  finishWorkspaceSetup: vi.fn(),
  region: 'global' as 'global' | 'eu',
  runtime: {
    appVersion: 'test',
    isPackaged: true,
    platform: 'darwin',
    api: { global: 'https://api.rallywith.ai', eu: 'https://eu.api.rallywith.ai' },
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
vi.mock('../lib/platform', () => ({ desktopBridge: () => bridge }));
vi.mock('../lib/telemetry', () => ({
  reportTelemetryProductIntent: telemetry.reportTelemetryProductIntent,
  uuidV7: () => telemetry.operationId,
}));

const invitation: PendingWorkspaceInvitation = {
  id: '00000000-0000-7000-8000-000000000009',
  workspaceId: '00000000-0000-7000-8000-000000000010',
  workspaceName: 'Rally Studio',
  region: 'eu',
  email: 'adam@example.com',
  role: 'member',
  invitedByName: 'Sam',
  expiresAt: '2026-08-08T00:00:00.000Z',
};

describe('identity-first onboarding screens', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
  });

  it('uses one global identity entry and does not ask for a login region', async () => {
    sessionState.region = 'eu';
    render(<SignInScreen />);

    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
    await waitFor(() => expect(sessionState.selectRegion).toHaveBeenCalledWith('global'));
    fireEvent.click(screen.getByRole('button', { name: 'Continue with Google' }));

    await waitFor(() => expect(api.beginGoogleLogin).toHaveBeenCalledWith(
      'global',
      'rallywithai://auth/complete',
      { authAttempt: { attemptId: 'a'.repeat(43), codeChallenge: 'c'.repeat(43) } },
    ));
  });

  it('collects organization name and data region only after authentication', async () => {
    render(<RegionOnboarding />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Organization name' }), {
      target: { value: 'Acme Research' },
    });
    fireEvent.click(screen.getByRole('radio', { name: /European Union/u }));
    fireEvent.click(screen.getByRole('button', { name: 'Create organization' }));

    await waitFor(() => expect(sessionState.finishWorkspaceSetup).toHaveBeenCalledWith(
      'Acme Research', 'eu', telemetry.operationId,
    ));
  });

  it('does not create the organization when Enter only commits an IME composition', async () => {
    render(<RegionOnboarding />);
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
    render(<RegionOnboarding />);
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
    expect(telemetry.reportTelemetryProductIntent).toHaveBeenCalledTimes(2);
    finishSetup?.();
  });

  it('describes storage jurisdiction without listing unavailable EU capabilities', () => {
    render(<RegionOnboarding />);

    expect(screen.getByText('US-Jurisdiction storage')).toBeVisible();
    expect(screen.getByText('EU-jurisdiction storage')).toBeVisible();
    expect(screen.getByText('This choice controls only where workspace data is stored and cannot be changed later.')).toBeVisible();
    expect(screen.queryByText(/Cloudflare storage|regional routing|Your Rally sign-in stays the same/u)).not.toBeInTheDocument();
    expect(screen.queryByText('Unavailable for EU region (at this time, subject to change based on providers)')).not.toBeInTheDocument();
    expect(screen.queryByText('Rally agent: Terminal access')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('radio', { name: /European Union/u }));
    expect(screen.queryByText('Unavailable for EU region (at this time, subject to change based on providers)')).not.toBeInTheDocument();
    expect(screen.queryByText('Rally agent: Terminal access')).not.toBeInTheDocument();
    expect(screen.queryByRole('list')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('radio', { name: /Global/u }));
    expect(screen.queryByText('Unavailable for EU region (at this time, subject to change based on providers)')).not.toBeInTheDocument();
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
  });

  it('accepts a pending invitation through its own region without another login prompt', async () => {
    render(<InvitationOnboarding invitations={[invitation]} onChanged={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }));

    await waitFor(() => expect(sessionState.acceptInvitation).toHaveBeenCalledWith(
      'eu', invitation.id, telemetry.operationId,
    ));
    expect(telemetry.reportTelemetryProductIntent).toHaveBeenCalledWith({
      kind: 'workspace_activation_requested',
      selectedRegion: 'eu',
      entrypoint: 'invitation',
      operationId: telemetry.operationId,
    });
  });

  it('declines a pending invitation and reloads the remaining choices', async () => {
    const onChanged = vi.fn();
    render(<InvitationOnboarding invitations={[invitation]} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole('button', { name: 'Decline' }));

    await waitFor(() => expect(sessionState.declineInvitation).toHaveBeenCalledWith('eu', invitation.id));
    expect(onChanged).toHaveBeenCalledOnce();
  });
});
