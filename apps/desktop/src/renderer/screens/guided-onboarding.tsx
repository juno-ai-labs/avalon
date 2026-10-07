import { ConversationAdmissionProvider } from '../lib/conversation-admission';
import { AccountProfileEditor } from '../lib/account-profile-editor';
import { settings } from '../settings/registry';
import { SettingLabel } from '../settings/setting-label';
import { MemberPresentationContext } from '../lib/member-presentation';
import { useOpenFirstWorkstream } from '../lib/workstream-landing';
import { createContext, useCallback, useContext, useEffect, useRef, useState, useMemo, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, X } from 'lucide-react';
import { PERSONAL_COLOR_KEYS, personalColorKey, type AccountOnboarding, type OnboardingJourney, type PersonalPresentation } from '@rally/contracts';
import { Button, InlineError, RallyMark } from '../components/primitives';
import { PersonalAvatar, personalColor, personalColorInk } from '../components/personal-avatar';
import { useAppSession } from '../lib/app-session';
import { useShellCapabilities } from '../lib/collaboration-session';
import { OnboardingIntroduction } from '../components/onboarding-introduction';
import type { Workspace } from '../lib/types';

const AccountLoadingContext = createContext(false);
const ProfileEditorContext = createContext<AccountProfileEditor | null>(null);
const AccountContext = createContext<AccountOnboarding | null>(null);
export function useOnboardingAccount(): AccountOnboarding | null { return useContext(AccountContext); }

export function AccountOnboardingGate({ children }: { children: ReactNode }): React.JSX.Element {
  const { api, session, signOut, updateCurrentUserName, getAccountOnboarding, updateAccountOnboarding } = useAppSession();
  const { guest, host } = useShellCapabilities();
  // The browser is reached from the landing page, which already introduced
  // Rally, so it records the introduction as seen rather than showing it again.
  const [previewed, setPreviewed] = useState(host === 'browser');
  // A guest has no member directory to read; their people come from each
  // conversation's own detail.
  const members = useQuery({ queryKey: ['workspace-members'], queryFn: () => api!.getWorkspaceMembers(), enabled: Boolean(api && session?.workspace && !guest) });
  const account = useQuery({ queryKey: ['account-onboarding', session?.user.email],
    queryFn: () => getAccountOnboarding(), enabled: Boolean(session), refetchOnWindowFocus: 'always' });
  const queryClient = useQueryClient();
  const editor = useMemo(() => new AccountProfileEditor('',
    (input) => updateAccountOnboarding(input),
    () => getAccountOnboarding(),
    (saved) => {
      queryClient.setQueryData(['account-onboarding', session?.user.email], saved);
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
  if (!session) return previewed ? <>{children}</> : <OnboardingIntroduction busy={false} error={null} onComplete={() => setPreviewed(true)} />;
  // A restored workspace can open while identity-owned details load. Keep the
  // providers in place so a background result does not remount its socket/feed.
  // Accounts without a workspace still finish their introduction before setup.
  if (!session.workspace && !account.data) {
    if (account.error) return <OnboardingPage title="Let's pick up where you left off" footer={<><Button onClick={() => void account.refetch()}>Retry</Button><Button onClick={() => void signOut()}>Sign out</Button></>}><InlineError>{account.error.message}</InlineError></OnboardingPage>;
    return <OnboardingPage title="Opening Rally"><RallyMark /></OnboardingPage>;
  }
  return <MemberPresentationContext.Provider value={presentations}><AccountContext.Provider value={account.data ?? null}><ProfileEditorContext.Provider value={account.data ? editor : null}><AccountLoadingContext.Provider value={account.isPending || account.isFetching}><ConversationAdmissionProvider allowed={guest || Boolean(account.data ? !account.data.eligible || account.data.introduced : account.error)}>{!guest && account.data?.eligible && !account.data.introduced ? <PlatformIntroduction previewed={previewed} /> : children}</ConversationAdmissionProvider></AccountLoadingContext.Provider></ProfileEditorContext.Provider></AccountContext.Provider></MemberPresentationContext.Provider>;
}

export function OnboardingPage({ title, subtitle, children, footer }: { title: string; subtitle?: string; children: ReactNode; footer?: ReactNode }): React.JSX.Element {
  return <main className="guided-onboarding window-drag">
    <section className="guided-page window-no-drag" aria-label={title}>
      <header><h1>{title}</h1>{subtitle && <p>{subtitle}</p>}</header>
      <div className="guided-content">{children}</div>
      {footer && <footer className="guided-footer">{footer}</footer>}
    </section>
  </main>;
}

function PlatformIntroduction({ previewed }: { previewed: boolean }): React.JSX.Element {
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
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Could not save your progress.'); }
    finally { setBusy(false); }
  }, [account.revision, busy, queryClient, updateAccountOnboarding]);
  const recorded = useRef(false);
  useEffect(() => {
    if (previewed && !recorded.current) { recorded.current = true; void complete(); }
  }, [previewed, complete]);
  const { host } = useShellCapabilities();
  if (previewed) return <OnboardingPage title={host === 'browser' ? 'Opening Rally' : 'Welcome to Rally'} footer={error ? <Button onClick={() => void complete()}>Retry</Button> : undefined}>{error ? <InlineError>{error}</InlineError> : <RallyMark />}</OnboardingPage>;
  return <OnboardingIntroduction signedIn onComplete={() => void complete()} busy={busy} error={error} />;
}

export function PersonalSetup({ onSaved, variant = 'onboarding', profileDetails }: { onSaved?: () => Promise<void>; variant?: 'onboarding' | 'settings'; profileDetails?: (name: string) => ReactNode }): React.JSX.Element {
  return variant === 'settings' ? <AccountProfileSettings profileDetails={profileDetails} /> : <OnboardingPersonalSetup onSaved={onSaved} />;
}

function OnboardingPersonalSetup({ onSaved }: { onSaved?: () => Promise<void> }): React.JSX.Element {
  const account = useOnboardingAccount();
  const { session, updateAccountOnboarding } = useAppSession();
  const queryClient = useQueryClient();
  const [color, setColor] = useState<PersonalPresentation['color']>(account?.presentation?.color ?? 'blue');
  const [name, setName] = useState(account?.presentation?.displayName ?? session?.user.name ?? '');
  const [initials, setInitials] = useState(account?.presentation?.initials ?? (session?.user.name ?? '').split(/\s+/u).map((part) => part[0]).join('').slice(0, 2).toUpperCase());
  const [draftRevision, setDraftRevision] = useState(account?.revision);
  useEffect(() => {
    if (!account || account.revision === draftRevision) return;
    setColor(account.presentation?.color ?? 'blue');
    setName(account.presentation?.displayName ?? session?.user.name ?? '');
    setInitials(account.presentation?.initials ?? '');
    setDraftRevision(account.revision);
  }, [account, draftRevision, session?.user.name]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    if (busy || !account || draftRevision !== account.revision) return;
    setBusy(true); setError(null);
    try {
      const updated = await updateAccountOnboarding({ expectedRevision: draftRevision, presentation: { color, avatar: 'circle', displayName: name.trim(), initials: initials.trim() } });
      queryClient.setQueryData(['account-onboarding', session?.user.email], updated);
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
    <label className="guided-email-field">Avatar initials<input data-saved-value={account?.presentation?.initials ?? (session?.user.name ?? '').split(/\s+/u).map((part) => part[0]).join('').slice(0, 2).toUpperCase()} value={initials} onChange={(event) => setInitials(event.target.value)} /></label>
    <div className="personal-shell-preview" style={{ '--personal-preview-color': personalColor(color) } as CSSProperties}><aside><PersonalAvatar color={color} initials={initials} /><span>{name} · You</span><i /><i /></aside><div><strong>Your next idea starts here</strong><span>One place for your team to get work done.</span><button type="button" tabIndex={-1}>New channel</button></div></div>
    {error && <InlineError>{error}</InlineError>}
    <Button className="button-primary" disabled={busy || !name.trim() || !initials.trim()} onClick={() => void save()}>{busy ? 'Saving…' : onSaved ? 'Continue with this look' : 'Save appearance'}</Button>
  </div>;
}

function AccountProfileSettings({ profileDetails }: { profileDetails?: (name: string) => ReactNode }): React.JSX.Element {
  const editor = useContext(ProfileEditorContext);
  const loading = useContext(AccountLoadingContext);
  if (!editor && loading) return <p role="status">Loading account profile…</p>;
  if (!editor) return <InlineError>Account profile is unavailable.</InlineError>;
  return <AccountProfileFields editor={editor} profileDetails={profileDetails} />;
}

function AccountProfileFields({ editor, profileDetails }: { editor: AccountProfileEditor; profileDetails?: (name: string) => ReactNode }): React.JSX.Element {
  const { profile, saving, error } = useSyncExternalStore(editor.subscribe, editor.getSnapshot);
  const account = useOnboardingAccount();
  const { session } = useAppSession();
  return <div className="settings-account-profile">
    <div className="settings-list-card">
      <div className="settings-profile-card">
        <PersonalAvatar color={profile.color} initials={profile.initials} className="settings-account-avatar" />
        {profileDetails?.(profile.displayName ?? '')}
      </div>
      <label className="settings-preference-row"><SettingLabel setting={settings.profileName} /><input autoComplete="name" value={profile.displayName ?? ''} data-saved-value={account?.presentation?.displayName ?? session?.user.name ?? ''} onChange={(event) => editor.update({ displayName: event.target.value })} /></label>
      <label className="settings-preference-row"><SettingLabel setting={settings.profileInitials} /><input value={profile.initials ?? ''} data-saved-value={account?.presentation?.initials ?? (session?.user.name ?? '').split(/\s+/u).map((part) => part[0]).join('').slice(0, 2).toUpperCase()} onChange={(event) => editor.update({ initials: event.target.value })} /></label>
      <div className="settings-preference-row"><SettingLabel setting={settings.profileColor} />
        <div className="personal-colors" role="group" aria-label={settings.profileColor.label}>{PERSONAL_COLOR_KEYS.map((value) => <button type="button" key={value} aria-label={value} aria-pressed={personalColorKey(profile.color) === value} style={{ background: personalColor(value), color: personalColorInk(value) }} onClick={() => editor.update({ color: value })}>{personalColorKey(profile.color) === value && <Check size={14} />}</button>)}</div>
      </div>
    </div>
    <div className="settings-account-actions" role="status">{error ? <><InlineError>{error}</InlineError><Button onClick={editor.retry}>Retry</Button></> : <small>{saving ? 'Saving…' : 'Changes save automatically'}</small>}</div>
  </div>;
}

export function WorkspaceOnboardingJourney({ workspace, children }: { workspace: Workspace | null; children: ReactNode }): React.JSX.Element {
  const account = useOnboardingAccount();
  const { api } = useAppSession();
  const { guest } = useShellCapabilities();
  // The journey sets up an Organization; a guest has none of theirs to set up.
  const eligible = Boolean(account?.eligible) && !guest;
  const queryClient = useQueryClient();
  const openFirstWorkstream = useOpenFirstWorkstream();
  const key = ['onboarding-journey', workspace?.region, workspace?.id, workspace?.currentUser.id];
  const journey = useQuery({ queryKey: key, queryFn: () => api!.getOnboardingJourney(), enabled: Boolean(api && workspace && eligible) });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [emails, setEmails] = useState<string[]>([]);
  const [emailDraft, setEmailDraft] = useState('');
  const [sent, setSent] = useState<string[]>([]);
  const advance = async (stage: OnboardingJourney['stage']) => {
    if (!journey.data) return;
    const updated = await api!.updateOnboardingJourney({ expectedRevision: journey.data.revision, stage });
    queryClient.setQueryData(key, updated);
  };
  const perform = async (action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true); setError(null);
    try { await action(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'Something went wrong. Try again.'); await journey.refetch(); }
    finally { setBusy(false); }
  };
  const content = (allowed: boolean): React.JSX.Element => <ConversationAdmissionProvider allowed={allowed}>{children}</ConversationAdmissionProvider>;
  if (!workspace) return content(false);
  if (!eligible) return content(true);
  if (journey.error && !journey.data) return <OnboardingPage title="Resume your setup" footer={<Button onClick={() => void journey.refetch()}>Retry</Button>}><InlineError>{journey.error.message}</InlineError></OnboardingPage>;
  const state = journey.data;
  // A workspace session can render while setup progress loads; only a known
  // unfinished journey interrupts it. Completed users never flash a second gate.
  if (!state) return content(false);
  if (state.stage === 'complete') return content(true);
  const finishOnboarding = async (): Promise<void> => {
    await advance('complete');
    // A creator's workspace is empty and lands on the composer anyway; a
    // member joining one that already has work streams enters the first.
    // Through the hook, so the finished journey is replaced rather than left
    // behind for Back.
    openFirstWorkstream();
  };
  if (state.stage === 'profile') return <OnboardingPage title="This is you in Rally" subtitle="Your team will see your avatar and color. They follow you across devices."><PersonalSetup onSaved={() => state.path === 'creator' ? advance('people') : finishOnboarding()} /></OnboardingPage>;
  const inviteAddresses = [...new Set([...emails, ...emailDraft.split(/[\s,;]+/u)].map((email) => email.trim().toLowerCase()).filter(Boolean))];
  const invalidEmails = inviteAddresses.some((email) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email));
  const addEmails = (value: string, commitLast: boolean): void => {
    const parts = value.split(/[\s,;]+/u);
    const remaining = commitLast ? '' : parts.pop() ?? '';
    setEmails((previous) => [...new Set([...previous, ...parts.map((email) => email.trim().toLowerCase()).filter(Boolean)])]);
    setEmailDraft(remaining);
  };
  if (state.stage === 'people') return <OnboardingPage title="Invite your teammates" subtitle="Add email addresses to invite people to your organization." footer={<>
    <Button className="button-primary" disabled={busy || !inviteAddresses.length || invalidEmails} onClick={() => void perform(async () => {
      const addresses = inviteAddresses.filter((email) => !sent.includes(email));
      setEmailDraft('');
      setEmails(addresses);
      const pendingInvitations = await api!.getWorkspaceInvitations();
      const currentMembers = await api!.getWorkspaceMembers();
      const alreadyInvited = new Set([...pendingInvitations.filter((invite) => invite.status === 'pending').map((invite) => invite.email.toLowerCase()), ...currentMembers.filter((member) => member.status === 'active').map((member) => member.email.toLowerCase())]);
      const failures: string[] = [];
      for (const email of addresses) {
        try { if (!alreadyInvited.has(email)) await api!.createWorkspaceInvitation(email, 'member'); setSent((values) => [...values, email]); }
        catch { failures.push(email); }
      }
      setEmails(failures);
      if (failures.length) throw new Error(`Could not invite: ${failures.join(', ')}. Check the addresses and retry.`);
      await finishOnboarding();
    })}>{busy ? 'Inviting…' : inviteAddresses.length ? `Invite ${inviteAddresses.length} ${inviteAddresses.length === 1 ? 'teammate' : 'teammates'}` : 'Invite teammates'}</Button>
    <Button disabled={busy} onClick={() => void perform(finishOnboarding)}>{sent.length ? 'Continue' : 'Invite later'}</Button>
  </>}>
    <div className="invite-email-field">
      <label htmlFor="invite-email-input">Email addresses</label>
      <div className="invite-email-chips">
        {emails.map((email) => <span className="invite-email-chip" key={email}>
          <span>{email}</span><button type="button" disabled={busy} aria-label={`Remove ${email}`} onClick={() => setEmails((values) => values.filter((value) => value !== email))}><X size={14} /></button>
        </span>)}
        <input id="invite-email-input" aria-describedby="invite-email-hint" disabled={busy} autoComplete="off" autoCapitalize="none" spellCheck={false} value={emailDraft} placeholder="teammate@company.com"
          onChange={(event) => { if ('isComposing' in event.nativeEvent && event.nativeEvent.isComposing) setEmailDraft(event.target.value); else addEmails(event.target.value, false); }}
          onBlur={() => addEmails(emailDraft, true)}
          onPaste={(event) => { event.preventDefault(); const input = event.currentTarget; const value = emailDraft.slice(0, input.selectionStart ?? emailDraft.length) + event.clipboardData.getData('text') + emailDraft.slice(input.selectionEnd ?? emailDraft.length); addEmails(value, true); }}
          onKeyDown={(event) => { if (event.nativeEvent.isComposing) return; if (event.key === 'Enter') { event.preventDefault(); addEmails(emailDraft, true); } }} />
      </div>
      <p id="invite-email-hint">Separate emails with a space, comma, or semicolon.</p>
      {invalidEmails && <p className="inline-error">Enter a complete email address for each teammate.</p>}
      <p>Everyone invited joins as a Member and can use organization connections. Your private streams stay private.</p>
    </div>
    {sent.length > 0 && <p role="status">Invited: {sent.join(', ')}</p>}{error && <InlineError>{error}</InlineError>}
  </OnboardingPage>;
  return <>{children}</>;
}
