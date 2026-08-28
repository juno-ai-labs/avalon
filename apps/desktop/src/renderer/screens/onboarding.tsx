import { Building2, Check, ExternalLink, Globe2, LoaderCircle, ShieldCheck } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { RallyDesktopBridge } from '../../common/desktop';
import { RallyMark, Button, InlineError } from '../components/primitives';
import { useAppSession } from '../lib/app-session';
import { isComposingKeyEvent } from '../lib/ime';
import { desktopBridge } from '../lib/platform';
import { reportTelemetryProductIntent, uuidV7 } from '../lib/telemetry';
import type { PendingWorkspaceInvitation, Region } from '../lib/types';

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

function RegionOptions({ selected, onChange }: {
  selected: Region;
  onChange: (region: Region) => void;
}): React.JSX.Element {
  return (
    <fieldset className="region-options">
      <legend className="sr-only">Workspace data region</legend>
      <label className="region-option">
        <input
          checked={selected === 'global'}
          name="region"
          onChange={() => onChange('global')}
          type="radio"
          value="global"
        />
        <span className="region-icon"><Globe2 aria-hidden="true" size={18} /></span>
        <span className="region-option-copy">
          <strong>Global</strong>
          <span>US-Jurisdiction storage</span>
        </span>
        {selected === 'global' && <Check aria-hidden="true" className="region-check" size={17} />}
      </label>
      <label className="region-option">
        <input
          checked={selected === 'eu'}
          name="region"
          onChange={() => onChange('eu')}
          type="radio"
          value="eu"
        />
        <span className="region-icon"><ShieldCheck aria-hidden="true" size={18} /></span>
        <span className="region-option-copy">
          <strong>European Union</strong>
          <span>EU-jurisdiction storage</span>
        </span>
        {selected === 'eu' && <Check aria-hidden="true" className="region-check" size={17} />}
      </label>
    </fieldset>
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
    // Identity entry is one Rally login surface. Workspace data residency is
    // selected only after account and invitation discovery.
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
    <main className="onboarding-shell window-drag">
      <section className="signin-card window-no-drag" aria-labelledby="signin-heading">
        <RallyMark className="signin-mark" />
        <h1 id="signin-heading">Welcome to Rally</h1>
        <p>Sign in first. Rally will then open your workspace, show invitations, or help you create an organization.</p>

        <Button className="button-primary signin-button" disabled={starting || exchangingTicket} onClick={beginGoogleLogin}>
          {starting || exchangingTicket ? <LoaderCircle aria-hidden="true" className="spin" size={16} /> : <ExternalLink aria-hidden="true" size={16} />}
          {exchangingTicket ? 'Completing sign in…' : 'Continue with Google'}
        </Button>

        {runtime?.devAuthEnabled && (
          <Button className="button-secondary signin-button" disabled={starting} onClick={useDevelopmentSession}>
            Use local development account
          </Button>
        )}

        {(error ?? deepLinkError) && <InlineError>{error ?? deepLinkError}</InlineError>}
        <p className="signin-help">Authentication opens temporarily in your system browser. Connector access is requested separately and only when needed.</p>
      </section>
    </main>
  );
}

export function RegionOnboarding(): React.JSX.Element {
  const { finishWorkspaceSetup, region, session, signOut, workspaceName } = useAppSession();
  const [selected, setSelected] = useState<Region>(region ?? 'global');
  const [name, setName] = useState(workspaceName);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const continueSetup = async (): Promise<void> => {
    // Holding Enter repeats it, and the button stays reachable while the first
    // create is in flight: without this each repeat mints a fresh operation id,
    // so the server answers the second one with a conflict on the reservation
    // the first one took, and the funnel counts a workspace_create_requested
    // per keystroke. The button's own `disabled` covers only the pointer.
    if (working) return;
    if (name.trim().length < 2) return;
    const operationId = uuidV7();
    reportTelemetryProductIntent({
      kind: 'onboarding_region_selected',
      selectedRegion: selected,
      entrypoint: 'first_run',
    });
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
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Rally could not create this organization.');
    } finally {
      setWorking(false);
    }
  };

  return (
    <main className="onboarding-shell window-drag">
      <section className="onboarding-card window-no-drag" aria-labelledby="region-heading">
        <div className="onboarding-brand">
          <RallyMark />
          <span>Rally</span>
        </div>
        <div className="onboarding-copy">
          <p className="eyebrow">No invitations found</p>
          <h1 id="region-heading">Create your organization</h1>
          <p>Name your shared workspace and choose where Rally should keep its data.</p>
          {session && <p className="signed-in-identity">Signed in as {session.user.email}</p>}
        </div>

        <label className="onboarding-field">
          <span>Organization name</span>
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

        <p className="region-question">Where should Rally keep your data?</p>
        <RegionOptions selected={selected} onChange={setSelected} />
        <p className="region-note">
          This choice controls only where workspace data is stored and cannot be changed later.
        </p>
        <div aria-live="polite" className="region-availability-note">
          {selected === 'eu' && (
            <>
              <p>Unavailable for EU region (at this time, subject to change based on providers)</p>
              <ul>
                <li>Rally agent: Terminal access</li>
              </ul>
            </>
          )}
        </div>
        {error && <InlineError>{error}</InlineError>}
        <Button className="button-primary onboarding-continue" disabled={working || name.trim().length < 2} onClick={() => void continueSetup()}>
          {working && <LoaderCircle aria-hidden="true" className="spin" size={16} />}
          Create organization
        </Button>
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
    <main className="onboarding-shell window-drag">
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
                <span>{invitation.region === 'eu' ? 'European Union' : 'Global'} data region</span>
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
