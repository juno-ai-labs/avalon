import { Building2, LoaderCircle } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { RallyDesktopBridge } from '../../common/desktop';
import { RallyMark, Button, ConnectorMark, InlineError } from '../components/primitives';
import { useAppSession } from '../lib/app-session';
import { isComposingKeyEvent } from '../lib/ime';
import { desktopBridge } from '../lib/platform';
import { reportTelemetryProductIntent, uuidV7 } from '../lib/telemetry';
import type { PendingWorkspaceInvitation } from '../lib/types';

export type SignInDesktopBridge = Pick<
  RallyDesktopBridge,
  'cancelDesktopAuthAttempt' | 'createDesktopAuthAttempt' | 'openExternal'
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
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    // Global owns identity; existing workspace assignments come from discovery.
    selectRegion('global');
  }, [selectRegion]);

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
      const url = await api.beginGoogleLogin('global', 'rallywithai://auth/complete', { authAttempt });
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

        {(error ?? deepLinkError) && <InlineError>{error ?? deepLinkError}</InlineError>}
      </section>
    </main>
  );
}

export function RegionOnboarding(): React.JSX.Element {
  const { finishWorkspaceSetup, session, signOut, workspaceName } = useAppSession();
  const selected = 'global';
  const [name, setName] = useState(workspaceName);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const createOperation = useRef<{ fingerprint: string; id: string } | null>(null);

  const continueSetup = async (): Promise<void> => {
    // Holding Enter repeats it, and the button stays reachable while the first
    // create is in flight: without this each repeat mints a fresh operation id,
    // so the server answers the second one with a conflict on the reservation
    // the first one took, and the funnel counts a workspace_create_requested
    // per keystroke. The button's own `disabled` covers only the pointer.
    if (working) return;
    if (name.trim().length < 2) return;
    const fingerprint = JSON.stringify({ name: name.trim(), region: selected });
    const operation = createOperation.current?.fingerprint === fingerprint
      ? createOperation.current
      : { fingerprint, id: uuidV7() };
    createOperation.current = operation;
    const operationId = operation.id;
    reportTelemetryProductIntent({
      kind: 'workspace_create_requested',
      selectedRegion: selected,
      entrypoint: 'first_run',
      operationId,
    });
    setWorking(true);
    setError(null);
    try {
      await finishWorkspaceSetup(name, selected, operationId);
      createOperation.current = null;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Rally could not create this workspace.');
    } finally {
      setWorking(false);
    }
  };

  return (
    <main className="onboarding-shell workspace-setup-shell window-drag">
      <section className="onboarding-card workspace-setup-card window-no-drag" aria-labelledby="workspace-heading">
        <RallyMark className="signin-mark" />
        <div className="onboarding-copy">
          <h1 id="workspace-heading">Create your workspace</h1>
          <p>A shared home for your team and Rally.</p>
        </div>

        <label className="onboarding-field">
          <span>Workspace name</span>
          <span className="onboarding-input-wrap">
            <Building2 aria-hidden="true" size={16} />
            <input
              autoComplete="organization"
              autoFocus
              maxLength={120}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                // A plain input rather than a ComposerInput, so this field
                // keeps its own copy of the guard. See `../lib/ime.ts`.
                if (isComposingKeyEvent(event.nativeEvent)) return;
                if (event.key === 'Enter') void continueSetup();
              }}
              placeholder="Acme"
              value={name}
            />
          </span>
        </label>

        {error && <InlineError>{error}</InlineError>}
        <Button className="button-primary onboarding-continue" disabled={working || name.trim().length < 2} onClick={() => void continueSetup()}>
          {working && <LoaderCircle aria-hidden="true" className="spin" size={16} />}
          Create workspace
        </Button>
        {session && <p className="signed-in-identity">Signed in as {session.user.email}</p>}
        <button className="text-button onboarding-signout" onClick={() => void signOut()} type="button">Sign out</button>
      </section>
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
        <p className="eyebrow">Workspace invitations</p>
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
        {error && <InlineError>{error}</InlineError>}
        <button className="text-button onboarding-signout" onClick={() => void signOut()} type="button">Sign out</button>
      </section>
    </main>
  );
}
