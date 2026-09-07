import { MemberPresentationContext } from '../lib/member-presentation';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Search, X } from 'lucide-react';
import { PersonalColorSchema, OnboardingJourneySchema, type AccountOnboarding, type OnboardingJourney, type PersonalPresentation } from '@rally/contracts';
import { Button, ConnectorMark, InlineError, RallyMark } from '../components/primitives';
import { PersonalAvatar, personalColor } from '../components/personal-avatar';
import { useAppSession } from '../lib/app-session';
import { desktopBridge } from '../lib/platform';
import { OnboardingIntroduction } from '../components/onboarding-introduction';
import type { Workspace } from '../lib/types';
import { connectorProviders } from '../lib/connector-catalog';

const AccountContext = createContext<AccountOnboarding | null>(null);
export function useOnboardingAccount(): AccountOnboarding | null { return useContext(AccountContext); }

export function AccountOnboardingGate({ children }: { children: ReactNode }): React.JSX.Element {
  const { api, session, signOut, updateCurrentUserName } = useAppSession();
  const [previewed, setPreviewed] = useState(false);
  const members = useQuery({ queryKey: ['workspace-members'], queryFn: () => api!.getWorkspaceMembers(), enabled: Boolean(api && session?.workspace) });
  const account = useQuery({ queryKey: ['account-onboarding', session?.user.email],
    queryFn: () => desktopBridge().getAccountOnboarding(), enabled: Boolean(session), refetchOnWindowFocus: 'always' });
  useEffect(() => {
    const root = document.documentElement;
    if (account.data?.presentation && session) root.dataset['personalColor'] = account.data.presentation.color;
    else delete root.dataset['personalColor'];
    if (account.data?.presentation?.displayName) updateCurrentUserName?.(account.data.presentation.displayName);
    return () => { delete root.dataset['personalColor']; };
  }, [account.data?.presentation, session, updateCurrentUserName]);
  if (!session) return previewed ? <>{children}</> : <OnboardingIntroduction busy={false} error={null} onComplete={() => setPreviewed(true)} />;
  if (account.error && !account.data && session.workspace) return <>{children}</>;
  if (account.error && !account.data) return <OnboardingPage title="Let's pick up where you left off" footer={<><Button onClick={() => void account.refetch()}>Retry</Button><Button onClick={() => void signOut()}>Sign out</Button></>}><InlineError>{account.error.message}</InlineError></OnboardingPage>;
  if (!account.data) return <OnboardingPage title="Opening Rally"><RallyMark /></OnboardingPage>;
  const presentations = new Map((members.data ?? []).flatMap((member) => member.presentation ? [[member.id, member.presentation] as const] : []));
  if (account.data.presentation) presentations.set(session.user.id, account.data.presentation);
  return <MemberPresentationContext.Provider value={presentations}><AccountContext.Provider value={account.data}>{account.data.eligible && !account.data.introduced ? <PlatformIntroduction previewed={previewed} /> : children}</AccountContext.Provider></MemberPresentationContext.Provider>;
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
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const complete = useCallback(async () => {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      const saved = await desktopBridge().updateAccountOnboarding({ expectedRevision: account.revision, introduced: true });
      queryClient.setQueriesData({ queryKey: ['account-onboarding'] }, saved);
      await queryClient.invalidateQueries({ queryKey: ['account-onboarding'] });
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Could not save your progress.'); }
    finally { setBusy(false); }
  }, [account.revision, busy, queryClient]);
  const recorded = useRef(false);
  useEffect(() => {
    if (previewed && !recorded.current) { recorded.current = true; void complete(); }
  }, [previewed, complete]);
  if (previewed) return <OnboardingPage title="Welcome to Rally" footer={error ? <Button onClick={() => void complete()}>Retry</Button> : undefined}>{error ? <InlineError>{error}</InlineError> : <RallyMark />}</OnboardingPage>;
  return <OnboardingIntroduction signedIn onComplete={() => void complete()} busy={busy} error={error} />;
}

export function PersonalSetup({ onSaved }: { onSaved?: () => Promise<void> }): React.JSX.Element {
  const account = useOnboardingAccount();
  const { session } = useAppSession();
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
      const updated = await desktopBridge().updateAccountOnboarding({ expectedRevision: draftRevision, presentation: { color, avatar: 'circle', displayName: name.trim(), initials: initials.trim() } });
      queryClient.setQueryData(['account-onboarding', session?.user.email], updated);
      await queryClient.invalidateQueries({ queryKey: ['workspace-members'] });
      await onSaved?.();
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Could not save your profile.'); await queryClient.invalidateQueries({ queryKey: ['account-onboarding'] }); }
    finally { setBusy(false); }
  };
  return <div className="personal-setup">
    <PersonalAvatar color={color} initials={initials} className="personal-setup-preview" />
    <div className="personal-colors" role="group" aria-label="Your color">{PersonalColorSchema.options.map((value) => <button type="button" key={value} aria-label={value === 'orange' ? 'Neon yellow' : value} aria-pressed={color === value} style={{ background: personalColor(value), color: ['amber', 'orange', 'green', 'teal'].includes(value) ? 'var(--personal-ink-dark)' : 'var(--personal-ink-light)' }} onClick={() => setColor(value)}>{color === value && <Check size={18} />}</button>)}</div>
    <label className="guided-email-field">Name<input data-saved-value={account?.presentation?.displayName ?? session?.user.name ?? ''} value={name} onChange={(event) => setName(event.target.value)} autoComplete="name" /></label>
    <label className="guided-email-field">Avatar initials<input data-saved-value={account?.presentation?.initials ?? (session?.user.name ?? '').split(/\s+/u).map((part) => part[0]).join('').slice(0, 2).toUpperCase()} value={initials} onChange={(event) => setInitials(event.target.value)} /></label>
    <div className="personal-shell-preview" style={{ '--personal-preview-color': personalColor(color) } as CSSProperties}><aside><PersonalAvatar color={color} initials={initials} /><span>{name} · You</span><i /><i /></aside><div><strong>Your next idea starts here</strong><span>One place for your team to get work done.</span><button type="button" tabIndex={-1}>New work stream</button></div></div>
    {error && <InlineError>{error}</InlineError>}
    <Button className="button-primary" disabled={busy || !name.trim() || !initials.trim()} onClick={() => void save()}>{busy ? 'Saving…' : onSaved ? 'Continue with this look' : 'Save appearance'}</Button>
  </div>;
}

export function WorkspaceOnboardingJourney({ workspace, children }: { workspace: Workspace; children: ReactNode }): React.JSX.Element {
  const account = useOnboardingAccount();
  const { api, setPendingConnectorOAuth } = useAppSession();
  const queryClient = useQueryClient();
  const key = ['onboarding-journey', workspace.region, workspace.id, workspace.currentUser.id];
  const journey = useQuery({ queryKey: key, queryFn: () => api!.getOnboardingJourney(), enabled: Boolean(api && account?.eligible) });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [configuring, setConfiguring] = useState(false);
  const [connectorScope, setConnectorScope] = useState<'workspace' | 'you'>('workspace');
  const hydratedSelections = useRef<string | null>(null);
  useEffect(() => {
    if (!journey.data || hydratedSelections.current === workspace.id) return;
    hydratedSelections.current = workspace.id;
    setSelected(journey.data.connectorIds);
    if (journey.data.connectorIds.some((id) => id.startsWith('you:'))) setConnectorScope('you');
  }, [journey.data, workspace.id]);
  const [emails, setEmails] = useState<string[]>([]);
  const [emailDraft, setEmailDraft] = useState('');
  const [sent, setSent] = useState<string[]>([]);
  const connectors = useQuery({ queryKey: ['connector-catalog'], queryFn: () => api!.getAvailableConnectorTypes(), enabled: Boolean(api && journey.data?.stage === 'connectors') });
  const connections = useQuery({ queryKey: ['connections'], queryFn: () => api!.getConnections(), enabled: Boolean(api && ['connectors', 'people', 'example'].includes(journey.data?.stage ?? '')), refetchOnWindowFocus: 'always' });
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
  if (!account?.eligible) return <>{children}</>;
  if (journey.error && !journey.data) return <OnboardingPage title="Resume your setup" footer={<Button onClick={() => void journey.refetch()}>Retry</Button>}><InlineError>{journey.error.message}</InlineError></OnboardingPage>;
  const state = journey.data;
  if (!state) return <OnboardingPage title="Opening your workspace"><RallyMark /></OnboardingPage>;
  if (state.stage === 'complete') return <>{children}</>;
  const finishOnboarding = async (): Promise<void> => {
    await advance('complete');
    window.location.hash = '/workstreams/new';
  };
  if (state.stage === 'profile') return <OnboardingPage title="This is you in Rally" subtitle="Your team will see your avatar and color. They follow you across devices."><PersonalSetup onSaved={() => state.path === 'creator' ? advance('people') : finishOnboarding()} /></OnboardingPage>;
  const changeConnectorPage = (scope: 'workspace' | 'you'): void => {
    setConnectorScope(scope);
    setConfiguring(false);
    setSearch('');
    setError(null);
  };
  const nextConnectorPage = (): void => {
    if (connectorScope === 'workspace') changeConnectorPage('you');
    else void perform(() => advance('profile'));
  };
  if (state.stage === 'connectors') return <OnboardingPage
    title={connectorScope === 'workspace' ? 'Connect tools for your workspace' : 'Connect your personal tools'}
    subtitle={connectorScope === 'workspace'
      ? 'Everyone in your workspace can ask Rally to use these connections and the data you grant access to.'
      : 'Only you can use these connections through Rally. Teammates do not gain access by sharing a stream with you.'}
    footer={<>
      <Button className="button-primary" disabled={busy} onClick={() => {
        const pageSelected = connectorProviders.some((provider) => selected.includes(`${connectorScope}:${provider.id}`) && provider.scopes.some((scope) => scope === connectorScope));
        if (!configuring && pageSelected) void perform(async () => {
          const saved = await api!.updateOnboardingJourney({ expectedRevision: state.revision, stage: 'connectors', connectorIds: OnboardingJourneySchema.shape.connectorIds.parse(selected) });
          queryClient.setQueryData(key, saved);
          setConfiguring(true);
        });
        else nextConnectorPage();
      }}>{configuring ? 'Continue' : 'Next'}</Button>
      <Button disabled={busy} onClick={nextConnectorPage}>Skip for now</Button>
      {(configuring || connectorScope === 'you') && <Button disabled={busy} onClick={() => configuring ? setConfiguring(false) : changeConnectorPage('workspace')}>Back</Button>}
    </>}>
    <p className="connector-access-note">{connectorScope === 'workspace' ? 'Workspace connections · 1 of 2' : 'Personal connections · 2 of 2. Any results you post in a shared stream are visible to its participants.'}</p>
    <label className="guided-search"><Search size={19} /><input aria-label="Search connectors" placeholder="Search" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
    <div className="guided-connector-grid">{connectorProviders.filter((provider) => connectors.data?.includes(provider.provider) && provider.scopes.some((scope) => scope === connectorScope) && (!configuring || selected.includes(`${connectorScope}:${provider.id}`)) && provider.name.toLowerCase().includes(search.toLowerCase())).map((provider) => {
      const connected = connections.data?.some((connection) => connection.connectorType === provider.provider && connection.scope === connectorScope && connection.status === 'healthy' && (connection.scope === 'you' && 'personalCapabilities' in provider ? provider.personalCapabilities : provider.capabilities).every((capability) => connection.capabilities?.includes(capability)));
      return <div className="guided-connector" key={provider.id}><button type="button" aria-pressed={selected.includes(`${connectorScope}:${provider.id}`)} onClick={() => setSelected((values) => values.includes(`${connectorScope}:${provider.id}`) ? values.filter((value) => value !== `${connectorScope}:${provider.id}`) : [...values, `${connectorScope}:${provider.id}`])}>{'mark' in provider ? <ConnectorMark mark={provider.mark} /> : <provider.icon size={24} />}<span>{provider.name}</span>{(connected || selected.includes(`${connectorScope}:${provider.id}`)) && <Check size={17} />}</button>{configuring && <><p>{provider.description}</p><div className="guided-connection-actions">{connected ? <span>Connected</span> : provider.scopes.filter((scope) => scope === connectorScope).map((scope) => <Button key={scope} disabled={busy} onClick={() => void perform(async () => {
        if (provider.provider === 'x') { await api!.createXConnection([...provider.capabilities]); await connections.refetch(); return; }
        if (provider.provider === 'custom_mcp' || provider.provider === 'generic_webhook' || (provider.provider === 'granola' && scope === 'workspace')) { await desktopBridge().openSettings('connections'); return; }
        const capabilities = scope === 'you' && 'personalCapabilities' in provider ? [...provider.personalCapabilities] : [...provider.capabilities];
        const authorization = await api!.startProviderConnection(provider.provider, scope, capabilities);
        setPendingConnectorOAuth({ attemptId: authorization.attemptId, provider: provider.provider, region: workspace.region, workspaceId: workspace.id, source: 'onboarding' });
        await desktopBridge().openExternal(authorization.url);
      })}>Connect {scope === 'you' ? 'for me' : 'for workspace'}</Button>)}</div></>}</div>;
    })}</div>{connectors.isLoading && <p>Loading available connectors…</p>}{(error ?? connectors.error?.message ?? connections.error?.message) && <InlineError>{error ?? connectors.error?.message ?? connections.error?.message}</InlineError>}
  </OnboardingPage>;
  const inviteAddresses = [...new Set([...emails, ...emailDraft.split(/[\s,;]+/u)].map((email) => email.trim().toLowerCase()).filter(Boolean))];
  const invalidEmails = inviteAddresses.some((email) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email));
  const addEmails = (value: string, commitLast: boolean): void => {
    const parts = value.split(/[\s,;]+/u);
    const remaining = commitLast ? '' : parts.pop() ?? '';
    setEmails((previous) => [...new Set([...previous, ...parts.map((email) => email.trim().toLowerCase()).filter(Boolean)])]);
    setEmailDraft(remaining);
  };
  if (state.stage === 'people') return <OnboardingPage title="Invite your teammates" subtitle="Add email addresses to invite people to your workspace." footer={<>
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
      <p>Everyone invited joins as a Member and can use workspace connections. Your private streams stay private.</p>
    </div>
    {sent.length > 0 && <p role="status">Invited: {sent.join(', ')}</p>}{error && <InlineError>{error}</InlineError>}
  </OnboardingPage>;
  return <>{children}</>;
}
