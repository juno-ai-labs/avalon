import { ConversationAdmissionProvider } from '../lib/conversation-admission';
import { AccountProfileEditor, nameInitials } from '../lib/account-profile-editor';
import { settings } from '../settings/registry';
import { SettingLabel } from '../settings/setting-label';
import { MemberPresentationContext } from '../lib/member-presentation';
import { useOpenLanding } from '../lib/landing';
import { createContext, useCallback, useContext, useEffect, useRef, useState, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check } from 'lucide-react';
import { useLocation } from 'react-router-dom';
import { PERSONAL_COLOR_KEYS, personalColorKey, type AccountOnboarding, type ConnectorConnectionCardInput, type OnboardingJourney, type PersonalPresentation } from '@rally/contracts';
import { Button, ErrorNotice, RallyMark } from '../components/primitives';
import { PersonalAvatar, personalColor, personalColorInk } from '../components/personal-avatar';
import { useAppSession } from '../lib/app-session';
import { accountOnboardingQueryKey } from '../lib/account-onboarding-query';
import { useShellCapabilities } from '../lib/collaboration-session';
import { connectorScopeStates } from '../lib/connector-presentation';
import { ConnectorConnectionCard, ConnectorConnectionsProvider } from '../components/connector-mentions';
import { useWorkspaceMembers } from '../lib/workspace-members';
import type { Workspace } from '../lib/types';
import { InviteEmailField, failuresNotice, inviteEmailsProblem, inviteMembers, unemailedNotice, useInviteEmails } from '../components/invite-emails';

const AccountLoadingContext = createContext(false);
const ProfileEditorContext = createContext<AccountProfileEditor | null>(null);
const AccountContext = createContext<AccountOnboarding | null>(null);
export function useOnboardingAccount(): AccountOnboarding | null { return useContext(AccountContext); }

export function AccountOnboardingGate({ children, onRecoveryReady }: { children: ReactNode; onRecoveryReady?: () => void }): React.JSX.Element {
  const { api, session, signOut, updateCurrentUserName, getAccountOnboarding, updateAccountOnboarding } = useAppSession();
  const { guest } = useShellCapabilities();
  // Account onboarding and the profile it carries belong to the signed-in
  // account. On a support session that is the Rally staff member, not the
  // person on screen, so none of it is read, shown or written there
  // (`docs/impersonation.md`).
  const supportSession = Boolean(session?.impersonator);
  const members = useWorkspaceMembers(api, { enabled: Boolean(session?.workspace) });
  const account = useQuery({ queryKey: accountOnboardingQueryKey(session?.user.email),
    queryFn: () => getAccountOnboarding(), enabled: Boolean(session) && !supportSession, refetchOnWindowFocus: 'always' });
  const queryClient = useQueryClient();
  const editor = useMemo(() => new AccountProfileEditor('',
    (input) => updateAccountOnboarding(input),
    () => getAccountOnboarding(),
    (saved) => {
      queryClient.setQueryData(accountOnboardingQueryKey(session?.user.email), saved);
      void queryClient.invalidateQueries({ queryKey: ['workspace-members'] });
      void queryClient.invalidateQueries({ queryKey: ['workspace'] });
    }), [getAccountOnboarding, queryClient, session?.user.email, updateAccountOnboarding]);
  // Pane navigation keeps this gate mounted; sign-out retires the old writer
  // before queued writes could use a different account's desktop credential.
  useEffect(() => { editor.start(); return () => editor.stop(); }, [editor]);
  useEffect(() => { if (account.data) editor.refresh(account.data, session?.user.name); }, [account.data, editor, session?.user.name]);
  const profileState = useSyncExternalStore(editor.subscribe, editor.getSnapshot);
  const profile = profileState.profile;
  const hasPresentation = Boolean(account.data?.presentation || profileState.saving || profileState.error);
  const presentations = useMemo(() => {
    const result = new Map((members.data ?? []).flatMap((member) => member.presentation ? [[member.id, member.presentation] as const] : []));
    if (session?.user.id && hasPresentation) result.set(session.user.id, { ...profile, revision: account.data?.revision ?? 0 });
    return result;
  }, [members.data, session?.user.id, hasPresentation, profile, account.data?.revision]);
  useEffect(() => {
    const root = document.documentElement;
    if (session && (account.data?.presentation || profileState.saving || profileState.error)) root.dataset['personalColor'] = profileState.profile.color;
    else delete root.dataset['personalColor'];
    if (profileState.profile.displayName?.trim()) updateCurrentUserName?.(profileState.profile.displayName.trim());
    return () => { delete root.dataset['personalColor']; };
  }, [account.data?.presentation, profileState, session, updateCurrentUserName]);
  useEffect(() => { if (!session?.workspace && !account.data && account.error) onRecoveryReady?.(); }, [session?.workspace, account.data, account.error, onRecoveryReady]);
  if (!session) return <>{children}</>;
  // A restored workspace can open while identity-owned details load. Keep the
  // providers in place so a background result does not remount its socket/feed.
  // Accounts without a workspace still record their introduction before setup.
  if (!session.workspace && !account.data) {
    if (account.error) return <OnboardingPage title="Let's pick up where you left off" footer={<><Button onClick={() => void account.refetch()}>Retry</Button><Button onClick={() => void signOut()}>Sign out</Button></>}><ErrorNotice occurrence={account.error}>{account.error.message}</ErrorNotice></OnboardingPage>;
    return <OnboardingPage title="Opening Rally"><RallyMark /></OnboardingPage>;
  }
  return <MemberPresentationContext.Provider value={presentations}><AccountContext.Provider value={account.data ?? null}><ProfileEditorContext.Provider value={account.data ? editor : null}><AccountLoadingContext.Provider value={!supportSession && (account.isPending || account.isFetching)}><ConversationAdmissionProvider allowed={guest || supportSession || Boolean(account.data ? !account.data.eligible || account.data.introduced : account.error)}>{!guest && account.data?.eligible && !account.data.introduced ? <RecordIntroduction onRecoveryReady={onRecoveryReady} /> : children}</ConversationAdmissionProvider></AccountLoadingContext.Provider></ProfileEditorContext.Provider></AccountContext.Provider></MemberPresentationContext.Provider>;
}

export function OnboardingPage({ title, subtitle, children, footer }: { title: string; subtitle?: string | readonly string[]; children: ReactNode; footer?: ReactNode }): React.JSX.Element {
  return <main className="guided-onboarding window-drag">
    <section className="guided-page window-no-drag" aria-label={title}>
      <header><h1>{title}</h1>{(typeof subtitle === 'string' ? [subtitle] : subtitle ?? []).map((paragraph) => <p key={paragraph}>{paragraph}</p>)}</header>
      <div className="guided-content">{children}</div>
      {footer && <footer className="guided-footer">{footer}</footer>}
    </section>
  </main>;
}

// Rally no longer shows introduction screens, but signup completion still
// waits on `introduced`, so a new account records it on arrival.
function RecordIntroduction({ onRecoveryReady }: { onRecoveryReady?: (() => void) | undefined }): React.JSX.Element {
  const account = useOnboardingAccount()!;
  const { updateAccountOnboarding } = useAppSession();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const complete = useCallback(async () => {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      const saved = await updateAccountOnboarding({ expectedRevision: account.revision, introduced: true });
      queryClient.setQueriesData({ queryKey: ['account-onboarding'] }, saved);
      await queryClient.invalidateQueries({ queryKey: ['account-onboarding'] });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save your progress.');
      // A revision conflict means another session saved first; Retry needs its revision.
      await queryClient.invalidateQueries({ queryKey: ['account-onboarding'] });
    } finally { setBusy(false); }
  }, [account.revision, busy, queryClient, updateAccountOnboarding]);
  useEffect(() => { if (error) onRecoveryReady?.(); }, [error, onRecoveryReady]);
  const recorded = useRef(false);
  useEffect(() => {
    if (!recorded.current) { recorded.current = true; void complete(); }
  }, [complete]);
  return <OnboardingPage title="Opening Rally" footer={error ? <Button onClick={() => void complete()}>Retry</Button> : undefined}>{error ? <ErrorNotice>{error}</ErrorNotice> : <RallyMark />}</OnboardingPage>;
}

export function PersonalSetup({ onSaved, variant = 'onboarding', profileDetails }: { onSaved?: () => Promise<void>; variant?: 'onboarding' | 'settings'; profileDetails?: (name: string) => ReactNode }): React.JSX.Element {
  return variant === 'settings' ? <AccountProfileSettings profileDetails={profileDetails} /> : <OnboardingPersonalSetup onSaved={onSaved} />;
}

function OnboardingPersonalSetup({ onSaved }: { onSaved?: () => Promise<void> }): React.JSX.Element {
  const account = useOnboardingAccount();
  const { session, updateAccountOnboarding } = useAppSession();
  const queryClient = useQueryClient();
  // An account with no saved look starts on a random color.
  const [color, setColor] = useState<PersonalPresentation['color']>(() => account?.presentation?.color ?? PERSONAL_COLOR_KEYS[Math.floor(Math.random() * PERSONAL_COLOR_KEYS.length)]!);
  const [name, setName] = useState(account?.presentation?.displayName ?? session?.user.name ?? '');
  const [initials, setInitials] = useState(account?.presentation?.initials ?? nameInitials(session?.user.name ?? ''));
  const [draftRevision, setDraftRevision] = useState(account?.revision);
  useEffect(() => {
    if (!account || account.revision === draftRevision) return;
    setColor((current) => account.presentation?.color ?? current);
    setName(account.presentation?.displayName ?? session?.user.name ?? '');
    setInitials(account.presentation?.initials ?? nameInitials(session?.user.name ?? ''));
    setDraftRevision(account.revision);
  }, [account, draftRevision, session?.user.name]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    if (busy || !account || draftRevision !== account.revision) return;
    setBusy(true); setError(null);
    try {
      const updated = await updateAccountOnboarding({ expectedRevision: draftRevision, presentation: { color, avatar: 'circle', displayName: name.trim(), initials: initials.trim() } });
      queryClient.setQueryData(accountOnboardingQueryKey(session?.user.email), updated);
      await queryClient.invalidateQueries({ queryKey: ['workspace-members'] });
      await onSaved?.();
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Could not save your profile.'); await queryClient.invalidateQueries({ queryKey: ['account-onboarding'] }); }
    finally { setBusy(false); }
  };
  const colorPicker = <div className="personal-colors" role="group" aria-label="Your color">{PERSONAL_COLOR_KEYS.map((value) => <button type="button" key={value} aria-label={value} aria-pressed={personalColorKey(color) === value} style={{ background: personalColor(value), color: personalColorInk(value) }} onClick={() => setColor(value)}>{personalColorKey(color) === value && <Check size={18} />}</button>)}</div>;
  return <div className="personal-setup">
    <PersonalAvatar color={color} initials={initials} className="personal-setup-preview" />
    {colorPicker}
    <label className="guided-email-field">Name<input data-saved-value={account?.presentation?.displayName ?? session?.user.name ?? ''} value={name} onChange={(event) => setName(event.target.value)} autoComplete="name" /></label>
    <label className="guided-email-field">Avatar initials<input data-saved-value={account?.presentation?.initials ?? nameInitials(session?.user.name ?? '')} value={initials} onChange={(event) => setInitials(event.target.value)} /></label>
    {error && <ErrorNotice>{error}</ErrorNotice>}
    <Button className="button-primary" disabled={busy || !name.trim() || !initials.trim()} onClick={() => void save()}>{busy ? 'Saving…' : onSaved ? 'Continue with this look' : 'Save appearance'}</Button>
  </div>;
}

function AccountProfileSettings({ profileDetails }: { profileDetails?: (name: string) => ReactNode }): React.JSX.Element {
  const editor = useContext(ProfileEditorContext);
  const loading = useContext(AccountLoadingContext);
  const { session } = useAppSession();
  // The account profile is the signed-in account's: on a support session, the
  // Rally staff member's, which is not the person shown here.
  if (session?.impersonator) return <p className="settings-support-note">{session.impersonator.name} is signed in as {session.user.name}. Their profile is theirs to change.</p>;
  if (!editor && loading) return <p role="status">Loading account profile…</p>;
  if (!editor) return <ErrorNotice>Account profile is unavailable.</ErrorNotice>;
  return <AccountProfileFields editor={editor} profileDetails={profileDetails} />;
}

function AccountProfileFields({ editor, profileDetails }: { editor: AccountProfileEditor; profileDetails?: (name: string) => ReactNode }): React.JSX.Element {
  const { profile, error } = useSyncExternalStore(editor.subscribe, editor.getSnapshot);
  const account = useOnboardingAccount();
  const { session } = useAppSession();
  return <div className="settings-account-profile">
    <div className="settings-list-card">
      <div className="settings-profile-card">
        <PersonalAvatar color={profile.color} initials={profile.initials} className="settings-account-avatar" />
        {profileDetails?.(profile.displayName ?? '')}
      </div>
      <label className="settings-preference-row"><SettingLabel setting={settings.profileName} /><input autoComplete="name" value={profile.displayName ?? ''} data-saved-value={account?.presentation?.displayName ?? session?.user.name ?? ''} onChange={(event) => editor.update({ displayName: event.target.value })} /></label>
      <label className="settings-preference-row"><SettingLabel setting={settings.profileInitials} /><input value={profile.initials ?? ''} data-saved-value={account?.presentation?.initials ?? nameInitials(session?.user.name ?? '')} onChange={(event) => editor.update({ initials: event.target.value })} /></label>
      <div className="settings-preference-row"><SettingLabel setting={settings.profileColor} />
        <div className="personal-colors" role="group" aria-label={settings.profileColor.label}>{PERSONAL_COLOR_KEYS.map((value) => <button type="button" key={value} aria-label={value} aria-pressed={personalColorKey(profile.color) === value} style={{ background: personalColor(value), color: personalColorInk(value) }} onClick={() => editor.update({ color: value })}>{personalColorKey(profile.color) === value && <Check size={14} />}</button>)}</div>
      </div>
    </div>
    {error && <div className="settings-account-actions" role="status"><ErrorNotice>{error}</ErrorNotice><Button onClick={editor.retry}>Retry</Button></div>}
  </div>;
}

/**
 * Routes finishing the journey keeps: one Canvas or Sidekick by its id, or a
 * template link's route, which starts its Canvas once it mounts, so a journey
 * that covered it before it could run still leads there. Not `/sidekicks/new`,
 * which creates a Sidekick as it mounts (`restorableRoute` makes the same cut).
 */
const KEPT_ROUTE = /^\/(?:(?:canvases|sidekicks)\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|marketplace\/[a-z0-9-]+)$/iu;

export function WorkspaceOnboardingJourney({ workspace, children }: { workspace: Workspace | null; children: ReactNode }): React.JSX.Element {
  const account = useOnboardingAccount();
  const { api } = useAppSession();
  const { guest } = useShellCapabilities();
  // The journey sets up an Organization; a guest has none of theirs to set up.
  const eligible = Boolean(account?.eligible) && !guest;
  const queryClient = useQueryClient();
  const openLanding = useOpenLanding();
  const location = useLocation();
  const key = ['onboarding-journey', workspace?.region, workspace?.id, workspace?.currentUser.id];
  const journey = useQuery({ queryKey: key, queryFn: () => api!.getOnboardingJourney(), enabled: Boolean(api && workspace && eligible) });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const invite = useInviteEmails();
  const [sent, setSent] = useState<string[]>([]);
  const [unemailed, setUnemailed] = useState<string | null>(null);
  const advance = async (stage: OnboardingJourney['stage']) => {
    if (!journey.data) return;
    const updated = await api!.updateOnboardingJourney({ expectedRevision: journey.data.revision, stage });
    queryClient.setQueryData(key, updated);
  };
  const perform = async (action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true); setError(null);
    try { await action(); }
    catch (caught) { setError(caught instanceof Error ? caught : new Error('Something went wrong. Try again.')); await journey.refetch(); }
    finally { setBusy(false); }
  };
  const content = (allowed: boolean): React.JSX.Element => <ConversationAdmissionProvider allowed={allowed}>{children}</ConversationAdmissionProvider>;
  if (!workspace) return content(false);
  if (!eligible) return content(true);
  if (journey.error && !journey.data) return <OnboardingPage title="Resume your setup" footer={<Button onClick={() => void journey.refetch()}>Retry</Button>}><ErrorNotice occurrence={journey.error}>{journey.error.message}</ErrorNotice></OnboardingPage>;
  const state = journey.data;
  // A workspace session can render while setup progress loads; only a known
  // unfinished journey interrupts it. Completed users never flash a second gate.
  if (!state) return content(false);
  if (state.stage === 'complete') return content(true);
  const finishOnboarding = async (): Promise<void> => {
    await advance('complete');
    // A Canvas or Sidekick the person was already opening when the journey
    // covered it (a shared link, or a template that started or will start a
    // Canvas) is where they were going, so they stay there. Anyone else lands
    // on the Canvases home, whose empty state offers "Start from a prompt".
    // Through the hook, so the finished journey is replaced rather than left
    // behind for Back.
    if (!KEPT_ROUTE.test(location.pathname)) openLanding();
  };
  const afterConnectors = (): Promise<void> => state.path === 'creator' ? advance('people') : finishOnboarding();
  if (state.stage === 'profile') return <OnboardingPage title="This is you in Rally"><PersonalSetup onSaved={() => advance('connectors')} /></OnboardingPage>;
  if (state.stage === 'connectors') return <ConnectGoogleStep busy={busy} error={error} onContinue={() => void perform(afterConnectors)} />;
  const inviteAddresses = invite.addresses;
  if (state.stage === 'people') return <OnboardingPage title="Add your teammates" subtitle={["Rally is designed to be multi-human. Rally lets teammates work with AI in shared (cooperative) chat, so without your teammates it won't be as fun.", "They're members right away, so you can start working with them before they first sign in."]} footer={<>
    <Button className="button-primary" disabled={busy} onClick={() => {
      const problem = inviteEmailsProblem(invite);
      if (problem) {
        setError(new Error(problem));
        return;
      }
      void perform(async () => {
        const addresses = inviteAddresses.filter((email) => !sent.includes(email));
        invite.replace(addresses);
        const { failures, unemailed } = await inviteMembers(api!, addresses, (email) => setSent((values) => [...values, email]));
        invite.replace(failures.map((failure) => failure.email));
        // Continue moves on once they have read it: they are members, only untold.
        setUnemailed(unemailed.length ? unemailedNotice(unemailed) : null);
        if (failures.length) throw new Error(failuresNotice(failures));
        if (!unemailed.length) await finishOnboarding();
      });
    }}>{busy ? 'Adding…' : inviteAddresses.length ? `Add ${inviteAddresses.length} ${inviteAddresses.length === 1 ? 'teammate' : 'teammates'}` : 'Add teammates'}</Button>
    <Button disabled={busy} onClick={() => void perform(finishOnboarding)}>{sent.length ? 'Continue' : 'Add later'}</Button>
  </>}>
    <InviteEmailField invite={invite} disabled={busy} />
    {sent.length > 0 && <p role="status">Added: {sent.join(', ')}</p>}
    {unemailed && <p className="invite-unemailed-notice" role="status">{unemailed}</p>}{error && <ErrorNotice occurrence={error}>{error.message}</ErrorNotice>}
  </OnboardingPage>;
  return <>{children}</>;
}

/** The personal Google connections the connectors step offers, in the order shown. */
const GOOGLE_CONNECTIONS: readonly ConnectorConnectionCardInput[] = [
  { connectorId: 'google-mail-calendar', scope: 'personal' },
  { connectorId: 'google-drive', scope: 'personal' },
];

/**
 * Connecting Gmail and Google Drive, after personal setup. The cards are the
 * ones a conversation shows, so connecting, reconnecting and the OAuth return
 * behave the same here; the workspace socket refreshes `['connections']` when
 * an authorization lands. The step can always be skipped.
 */
function ConnectGoogleStep({ busy, error, onContinue }: { busy: boolean; error: Error | null; onContinue: () => void }): React.JSX.Element {
  const { api } = useAppSession();
  const connections = useQuery({ queryKey: ['connections'], queryFn: ({ signal }) => api!.getConnections(signal), enabled: Boolean(api) });
  const connected = GOOGLE_CONNECTIONS.some((request) =>
    connectorScopeStates('google', connections.data ?? [], request.connectorId)[0].status === 'healthy');
  return <OnboardingPage title="Connect Gmail and Google Drive" subtitle="Let Rally work with your mail, calendar and files. You can change this later in Settings → Connections." footer={
    <Button className={connected ? 'button-primary' : undefined} disabled={busy} onClick={onContinue}>{connected ? 'Continue' : 'Skip for now'}</Button>
  }>
    <ConnectorConnectionsProvider connections={connections.data}>
      <div className="guided-connections">{GOOGLE_CONNECTIONS.map((request) => <ConnectorConnectionCard key={request.connectorId} request={request} />)}</div>
    </ConnectorConnectionsProvider>
    {error && <ErrorNotice occurrence={error}>{error.message}</ErrorNotice>}
  </OnboardingPage>;
}
