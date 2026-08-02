import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Building2,
  CalendarDays,
  Check,
  Copy,
  FileText,
  GitBranch,
  Globe2,
  HardDrive,
  LoaderCircle,
  LogOut,
  MailPlus,
  MonitorCog,
  Plug,
  RefreshCcw,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  UserRound,
  Users,
  Wifi,
  Workflow,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Avatar, Badge, Button, EmptyState, InlineError } from '../components/primitives';
import { useAppSession } from '../lib/app-session';
import { desktopBridge } from '../lib/platform';
import type { Workspace, WorkspaceInvitation, WorkstreamConnection } from '../lib/types';

type SettingsSection = 'general' | 'account' | 'workspace' | 'connections' | 'application';
type ConnectionFilter = 'all' | 'connected' | 'not_connected';

interface SettingsNavItem {
  id: SettingsSection;
  label: string;
  searchTerms: string;
  icon: LucideIcon;
}

const settingsNavigation: Array<{ label: string; items: SettingsNavItem[] }> = [
  {
    label: 'Settings',
    items: [
      { id: 'general', label: 'General', searchTerms: 'region data residency organization', icon: SlidersHorizontal },
      { id: 'account', label: 'Account', searchTerms: 'profile identity email sign out', icon: UserRound },
      { id: 'workspace', label: 'Workspace', searchTerms: 'organization members invitations invite roles', icon: Users },
      { id: 'connections', label: 'Connections', searchTerms: 'connectors google github linear notion integrations', icon: Plug },
    ],
  },
  {
    label: 'Desktop app',
    items: [
      { id: 'application', label: 'Application', searchTerms: 'version platform api realtime diagnostics', icon: MonitorCog },
    ],
  },
];

const connectorProviders = [
  {
    id: 'google-mail-calendar' as const,
    provider: 'google' as const,
    name: 'Google Mail + Calendar',
    description: 'Search Gmail, create drafts, send mail, and work with calendar events.',
    icon: CalendarDays,
    scopes: ['you'] as const,
    capabilities: ['gmail.read', 'gmail.draft', 'gmail.send', 'calendar.read', 'calendar.write'],
  },
  {
    id: 'google-drive-workspace' as const,
    provider: 'google' as const,
    name: 'Google Drive + Docs + Sheets',
    description: 'Read Drive files and work with Google Docs and Sheets content.',
    icon: HardDrive,
    scopes: ['you', 'workspace'] as const,
    capabilities: ['drive.read', 'docs.read', 'docs.write', 'sheets.read', 'sheets.write'],
  },
  {
    id: 'github' as const,
    provider: 'github' as const,
    name: 'GitHub',
    description: 'Repositories, issues, pull requests, checks, and development events.',
    icon: GitBranch,
    scopes: ['you', 'workspace'] as const,
    capabilities: ['github.metadata.read', 'github.contents.read', 'github.issues.read', 'github.issues.write', 'github.pull_requests.read', 'github.pull_requests.write', 'github.actions.read', 'github.checks.read'],
  },
  {
    id: 'linear' as const,
    provider: 'linear' as const,
    name: 'Linear',
    description: 'Workspace issues, projects, comments, and real-time issue activity.',
    icon: Workflow,
    scopes: ['workspace'] as const,
    capabilities: ['linear.read', 'linear.issue.create', 'linear.comment.create', 'linear.write'],
  },
  {
    id: 'notion' as const,
    provider: 'notion' as const,
    name: 'Notion',
    description: 'Selected pages, data sources, comments, and change notifications.',
    icon: FileText,
    scopes: ['you'] as const,
    capabilities: ['notion.read', 'notion.insert', 'notion.update', 'notion.comment.read', 'notion.comment.insert'],
  },
] as const;

function invitationStatusLabel(status: WorkspaceInvitation['status']): string {
  switch (status) {
    case 'pending': return 'Pending';
    case 'accepted': return 'Accepted';
    case 'expired': return 'Expired';
    case 'revoked': return 'Revoked';
  }
}

function providerHasConnection(
  provider: (typeof connectorProviders)[number],
  connections: WorkstreamConnection[],
): boolean {
  return connections.some((connection) =>
    connection.connectorType === provider.provider &&
    provider.capabilities.some((capability) => connection.capabilities?.includes(capability)),
  );
}

export function WorkspaceSettingsScreen({ workspace }: { workspace: Workspace }): React.JSX.Element {
  const { api, runtime, session, signOut } = useAppSession();
  const queryClient = useQueryClient();
  const [activeSection, setActiveSection] = useState<SettingsSection>('general');
  const [navigationQuery, setNavigationQuery] = useState('');
  const [connectionFilter, setConnectionFilter] = useState<ConnectionFilter>('all');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'admin' | 'member'>('member');
  const [createdUrl, setCreatedUrl] = useState<string | null>(null);
  const [createdDelivery, setCreatedDelivery] = useState<'sent' | 'skipped' | null>(null);
  const [copied, setCopied] = useState(false);
  const isAdmin = workspace.currentUser.role === 'owner' || workspace.currentUser.role === 'admin';
  const members = useQuery({
    queryKey: ['workspace-members'],
    queryFn: ({ signal }) => api!.getWorkspaceMembers(signal),
    enabled: Boolean(api),
    staleTime: 30_000,
  });
  const invitations = useQuery({
    queryKey: ['workspace-invitations'],
    queryFn: ({ signal }) => api!.getWorkspaceInvitations(signal),
    enabled: Boolean(api && isAdmin),
    staleTime: 10_000,
  });
  const connections = useQuery({
    queryKey: ['connections'],
    queryFn: ({ signal }) => api!.getConnections(signal),
    enabled: Boolean(api),
    refetchOnWindowFocus: 'always',
    staleTime: 5_000,
  });
  const connectProvider = useMutation({
    mutationFn: async (input: { provider: 'google' | 'github' | 'linear' | 'notion'; scope: 'you' | 'workspace'; capabilities: string[] }) => {
      const url = await api!.startProviderConnection(input.provider, input.scope, input.capabilities);
      await desktopBridge().openExternal(url);
    },
  });
  const testConnection = useMutation({
    mutationFn: (id: string) => api!.testConnection(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['connections'] }),
  });
  const disconnectConnection = useMutation({
    mutationFn: (id: string) => api!.disconnectConnection(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['connections'] }),
  });
  const createInvitation = useMutation({
    mutationFn: () => api!.createWorkspaceInvitation(email.trim(), role),
    onSuccess: (result) => {
      setCreatedUrl(result.inviteUrl);
      setCreatedDelivery(result.emailDelivery);
      setCopied(false);
      setEmail('');
      void queryClient.invalidateQueries({ queryKey: ['workspace-invitations'] });
    },
  });
  const revokeInvitation = useMutation({
    mutationFn: (id: string) => api!.revokeWorkspaceInvitation(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['workspace-invitations'] }),
  });
  const pendingInvitations = useMemo(
    () => (invitations.data ?? []).filter((invitation) => invitation.status === 'pending'),
    [invitations.data],
  );
  const previousInvitations = useMemo(
    () => (invitations.data ?? []).filter((invitation) => invitation.status !== 'pending'),
    [invitations.data],
  );
  const filteredNavigation = useMemo(() => {
    const query = navigationQuery.trim().toLowerCase();
    if (!query) return settingsNavigation;
    return settingsNavigation
      .map((group) => ({
        ...group,
        items: group.items.filter((item) => `${item.label} ${item.searchTerms}`.toLowerCase().includes(query)),
      }))
      .filter((group) => group.items.length > 0);
  }, [navigationQuery]);
  const availableSections = useMemo(
    () => new Set(filteredNavigation.flatMap((group) => group.items.map((item) => item.id))),
    [filteredNavigation],
  );
  const healthyConnections = (connections.data ?? []).filter((connection) => connection.status === 'healthy');
  const visibleProviders = connectorProviders.filter((provider) => {
    const connected = providerHasConnection(provider, connections.data ?? []);
    if (connectionFilter === 'connected') return connected;
    if (connectionFilter === 'not_connected') return !connected;
    return true;
  });

  useEffect(() => {
    if (availableSections.has(activeSection)) return;
    const first = filteredNavigation[0]?.items[0]?.id;
    if (first) setActiveSection(first);
  }, [activeSection, availableSections, filteredNavigation]);

  const copyInvitation = async (): Promise<void> => {
    if (!createdUrl) return;
    await desktopBridge().copyText(createdUrl);
    setCopied(true);
  };

  const sectionTitle = settingsNavigation
    .flatMap((group) => group.items)
    .find((item) => item.id === activeSection)?.label ?? 'Settings';

  return (
    <div className="workspace-settings-screen screen-with-titlebar">
      <div className="screen-drag-strip window-drag" />
      <div className="settings-window">
        <aside className="settings-sidebar">
          <label className="settings-search">
            <Search aria-hidden="true" size={15} />
            <span className="sr-only">Search settings</span>
            <input
              onChange={(event) => setNavigationQuery(event.target.value)}
              placeholder="Search"
              type="search"
              value={navigationQuery}
            />
          </label>
          <nav aria-label="Settings sections" className="settings-navigation">
            {filteredNavigation.map((group) => (
              <div className="settings-navigation-group" key={group.label}>
                <span>{group.label}</span>
                {group.items.map((item) => {
                  const Icon = item.icon;
                  return (
                    <button
                      aria-current={activeSection === item.id ? 'page' : undefined}
                      key={item.id}
                      onClick={() => setActiveSection(item.id)}
                      type="button"
                    >
                      <Icon aria-hidden="true" size={16} />
                      {item.label}
                    </button>
                  );
                })}
              </div>
            ))}
            {filteredNavigation.length === 0 && <p className="settings-search-empty">No settings found</p>}
          </nav>
        </aside>

        <main className="settings-content">
          <header className="settings-content-header window-drag">
            <h1 id="settings-title">{sectionTitle}</h1>
            <button aria-label="Close settings" className="settings-close window-no-drag" onClick={() => window.close()} type="button">
              <X aria-hidden="true" size={18} />
            </button>
          </header>
          <div className="settings-content-scroll">
            {activeSection === 'general' && (
              <section aria-labelledby="settings-title" className="settings-pane">
                <div className="settings-pane-heading">
                  <h2>Workspace preferences</h2>
                  <p>Review the permanent data location and service boundary for this workspace.</p>
                </div>
                <div className="settings-list-card">
                  <div className="settings-preference-row">
                    <span className="settings-row-icon">
                      {workspace.region === 'eu' ? <ShieldCheck aria-hidden="true" size={18} /> : <Globe2 aria-hidden="true" size={18} />}
                    </span>
                    <span className="settings-row-copy">
                      <strong>Data region</strong>
                      <small>All workspace data, sessions, and requests remain pinned to this regional service.</small>
                    </span>
                    <span className="settings-row-value">
                      <strong>{workspace.region === 'eu' ? 'European Union' : 'Global'}</strong>
                      <Badge>Locked</Badge>
                    </span>
                  </div>
                  <div className="settings-preference-row">
                    <span className="settings-row-icon"><Building2 aria-hidden="true" size={18} /></span>
                    <span className="settings-row-copy">
                      <strong>Organization</strong>
                      <small>The shared Avalon workspace active in this desktop app.</small>
                    </span>
                    <span className="settings-row-value"><strong>{workspace.name}</strong></span>
                  </div>
                </div>
              </section>
            )}

            {activeSection === 'account' && (
              <section aria-labelledby="settings-title" className="settings-pane">
                <div className="settings-pane-heading"><h2>Profile</h2><p>Your Avalon identity and access in this workspace.</p></div>
                <div className="settings-profile-card">
                  <Avatar member={workspace.currentUser} size="large" />
                  <span><strong>{workspace.currentUser.name}</strong><small>{workspace.currentUser.email}</small></span>
                  <Badge className="role-badge">{workspace.currentUser.role}</Badge>
                </div>
                <div className="settings-pane-heading settings-pane-heading-spaced"><h2>Session</h2></div>
                <div className="settings-list-card">
                  <div className="settings-preference-row">
                    <span className="settings-row-icon"><LogOut aria-hidden="true" size={18} /></span>
                    <span className="settings-row-copy"><strong>Sign out of Avalon</strong><small>Remove the local session from this Mac.</small></span>
                    <Button onClick={() => void signOut()}>Sign out</Button>
                  </div>
                </div>
              </section>
            )}

            {activeSection === 'workspace' && (
              <section aria-labelledby="settings-title" className="settings-pane">
                <div className="settings-pane-heading settings-pane-heading-count">
                  <div><h2>Members</h2><p>People with access to {workspace.name}.</p></div>
                  <span>{members.data?.length ?? 0}</span>
                </div>
                {members.error && <InlineError>{members.error.message}</InlineError>}
                <div className="settings-member-list settings-list-card">
                  {(members.data ?? []).map((member) => (
                    <div className="settings-member-row" key={member.id}>
                      <Avatar member={member} size="medium" />
                      <span><strong>{member.name}</strong><small>{member.email}</small></span>
                      <Badge className="role-badge">{member.role ?? 'member'}</Badge>
                    </div>
                  ))}
                </div>

                {isAdmin && (
                  <div className="settings-subsection">
                    <div className="settings-pane-heading settings-pane-heading-count">
                      <div><h2>Invitations</h2><p>Invite teammates by email. Links expire after seven days.</p></div>
                      <span>{pendingInvitations.length} pending</span>
                    </div>
                    <form
                      className="invite-form"
                      onSubmit={(event) => {
                        event.preventDefault();
                        if (email.trim()) createInvitation.mutate();
                      }}
                    >
                      <label>
                        <span>Email address</span>
                        <input autoComplete="email" onChange={(event) => setEmail(event.target.value)} placeholder="teammate@company.com" type="email" value={email} />
                      </label>
                      <label>
                        <span>Role</span>
                        <select onChange={(event) => setRole(event.target.value as 'admin' | 'member')} value={role}>
                          <option value="member">Member</option>
                          {workspace.currentUser.role === 'owner' && <option value="admin">Administrator</option>}
                        </select>
                      </label>
                      <Button className="button-primary" disabled={!email.trim() || createInvitation.isPending} type="submit">
                        {createInvitation.isPending ? <LoaderCircle aria-hidden="true" className="spin" size={15} /> : <MailPlus aria-hidden="true" size={15} />}
                        Send invitation
                      </Button>
                    </form>
                    {createInvitation.error && <InlineError>{createInvitation.error.message}</InlineError>}
                    {createdUrl && (
                      <div className="invite-link-result" role="status">
                        <div>
                          <strong>{createdDelivery === 'sent' ? 'Invitation emailed' : 'Invite link ready'}</strong>
                          <small>{createdDelivery === 'sent' ? 'It expires in seven days. You can also copy the one-time link.' : 'Email delivery is disabled outside production. Copy the one-time link to test the flow.'}</small>
                        </div>
                        <Button onClick={() => void copyInvitation()}>
                          {copied ? <Check aria-hidden="true" size={14} /> : <Copy aria-hidden="true" size={14} />}
                          {copied ? 'Copied' : 'Copy link'}
                        </Button>
                      </div>
                    )}
                    {revokeInvitation.error && <InlineError>{revokeInvitation.error.message}</InlineError>}
                    <div className="invitation-list settings-list-card">
                      {invitations.isLoading ? (
                        <div className="settings-loading"><LoaderCircle aria-hidden="true" className="spin" size={15} /> Loading invitations…</div>
                      ) : pendingInvitations.length === 0 ? (
                        <EmptyState title="No pending invitations" description="New invitations appear here until they are accepted or revoked." />
                      ) : pendingInvitations.map((invitation) => (
                        <div className="invitation-row" key={invitation.id}>
                          <span><strong>{invitation.email}</strong><small>{invitation.role === 'admin' ? 'Administrator' : 'Member'} · expires {new Date(invitation.expiresAt).toLocaleDateString()}</small></span>
                          <Badge>{invitationStatusLabel(invitation.status)}</Badge>
                          <button aria-label={`Revoke invitation for ${invitation.email}`} disabled={revokeInvitation.isPending} onClick={() => revokeInvitation.mutate(invitation.id)} type="button">
                            <Trash2 aria-hidden="true" size={14} />
                          </button>
                        </div>
                      ))}
                    </div>
                    {previousInvitations.length > 0 && (
                      <details className="invitation-history">
                        <summary>Previous invitations ({previousInvitations.length})</summary>
                        {previousInvitations.map((invitation) => (
                          <div className="invitation-history-row" key={invitation.id}><span>{invitation.email}</span><Badge>{invitationStatusLabel(invitation.status)}</Badge></div>
                        ))}
                      </details>
                    )}
                  </div>
                )}
              </section>
            )}

            {activeSection === 'connections' && (
              <section aria-labelledby="settings-title" className="settings-pane settings-connections-pane">
                <div className="settings-connection-toolbar">
                  <div className="settings-segmented" role="group" aria-label="Filter connections">
                    {([
                      ['all', 'All'],
                      ['connected', 'Connected'],
                      ['not_connected', 'Not connected'],
                    ] as const).map(([value, label]) => (
                      <button aria-pressed={connectionFilter === value} key={value} onClick={() => setConnectionFilter(value)} type="button">{label}</button>
                    ))}
                  </div>
                  <span>{healthyConnections.length} connected</span>
                </div>
                <p className="settings-section-copy">Workspace connections expose every granted read and write capability to all work streams. Workspace automations use explicitly bound connections.</p>
                <div className="provider-grid">
                  {visibleProviders.map((provider) => {
                    const Icon = provider.icon;
                    const connected = providerHasConnection(provider, connections.data ?? []);
                    return (
                      <article className="provider-card" key={provider.id}>
                        <div className="provider-card-heading">
                          <div className="provider-icon"><Icon aria-hidden="true" size={18} /></div>
                          <div><strong>{provider.name}</strong><span>{connected ? 'Connected' : 'Available'}</span></div>
                        </div>
                        <p>{provider.description}</p>
                        <div className="provider-actions">
                          {provider.scopes.includes('you' as never) && (
                            <Button disabled={connectProvider.isPending} onClick={() => connectProvider.mutate({ provider: provider.provider, scope: 'you', capabilities: [...provider.capabilities] })}>Connect for me</Button>
                          )}
                          {provider.scopes.includes('workspace' as never) && isAdmin && (
                            <Button disabled={connectProvider.isPending} onClick={() => connectProvider.mutate({ provider: provider.provider, scope: 'workspace', capabilities: [...provider.capabilities] })}>Connect workspace</Button>
                          )}
                        </div>
                      </article>
                    );
                  })}
                  {visibleProviders.length === 0 && <EmptyState title="No connectors here" description="Change the filter to see other available providers." />}
                </div>
                {(connections.error || connectProvider.error || testConnection.error || disconnectConnection.error) && (
                  <InlineError>{connections.error?.message ?? connectProvider.error?.message ?? testConnection.error?.message ?? disconnectConnection.error?.message}</InlineError>
                )}
                <div className="settings-subsection">
                  <div className="settings-pane-heading settings-pane-heading-count">
                    <div><h2>Installed connections</h2><p>Credentials currently available to you or this workspace.</p></div>
                    <span>{connections.data?.length ?? 0}</span>
                  </div>
                  <div className="settings-connection-list settings-list-card">
                    {(connections.data ?? []).filter((connection) => ['google', 'github', 'linear', 'notion'].includes(connection.connectorType)).map((connection) => (
                      <div className="settings-connection-row" key={connection.id}>
                        <span className={`connection-provider-dot ${connection.status}`} aria-hidden="true" />
                        <span><strong>{connection.displayName}</strong><small>{connection.scope === 'you' ? 'Personal' : 'Workspace'} · {connection.capabilities?.length ?? 0} capabilities</small></span>
                        <Badge>{connection.status === 'reconnect_required' ? 'Reconnect required' : connection.status}</Badge>
                        {connection.status === 'reconnect_required' && <Button onClick={async () => desktopBridge().openExternal(await api!.reconnectConnection(connection.id))}><RefreshCcw aria-hidden="true" size={13} /> Reconnect</Button>}
                        <Button disabled={testConnection.isPending} onClick={() => testConnection.mutate(connection.id)}>Test</Button>
                        <button aria-label={`Disconnect ${connection.displayName}`} className="settings-icon-action" disabled={disconnectConnection.isPending} onClick={() => disconnectConnection.mutate(connection.id)} type="button"><Trash2 aria-hidden="true" size={14} /></button>
                      </div>
                    ))}
                    {!connections.isLoading && (connections.data ?? []).length === 0 && <EmptyState title="No connections yet" description="Connect a provider above to make its tools available to Avalon." />}
                  </div>
                </div>
              </section>
            )}

            {activeSection === 'application' && (
              <section aria-labelledby="settings-title" className="settings-pane">
                <div className="settings-pane-heading"><h2>General desktop settings</h2><p>Build and service details for this Avalon installation.</p></div>
                <dl className="settings-diagnostics settings-list-card">
                  <div><dt>Version</dt><dd>{runtime?.appVersion ?? 'Unknown'}</dd></div>
                  <div><dt>Build</dt><dd>{runtime?.isPackaged ? 'Installed app' : 'Development'}</dd></div>
                  <div><dt>Platform</dt><dd>{runtime?.platform ?? 'Unknown'}</dd></div>
                  <div><dt>Regional API</dt><dd className="mono">{session?.apiBaseUrl ?? api?.baseUrl ?? 'Unavailable'}</dd></div>
                  <div><dt><Wifi aria-hidden="true" size={14} /> Realtime</dt><dd>Automatic reconnect · hibernating socket</dd></div>
                </dl>
              </section>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
