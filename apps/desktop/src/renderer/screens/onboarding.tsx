import { useQuery } from '@tanstack/react-query';
import { LoaderCircle } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { RallyDesktopBridge } from '../../common/desktop';
import { RallyMark, Button, ConnectorMark, ErrorNotice } from '../components/primitives';
import { CreateOrganizationCard } from './create-organization';
import { useAppSession } from '../lib/app-session';
import { desktopBridge } from '../lib/platform';
import { reportTelemetryProductIntent, uuidV7 } from '../lib/telemetry';
import type { PendingWorkspaceInvitation } from '../lib/types';

export type SignInDesktopBridge = Pick<
  RallyDesktopBridge,
  'cancelDesktopAuthAttempt' | 'createDesktopAuthAttempt' | 'openExternal' | 'getRuntimeConfig'
>;

export function BootScreen(): React.JSX.Element {
  return (
    <main className="onboarding-shell window-drag">
      <div className="boot-mark" role="status" aria-label="Opening Rally">
        <RallyMark />
      </div>
    </main>
  );
}


export function SignInScreen(): React.JSX.Element {
  const {
    api,
    clearDeepLinkError,
    createDevelopmentSession,
    deepLinkError,
    exchangingTicket,
    runtime,
    selectRegion,
  } = useAppSession();
  const signupFlow = useRef<Promise<string> | null>(null);
  const signupViewed = useRef(false);
  const ensureSignupFlow = (): Promise<string> => {
    signupFlow.current ??= desktopBridge().getRuntimeConfig()
      .then(config => config.firstSignupFlowId ?? uuidV7())
      .catch(() => uuidV7());
    return signupFlow.current;
  };
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    // Global owns identity; existing workspace assignments come from discovery.
    selectRegion('global');
  }, [selectRegion]);

  useEffect(() => {
    if (!api || signupViewed.current) return;
    signupViewed.current = true;
    void ensureSignupFlow().then(flowId => api.observeSignupView(flowId)).catch(() => undefined);
  }, [api]);

  const beginGoogleLogin = async (): Promise<void> => {
    if (!api) return;
    setStarting(true);
    setError(null);
    clearDeepLinkError();
    let attemptId: string | null = null;
    const bridge: SignInDesktopBridge = desktopBridge();
    try {
      const authAttempt = await bridge.createDesktopAuthAttempt({
        apiBaseUrl: api.baseUrl,
        region: 'global',
      });
      attemptId = authAttempt.attemptId;
      const url = await api.beginGoogleLogin('global', 'rallywithai://auth/complete', { authAttempt, signupFlowId: await ensureSignupFlow() });
      await bridge.openExternal(url);
    } catch (caught) {
      if (attemptId) await bridge.cancelDesktopAuthAttempt(attemptId).catch(() => undefined);
      setError(caught instanceof Error ? caught.message : 'Rally could not open the sign-in page.');
    } finally {
      setStarting(false);
    }
  };

  const useDevelopmentSession = async (): Promise<void> => {
    if (!api) return;
    setStarting(true);
    setError(null);
    try {
      await createDevelopmentSession();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The local development session is unavailable.');
    } finally {
      setStarting(false);
    }
  };

  return (
    <main className="onboarding-shell signin-shell window-drag">
      <section className="signin-card window-no-drag" aria-labelledby="signin-heading">
        <RallyMark className="signin-mark" />
        <h1 id="signin-heading">Welcome to Rally</h1>
        <p>Your team, your work, and Rally. All in one place.</p>

        <p className="signin-account-copy">Sign in or create your account.</p>
        <Button className="button-primary signin-button" disabled={starting || exchangingTicket} onClick={beginGoogleLogin}>
          {starting || exchangingTicket ? <LoaderCircle aria-hidden="true" className="spin" size={16} /> : <ConnectorMark mark="google" />}
          {exchangingTicket ? 'Completing sign in…' : 'Continue with Google'}
        </Button>

        {runtime?.devAuthEnabled && (
          <Button className="button-secondary signin-button" disabled={starting} onClick={useDevelopmentSession}>
            Use local development account
          </Button>
        )}

        {(error ?? deepLinkError) && <ErrorNotice>{error ?? deepLinkError}</ErrorNotice>}
      </section>
    </main>
  );
}

export function RegionOnboarding(): React.JSX.Element {
  const { finishWorkspaceSetup, getOrganizationNameSuggestion, session, signOut, workspaceName } = useAppSession();
  // A prefill, not a step: the card opens at once and a failure leaves it empty.
  const suggestion = useQuery({
    queryKey: ['organization-name-suggestion', session?.user.id],
    queryFn: getOrganizationNameSuggestion,
    enabled: Boolean(session) && !workspaceName.trim(),
    retry: false,
    staleTime: Infinity,
  });
  return (
    <main className="onboarding-shell workspace-setup-shell window-drag">
      <CreateOrganizationCard initialName={workspaceName} suggestedName={suggestion.data?.name ?? null} onCreate={(name, operationId) => finishWorkspaceSetup(name, 'global', operationId)}>
        {session && <p className="signed-in-identity">Signed in as {session.user.email}</p>}
        <button className="text-button onboarding-signout" onClick={() => void signOut()} type="button">Sign out</button>
      </CreateOrganizationCard>
    </main>
  );
}

export function InvitationOnboarding({
  invitations,
  onChanged,
}: {
  invitations: PendingWorkspaceInvitation[];
  onChanged: () => Promise<unknown> | void;
}): React.JSX.Element {
  const { acceptInvitation, declineInvitation, session, signOut } = useAppSession();
  const [workingId, setWorkingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const accept = async (invitation: PendingWorkspaceInvitation): Promise<void> => {
    const operationId = uuidV7();
    reportTelemetryProductIntent({
      kind: 'workspace_activation_requested',
      selectedRegion: invitation.region,
      entrypoint: 'invitation',
      operationId,
    });
    setWorkingId(invitation.id);
    setError(null);
    try {
      await acceptInvitation(invitation.region, invitation.id, operationId);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The invitation could not be accepted.');
      await onChanged();
    } finally {
      setWorkingId(null);
    }
  };

  const decline = async (invitation: PendingWorkspaceInvitation): Promise<void> => {
    setWorkingId(invitation.id);
    setError(null);
    try {
      await declineInvitation(invitation.region, invitation.id);
      await onChanged();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The invitation could not be declined.');
    } finally {
      setWorkingId(null);
    }
  };

  return (
    <main className="onboarding-shell signin-shell window-drag">
      <section className="signin-card invitation-card window-no-drag" aria-labelledby="invitation-heading">
        <span className="invitation-icon"><RallyMark /></span>
        <p className="eyebrow">Organization invitations</p>
        <h1 id="invitation-heading">Choose where to join</h1>
        <p>Signed in as <strong>{session?.user.email}</strong>. Accept an invitation or decline it to continue.</p>
        <div className="invitation-choice-list">
          {invitations.map((invitation) => (
            <article className="invitation-choice" key={invitation.id}>
              <div>
                <strong>{invitation.workspaceName}</strong>
                <span>Invited by {invitation.invitedByName} · {invitation.role === 'admin' ? 'Administrator' : 'Member'}</span>

              </div>
              <div className="invitation-choice-actions">
                <Button disabled={workingId !== null} onClick={() => void decline(invitation)}>Decline</Button>
                <Button className="button-primary" disabled={workingId !== null} onClick={() => void accept(invitation)}>
                  {workingId === invitation.id && <LoaderCircle aria-hidden="true" className="spin" size={14} />}
                  Accept
                </Button>
              </div>
            </article>
          ))}
        </div>
        {error && <ErrorNotice>{error}</ErrorNotice>}
        <button className="text-button onboarding-signout" onClick={() => void signOut()} type="button">Sign out</button>
      </section>
    </main>
  );
}
