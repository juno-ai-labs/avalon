import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AtSign,
  Building2,
  Bug,
  CalendarDays,
  Check,
  Clock3,
  Copy,
  FileText,
  GitBranch,
  Globe2,
  HardDrive,
  LockKeyhole,
  LoaderCircle,
  LogOut,
  MailPlus,
  MessageSquare,
  MonitorCog,
  Plug,
  RefreshCcw,
  Search,
  ShieldCheck,
  Trash2,
  UserRound,
  Users,
  Wifi,
  Webhook,
  Workflow,
  Wrench,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { ConnectorOAuthProvider, ConnectorOAuthStart } from '@avalon/contracts';
import { parseDesktopSettingsSection } from '../../common/settings';
import type { DesktopSettingsSection } from '../../common/settings';
import type { DesktopApplicationSettings } from '../../common/desktop';
import { Avatar, Badge, Button, DropdownSelect, EmptyState, InlineError, Modal } from '../components/primitives';
import { ApplicationIconPicker } from '../components/application-icon-picker';
import { useAppSession } from '../lib/app-session';
import { desktopBridge } from '../lib/platform';
import type { Workspace, WorkspaceInvitation, WorkstreamConnection } from '../lib/types';

type SettingsSection = DesktopSettingsSection;
type ConnectionFilter = 'all' | 'connected' | 'not_connected';

interface PendingConnectorOAuth {
  attemptId: string;
  provider: ConnectorOAuthProvider;
  startedAt: number;
}

const connectorProviderName: Record<ConnectorOAuthProvider, string> = {
  google: 'Google',
  github: 'GitHub',
  granola: 'Granola',
  linear: 'Linear',
  notion: 'Notion',
  slack: 'Slack',
};

const reconnectableConnectorTypes = new Set<WorkstreamConnection['connectorType']>([
  'google',
  'github',
  'granola',
  'linear',
  'notion',
  'slack',
]);

const installedConnectorTypes = new Set<WorkstreamConnection['connectorType']>([
  ...reconnectableConnectorTypes,
  'generic_webhook',
  'x',
]);

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
      { id: 'account', label: 'Account', searchTerms: 'profile identity email sign out', icon: UserRound },
      { id: 'workspace', label: 'Workspace', searchTerms: 'region data residency organization members invitations invite roles', icon: Users },
      { id: 'connections', label: 'Connections', searchTerms: 'connectors google github granola meetings notes linear notion slack x integrations', icon: Plug },
    ],
  },
  {
    label: 'Desktop app',
    items: [
      { id: 'application', label: 'Application', searchTerms: 'app security lockdown encryption keychain session icon appearance dock customize developer debug identifiers version platform api realtime diagnostics', icon: MonitorCog },
    ],
  },
];

const linearNativeAgentEnabled = import.meta.env.VITE_LINEAR_NATIVE_AGENT_ENABLED === 'true';
const supportedTimezones = typeof Intl.supportedValuesOf === 'function'
  ? Intl.supportedValuesOf('timeZone')
  : ['America/Los_Angeles', 'Europe/London', 'UTC'];

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
    id: 'granola' as const,
    provider: 'granola' as const,
    name: 'Granola',
    description: 'Personal meeting context through Granola MCP, or workspace notes and transcripts through an admin API key.',
    icon: FileText,
    scopes: ['you', 'workspace'] as const,
    personalCapabilities: ['granola.personal.read'],
    capabilities: ['granola.workspace.read'],
  },
  {
    id: 'linear' as const,
    provider: 'linear' as const,
    name: 'Linear',
    description: 'Connect personally to act as you, or install Avalon for shared workspace access and real-time activity.',
    icon: Workflow,
    scopes: ['you', 'workspace'] as const,
    personalCapabilities: [
      'linear.read',
      'linear.issue.create',
      'linear.comment.create',
      'linear.write',
    ],
    capabilities: [
      'linear.read',
      'linear.issue.create',
      'linear.comment.create',
      'linear.write',
      ...(linearNativeAgentEnabled ? ['linear.agent'] : []),
    ],
  },
  {
    id: 'slack' as const,
    provider: 'slack' as const,
    name: 'Slack',
    description: 'Messages, files, people, canvases, conversations, and the Avalon workspace Agent.',
    icon: MessageSquare,
    scopes: ['you', 'workspace'] as const,
    personalCapabilities: [
      'slack.search',
      'slack.messages.read',
      'slack.files.read',
      'slack.users.read',
      'slack.messages.write',
      'slack.conversations.write',
      'slack.reactions.write',
      'slack.canvases.read',
      'slack.canvases.write',
    ],
    capabilities: ['slack.agent', 'slack.notifications.write'],
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
  {
    id: 'generic-webhook' as const,
    provider: 'generic_webhook' as const,
    name: 'Inbound webhook',
    description: 'Receive signed activity from systems that do not have a native Avalon connector.',
    icon: Webhook,
    scopes: ['you', 'workspace'] as const,
    capabilities: [],
  },
  {
    id: 'x' as const,
    provider: 'x' as const,
    name: 'Public X via TwitterAPI.io',
    description: 'Read-only public X timelines, threads, replies, and Lists using an Avalon-managed third-party API key.',
    icon: AtSign,
    scopes: ['workspace'] as const,
    capabilities: ['x.read'],
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
  const capabilities = [
    ...provider.capabilities,
    ...('personalCapabilities' in provider ? provider.personalCapabilities : []),
  ];
  return connections.some((connection) =>
    connection.connectorType === provider.provider &&
    (capabilities.length === 0 || capabilities.some((capability) => connection.capabilities?.includes(capability))),
  );
}

function providerHasActiveWorkspaceConnection(
  provider: (typeof connectorProviders)[number],
  connections: WorkstreamConnection[],
): boolean {
  return connections.some((connection) =>
    connection.connectorType === provider.provider &&
    connection.scope === 'workspace' &&
    connection.status !== 'disabled',
  );
}

function providerHasActivePersonalConnection(
  provider: (typeof connectorProviders)[number],
  connections: WorkstreamConnection[],
): boolean {
  return (provider.provider === 'x' || provider.provider === 'granola') && connections.some((connection) =>
    connection.connectorType === provider.provider &&
    connection.scope === 'you' &&
    connection.status !== 'disabled',
  );
}

function providerCapabilitiesForScope(
  provider: (typeof connectorProviders)[number],
  scope: 'you' | 'workspace',
): string[] {
  if (scope === 'you' && 'personalCapabilities' in provider) {
    return [...provider.personalCapabilities];
  }
  return [...provider.capabilities];
}

function initialSettingsSection(): SettingsSection {
  const nativeSection = parseDesktopSettingsSection(
    new URLSearchParams(window.location.search).get('settingsSection'),
  );
  if (nativeSection) return nativeSection;
  const hashQuery = window.location.hash.split('?', 2)[1];
  return parseDesktopSettingsSection(new URLSearchParams(hashQuery ?? '').get('section')) ?? 'account';
}

export function WorkspaceSettingsScreen({ workspace }: { workspace: Workspace }): React.JSX.Element {
  const { api, runtime, session, signOut } = useAppSession();
  const queryClient = useQueryClient();
  const bridge = useMemo(() => desktopBridge(), []);
  const [activeSection, setActiveSection] = useState<SettingsSection>(initialSettingsSection);
  const [navigationQuery, setNavigationQuery] = useState('');
  const [connectionFilter, setConnectionFilter] = useState<ConnectionFilter>('all');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'admin' | 'member'>('member');
  const [createdUrl, setCreatedUrl] = useState<string | null>(null);
  const [createdDelivery, setCreatedDelivery] = useState<'sent' | 'skipped' | null>(null);
  const [copied, setCopied] = useState(false);
  const [userTimezone, setUserTimezone] = useState(workspace.currentUser.timezone);
  const [workspaceTimezone, setWorkspaceTimezone] = useState(workspace.timezone);
  const [logAgentInference, setLogAgentInference] = useState(workspace.logAgentInference);
  const [applicationSettings, setApplicationSettings] = useState<DesktopApplicationSettings | null>(null);
  const [applicationSettingsLoadError, setApplicationSettingsLoadError] = useState<string | null>(null);
  const [pendingConnectorOAuth, setPendingConnectorOAuth] = useState<PendingConnectorOAuth | null>(null);
  const [reconnectTarget, setReconnectTarget] = useState<WorkstreamConnection | null>(null);
  const [connectorOAuthMessage, setConnectorOAuthMessage] = useState<string | null>(null);
  const [connectorOAuthError, setConnectorOAuthError] = useState<string | null>(null);
  const [granolaWorkspaceModalOpen, setGranolaWorkspaceModalOpen] = useState(false);
  const [granolaWorkspaceApiKey, setGranolaWorkspaceApiKey] = useState('');
  const [webhookModalScope, setWebhookModalScope] = useState<'you' | 'workspace' | null>(null);
  const [webhookDisplayName, setWebhookDisplayName] = useState('Inbound webhook');
  const [webhookEventTypes, setWebhookEventTypes] = useState('');
  const [webhookIdempotencyKey, setWebhookIdempotencyKey] = useState(() => crypto.randomUUID());
  const [webhookSecretResult, setWebhookSecretResult] = useState<{
    endpoint: string;
    signingSecret: string;
    signatureFormat: string;
  } | null>(null);
  const [webhookCopied, setWebhookCopied] = useState<'endpoint' | 'secret' | null>(null);
  const [webhookRotationTarget, setWebhookRotationTarget] = useState<WorkstreamConnection | null>(null);
  const timezoneOptions = useMemo(
    () => [...new Set([...supportedTimezones, userTimezone, workspaceTimezone])].sort(),
    [userTimezone, workspaceTimezone],
  );
  const isAdmin = workspace.currentUser.role === 'owner' || workspace.currentUser.role === 'admin';
  const members = useQuery({
    queryKey: ['workspace-members'],
    queryFn: ({ signal }) => api!.getWorkspaceMembers(signal),
    enabled: Boolean(api),
    refetchOnMount: 'always',
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
  const connectorCatalog = useQuery({
    queryKey: ['connector-catalog'],
    queryFn: ({ signal }) => api!.getAvailableConnectorTypes(signal),
    enabled: Boolean(api),
    staleTime: 30_000,
  });
  const connectProvider = useMutation({
    mutationFn: async (input: { provider: 'google' | 'github' | 'granola' | 'linear' | 'notion' | 'slack' | 'x'; scope: 'you' | 'workspace'; capabilities: string[] }) => {
      if (input.provider === 'x') {
        await api!.createXConnection(input.capabilities);
        return { kind: 'direct' as const };
      }
      const authorization = await api!.startProviderConnection(input.provider, input.scope, input.capabilities);
      await desktopBridge().openExternal(authorization.url);
      return { kind: 'oauth' as const, authorization, provider: input.provider };
    },
    onMutate: () => {
      setConnectorOAuthMessage(null);
      setConnectorOAuthError(null);
    },
    onSuccess: (result) => {
      if (result.kind === 'direct') {
        void queryClient.invalidateQueries({ queryKey: ['connections'] });
        return;
      }
      setPendingConnectorOAuth({
        attemptId: result.authorization.attemptId,
        provider: result.provider,
        startedAt: Date.now(),
      });
    },
  });
  const createGranolaWorkspaceConnection = useMutation({
    mutationFn: () => api!.createGranolaWorkspaceConnection(granolaWorkspaceApiKey.trim()),
    onSuccess: () => {
      setGranolaWorkspaceApiKey('');
      setGranolaWorkspaceModalOpen(false);
      void queryClient.invalidateQueries({ queryKey: ['connections'] });
    },
  });
  const createWebhookConnection = useMutation({
    mutationFn: () => api!.createWebhookConnection(
      webhookDisplayName.trim(),
      webhookModalScope ?? 'you',
      [...new Set(webhookEventTypes.split(/[\s,]+/u).map((value) => value.trim()).filter(Boolean))],
      webhookIdempotencyKey,
    ),
    onSuccess: (result) => {
      setWebhookSecretResult(result);
      void queryClient.invalidateQueries({ queryKey: ['connections'] });
    },
  });
  const rotateWebhookSecret = useMutation({
    mutationFn: (connection: WorkstreamConnection) => api!.rotateWebhookSecret(connection.id),
    onSuccess: (result) => setWebhookSecretResult(result),
  });
  const reconnectConnection = useMutation({
    mutationFn: async (connection: WorkstreamConnection) => {
      const authorization: ConnectorOAuthStart = await api!.reconnectConnection(connection.id);
      const attempt = await api!.getConnectorOAuthAttempt(authorization.attemptId);
      await desktopBridge().openExternal(authorization.url);
      return { authorization, provider: attempt.provider };
    },
    onMutate: () => {
      setConnectorOAuthMessage(null);
      setConnectorOAuthError(null);
    },
    onSuccess: ({ authorization, provider }) => setPendingConnectorOAuth({
      attemptId: authorization.attemptId,
      provider,
      startedAt: Date.now(),
    }),
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
  const updateUserTimezone = useMutation({
    mutationFn: (timezone: string) => api!.updateMyTimezone(timezone),
    onSuccess: (user) => setUserTimezone(user.timezone),
  });
  const updateWorkspaceTimezone = useMutation({
    mutationFn: (timezone: string) => api!.updateWorkspaceTimezone(timezone),
    onSuccess: (updated) => setWorkspaceTimezone(updated.timezone),
  });
  const updateLogAgentInference = useMutation({
    mutationFn: (enabled: boolean) => api!.updateWorkspaceLogAgentInference(enabled),
    onSuccess: (updated) => setLogAgentInference(updated.logAgentInference),
    onError: (_error, attemptedValue) => setLogAgentInference(!attemptedValue),
  });
  const updateLockdownMode = useMutation({
    mutationFn: (enabled: boolean) => bridge.setLockdownMode(enabled),
    onSuccess: setApplicationSettings,
  });
  const updateDebugEnabled = useMutation({
    mutationFn: (enabled: boolean) => bridge.setDebugEnabled(enabled),
    onSuccess: setApplicationSettings,
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
  const installedConnections = (connections.data ?? []).filter((connection) =>
    installedConnectorTypes.has(connection.connectorType),
  );
  const healthyConnections = installedConnections.filter((connection) => connection.status === 'healthy');
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

  useEffect(() => bridge.onSettingsSectionRequested((section) => {
    const nextSection = parseDesktopSettingsSection(section);
    if (!nextSection) return;
    setNavigationQuery('');
    setActiveSection(nextSection);
  }), [bridge]);

  useEffect(() => {
    let cancelled = false;
    void bridge.getApplicationSettings().then((settings) => {
      if (cancelled) return;
      setApplicationSettings(settings);
      setApplicationSettingsLoadError(null);
    }).catch((error: unknown) => {
      if (!cancelled) {
        setApplicationSettingsLoadError(
          error instanceof Error ? error.message : 'Application settings could not be loaded.',
        );
      }
    });
    const unsubscribe = bridge.onApplicationSettingsChanged((settings) => {
      if (!cancelled) setApplicationSettings(settings);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [bridge]);

  useEffect(() => {
    if (!api || !pendingConnectorOAuth) return;
    let cancelled = false;
    let timer: number | undefined;
    let retryDelayMs = 750;
    const providerName = connectorProviderName[pendingConnectorOAuth.provider];

    const poll = async (): Promise<void> => {
      try {
        const attempt = await api.getConnectorOAuthAttempt(pendingConnectorOAuth.attemptId);
        if (cancelled) return;
        if (attempt.status === 'pending') {
          retryDelayMs = 1_000;
          timer = window.setTimeout(() => void poll(), retryDelayMs);
          return;
        }
        setPendingConnectorOAuth(null);
        if (attempt.status === 'succeeded') {
          setConnectorOAuthError(null);
          setConnectorOAuthMessage(`${providerName} is connected.`);
          void Promise.all([
            queryClient.invalidateQueries({ queryKey: ['connections'] }),
            queryClient.invalidateQueries({ queryKey: ['workstream'] }),
            queryClient.invalidateQueries({ queryKey: ['automation'] }),
          ]);
          return;
        }
        setConnectorOAuthMessage(null);
        setConnectorOAuthError(
          attempt.status === 'denied'
            ? `${providerName} authorization was cancelled.`
            : attempt.errorCode === 'oauth_attempt_expired'
              ? `${providerName} authorization expired. Try connecting again.`
              : `${providerName} could not be connected. Try again.`,
        );
      } catch {
        if (cancelled) return;
        if (Date.now() - pendingConnectorOAuth.startedAt >= 16 * 60_000) {
          setPendingConnectorOAuth(null);
          setConnectorOAuthError(`${providerName} authorization could not be confirmed. Refresh connections or try again.`);
          return;
        }
        retryDelayMs = Math.min(5_000, retryDelayMs * 2);
        timer = window.setTimeout(() => void poll(), retryDelayMs);
      }
    };

    void poll();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [api, pendingConnectorOAuth, queryClient]);

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
            {activeSection === 'account' && (
              <section aria-labelledby="settings-title" className="settings-pane">
                <div className="settings-pane-heading"><h2>Profile</h2><p>Your Avalon identity and access in this workspace.</p></div>
                <div className="settings-profile-card">
                  <Avatar member={workspace.currentUser} size="large" />
                  <span><strong>{workspace.currentUser.name}</strong><small>{workspace.currentUser.email}</small></span>
                  <Badge className="role-badge">{workspace.currentUser.role}</Badge>
                </div>
                <div className="settings-pane-heading settings-pane-heading-spaced"><h2>Preferences</h2></div>
                <div className="settings-list-card">
                  <label className="settings-preference-row">
                    <span className="settings-row-icon"><Clock3 aria-hidden="true" size={18} /></span>
                    <span className="settings-row-copy"><strong>Default timezone</strong><small>Used for your personal automations when no timezone is specified.</small></span>
                    <DropdownSelect
                      ariaLabel="Personal default timezone"
                      disabled={updateUserTimezone.isPending}
                      onValueChange={(timezone) => {
                        setUserTimezone(timezone);
                        updateUserTimezone.mutate(timezone);
                      }}
                      options={timezoneOptions.map((timezone) => ({ label: timezone, value: timezone }))}
                      value={userTimezone}
                      variant="secondary"
                    />
                  </label>
                </div>
                {updateUserTimezone.error && <InlineError>{updateUserTimezone.error.message}</InlineError>}
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
                <div className="settings-pane-heading"><h2>Workspace preferences</h2><p>Review workspace details and defaults shared by workspace automations.</p></div>
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
                  <label className="settings-preference-row">
                    <span className="settings-row-icon"><Clock3 aria-hidden="true" size={18} /></span>
                    <span className="settings-row-copy"><strong>Default timezone</strong><small>Used when a workspace automation does not specify a timezone.</small></span>
                    <DropdownSelect
                      ariaLabel="Workspace default timezone"
                      disabled={!isAdmin || updateWorkspaceTimezone.isPending}
                      onValueChange={(timezone) => {
                        setWorkspaceTimezone(timezone);
                        updateWorkspaceTimezone.mutate(timezone);
                      }}
                      options={timezoneOptions.map((timezone) => ({ label: timezone, value: timezone }))}
                      value={workspaceTimezone}
                      variant="secondary"
                    />
                  </label>
                  <label className="settings-preference-row">
                    <span className="settings-row-icon"><Bug aria-hidden="true" size={18} /></span>
                    <span className="settings-row-copy">
                      <strong>Log agent inference</strong>
                      <small>Store full agent messages, metadata, and tool definitions in the workspace region for debugging.</small>
                    </span>
                    <span className="settings-toggle">
                      <input
                        aria-label="Log agent inference"
                        checked={logAgentInference}
                        disabled={!isAdmin || updateLogAgentInference.isPending}
                        onChange={(event) => {
                          const enabled = event.currentTarget.checked;
                          setLogAgentInference(enabled);
                          updateLogAgentInference.mutate(enabled);
                        }}
                        role="switch"
                        type="checkbox"
                      />
                      <span aria-hidden="true" />
                    </span>
                  </label>
                </div>
                {updateWorkspaceTimezone.error && <InlineError>{updateWorkspaceTimezone.error.message}</InlineError>}
                {updateLogAgentInference.error && <InlineError>{updateLogAgentInference.error.message}</InlineError>}
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
                <div className="settings-pane-heading settings-pane-heading-count">
                  <div><h2>Installed connections</h2><p>Credentials currently available to you or this workspace.</p></div>
                  <span>{installedConnections.length}</span>
                </div>
                <div className="settings-connection-list settings-list-card">
                  {installedConnections.map((connection) => (
                    <div className="settings-connection-row" key={connection.id}>
                      <span className={`connection-provider-dot ${connection.status}`} aria-hidden="true" />
                      <span><strong>{connection.displayName}</strong><small>{connection.scope === 'you' ? 'Personal' : 'Workspace'} · {connection.capabilities?.length ?? 0} capabilities</small></span>
                      <Badge>{connection.status === 'reconnect_required' ? 'Reconnect required' : connection.status}</Badge>
                      <Button disabled={testConnection.isPending} onClick={() => testConnection.mutate(connection.id)}>Test</Button>
                      {reconnectableConnectorTypes.has(connection.connectorType)
                        && !(connection.connectorType === 'granola' && connection.scope === 'workspace') && (
                        <button
                          aria-label={`Reconnect ${connection.displayName}`}
                          className="settings-icon-action"
                          disabled={reconnectConnection.isPending || Boolean(pendingConnectorOAuth)}
                          onClick={() => setReconnectTarget(connection)}
                          type="button"
                        >
                          <RefreshCcw aria-hidden="true" size={14} />
                        </button>
                      )}
                      {connection.connectorType === 'generic_webhook' && (
                        <button
                          aria-label={`Rotate secret for ${connection.displayName}`}
                          className="settings-icon-action"
                          disabled={rotateWebhookSecret.isPending}
                          onClick={() => {
                            setWebhookModalScope(connection.scope);
                            setWebhookDisplayName(connection.displayName);
                            setWebhookEventTypes('');
                            setWebhookSecretResult(null);
                            setWebhookCopied(null);
                            setWebhookRotationTarget(connection);
                          }}
                          type="button"
                        >
                          <RefreshCcw aria-hidden="true" size={14} />
                        </button>
                      )}
                      <button aria-label={`Disconnect ${connection.displayName}`} className="settings-icon-action" disabled={disconnectConnection.isPending} onClick={() => disconnectConnection.mutate(connection.id)} type="button"><Trash2 aria-hidden="true" size={14} /></button>
                    </div>
                  ))}
                  {!connections.isLoading && installedConnections.length === 0 && <EmptyState title="No connections yet" description="Connect a provider below to make its tools available to Avalon." />}
                </div>
                <div className="settings-subsection">
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
                  <p className="settings-section-copy">Personal connections are available only to you and act with your provider identity. Workspace connections expose granted capabilities to every member and workspace automation.</p>
                  <div className="provider-grid">
                    {visibleProviders.map((provider) => {
                      const Icon = provider.icon;
                      const connected = providerHasConnection(provider, connections.data ?? []);
                      const providerAvailable = connectorCatalog.data?.includes(provider.provider) ?? false;
                      const awaitingProvider = pendingConnectorOAuth?.provider === provider.provider;
                      const hasActivePersonalConnection = provider.provider !== 'generic_webhook'
                        && providerHasActivePersonalConnection(provider, connections.data ?? []);
                      const hasActiveWorkspaceConnection = provider.provider !== 'generic_webhook'
                        && providerHasActiveWorkspaceConnection(provider, connections.data ?? []);
                      const personalConnectionStateUnavailable = provider.provider === 'granola' && (connections.isLoading || connections.isError);
                      const personalConnectDisabled = !providerAvailable || personalConnectionStateUnavailable || connectProvider.isPending || Boolean(pendingConnectorOAuth) || hasActivePersonalConnection;
                      const personalConnectTitle = hasActivePersonalConnection
                        ? `A ${provider.name} personal connection is already installed. Manage it above.`
                        : !providerAvailable && !connectorCatalog.isLoading
                          ? `${provider.name} is not configured in this Avalon region.`
                        : provider.provider === 'granola' && connections.isLoading
                          ? 'Checking installed personal connections…'
                          : provider.provider === 'granola' && connections.isError
                            ? 'Installed personal connections could not be loaded.'
                            : undefined;
                      const workspaceConnectDisabled = !providerAvailable || connections.isLoading || connections.isError || connectProvider.isPending || createGranolaWorkspaceConnection.isPending || Boolean(pendingConnectorOAuth) || hasActiveWorkspaceConnection;
                      const workspaceConnectTitle = hasActiveWorkspaceConnection
                        ? `A ${provider.name} workspace connection is already installed. Manage it above.`
                        : !providerAvailable && !connectorCatalog.isLoading
                          ? `${provider.name} is not configured in this Avalon region.`
                        : connections.isLoading
                          ? 'Checking installed workspace connections…'
                          : connections.isError
                            ? 'Installed workspace connections could not be loaded.'
                            : undefined;
                      return (
                        <article className="provider-card" key={provider.id}>
                          <div className="provider-card-heading">
                            <div className="provider-icon"><Icon aria-hidden="true" size={18} /></div>
                            <div><strong>{provider.name}</strong><span>{awaitingProvider ? 'Waiting for authorization' : connected ? 'Connected' : connectorCatalog.isLoading ? 'Checking availability' : providerAvailable ? 'Available' : 'Unavailable'}</span></div>
                          </div>
                          <p>{provider.description}</p>
                            <div className="provider-actions">
                              {provider.scopes.includes('you' as never) && (
                                <Button
                                  disabled={personalConnectDisabled}
                                  onClick={() => {
                                    if (provider.provider === 'generic_webhook') {
                                      setWebhookModalScope('you');
                                      setWebhookDisplayName('Inbound webhook');
                                      setWebhookEventTypes('');
                                      setWebhookIdempotencyKey(crypto.randomUUID());
                                      setWebhookSecretResult(null);
                                      setWebhookCopied(null);
                                      setWebhookRotationTarget(null);
                                      return;
                                    }
                                    connectProvider.mutate({ provider: provider.provider, scope: 'you', capabilities: providerCapabilitiesForScope(provider, 'you') });
                                  }}
                                  title={personalConnectTitle}
                                >{awaitingProvider ? <><LoaderCircle aria-hidden="true" className="spin" size={13} /> Waiting…</> : 'Connect for me'}</Button>
                              )}
                            {provider.scopes.includes('workspace' as never) && isAdmin && (
                              <Button
                                disabled={workspaceConnectDisabled}
                                onClick={() => {
                                  if (provider.provider === 'granola') {
                                    setGranolaWorkspaceModalOpen(true);
                                    return;
                                  }
                                  if (provider.provider === 'generic_webhook') {
                                    setWebhookModalScope('workspace');
                                    setWebhookDisplayName('Workspace inbound webhook');
                                    setWebhookEventTypes('');
                                    setWebhookIdempotencyKey(crypto.randomUUID());
                                    setWebhookSecretResult(null);
                                    setWebhookCopied(null);
                                    setWebhookRotationTarget(null);
                                    return;
                                  }
                                  connectProvider.mutate({ provider: provider.provider, scope: 'workspace', capabilities: providerCapabilitiesForScope(provider, 'workspace') });
                                }}
                                title={workspaceConnectTitle}
                              >
                                Connect workspace
                              </Button>
                            )}
                          </div>
                        </article>
                      );
                    })}
                    {visibleProviders.length === 0 && <EmptyState title="No connectors here" description="Change the filter to see other available providers." />}
                  </div>
                </div>
                {connectorOAuthMessage && <p className="settings-oauth-status" role="status"><Check aria-hidden="true" size={14} />{connectorOAuthMessage}</p>}
                {(connectorOAuthError || connections.error || connectorCatalog.error || connectProvider.error || createGranolaWorkspaceConnection.error || createWebhookConnection.error || rotateWebhookSecret.error || reconnectConnection.error || testConnection.error || disconnectConnection.error) && (
                  <InlineError>{connectorOAuthError ?? connections.error?.message ?? connectorCatalog.error?.message ?? connectProvider.error?.message ?? createGranolaWorkspaceConnection.error?.message ?? createWebhookConnection.error?.message ?? rotateWebhookSecret.error?.message ?? reconnectConnection.error?.message ?? testConnection.error?.message ?? disconnectConnection.error?.message}</InlineError>
                )}
              </section>
            )}

            {activeSection === 'application' && (
              <section aria-labelledby="settings-title" className="settings-pane">
                <div className="settings-pane-heading"><h2>Security</h2><p>Choose how Avalon protects the saved authentication session on this Mac.</p></div>
                <div className="settings-list-card">
                  <label className="settings-preference-row">
                    <span className="settings-row-icon"><LockKeyhole aria-hidden="true" size={18} /></span>
                    <span className="settings-row-copy">
                      <strong>Lockdown mode</strong>
                      <small>
                        {applicationSettings && !applicationSettings.lockdownAvailable
                          ? applicationSettings.lockdownMode
                            ? 'This Mac’s keystore is unavailable. Turn off Lockdown mode to keep using the loaded session.'
                            : 'Lockdown mode is off because this Mac’s keystore is unavailable.'
                          : 'Protect the saved session with this Mac’s keystore instead of Avalon’s shared encryption key.'}
                      </small>
                    </span>
                    <span className="settings-toggle">
                      <input
                        aria-label="Lockdown mode"
                        checked={applicationSettings?.lockdownMode ?? false}
                        disabled={
                          applicationSettings === null
                          || updateLockdownMode.isPending
                          || (!applicationSettings.lockdownAvailable && !applicationSettings.lockdownMode)
                        }
                        onChange={(event) => updateLockdownMode.mutate(event.currentTarget.checked)}
                        role="switch"
                        type="checkbox"
                      />
                      <span aria-hidden="true" />
                    </span>
                  </label>
                </div>
                {(applicationSettingsLoadError || updateLockdownMode.error) && (
                  <InlineError>{applicationSettingsLoadError ?? updateLockdownMode.error?.message}</InlineError>
                )}
                <div className="settings-pane-heading settings-pane-heading-spaced"><h2>Appearance</h2><p>Make Avalon feel at home on this Mac.</p></div>
                <ApplicationIconPicker />
                <div className="settings-pane-heading settings-pane-heading-spaced"><h2>Developer</h2><p>Extra tooling for reporting and diagnosing problems.</p></div>
                <div className="settings-list-card">
                  <label className="settings-preference-row">
                    <span className="settings-row-icon"><Wrench aria-hidden="true" size={18} /></span>
                    <span className="settings-row-copy">
                      <strong>Debug enabled</strong>
                      <small>Show debugging actions such as copying a work stream or automation identifier from its right-click menu, and the rows describing how a work stream is wired in its Details.</small>
                    </span>
                    <span className="settings-toggle">
                      <input
                        aria-label="Debug enabled"
                        checked={applicationSettings?.debugEnabled ?? false}
                        /* A Lockdown transition re-encrypts every durable session
                         * component, so it stays pending long enough to click this.
                         * Both preferences write one file; keep one in flight. */
                        disabled={
                          applicationSettings === null
                          || updateDebugEnabled.isPending
                          || updateLockdownMode.isPending
                        }
                        onChange={(event) => updateDebugEnabled.mutate(event.currentTarget.checked)}
                        role="switch"
                        type="checkbox"
                      />
                      <span aria-hidden="true" />
                    </span>
                  </label>
                </div>
                {updateDebugEnabled.error && <InlineError>{updateDebugEnabled.error.message}</InlineError>}
                <div className="settings-pane-heading settings-pane-heading-spaced"><h2>About</h2><p>Build and service details for this Avalon installation.</p></div>
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
        <Modal
          description={webhookRotationTarget
            ? 'Rotate the endpoint signing secret. The previous secret stops working immediately.'
            : `Create a ${webhookModalScope === 'workspace' ? 'workspace' : 'personal'} signed activity endpoint.`}
          footer={webhookSecretResult ? (
            <Button className="button-primary" onClick={() => setWebhookModalScope(null)}>Done</Button>
          ) : (
            <>
              <Button onClick={() => setWebhookModalScope(null)}>Cancel</Button>
              {webhookRotationTarget ? (
                <Button
                  className="button-primary"
                  disabled={rotateWebhookSecret.isPending}
                  onClick={() => rotateWebhookSecret.mutate(webhookRotationTarget)}
                >
                  {rotateWebhookSecret.isPending && <LoaderCircle aria-hidden="true" className="spin" size={14} />}
                  Rotate secret
                </Button>
              ) : (
                <Button
                  className="button-primary"
                  disabled={!webhookDisplayName.trim() || createWebhookConnection.isPending}
                  onClick={() => createWebhookConnection.mutate()}
                >
                  {createWebhookConnection.isPending && <LoaderCircle aria-hidden="true" className="spin" size={14} />}
                  Create webhook
                </Button>
              )}
            </>
          )}
          onOpenChange={(open) => {
            if (open || createWebhookConnection.isPending || rotateWebhookSecret.isPending) return;
            setWebhookModalScope(null);
            setWebhookRotationTarget(null);
            setWebhookSecretResult(null);
            setWebhookCopied(null);
          }}
          open={webhookModalScope !== null}
          title={webhookRotationTarget ? `Rotate ${webhookDisplayName}` : 'Create inbound webhook'}
        >
          {webhookSecretResult ? (
            <div className="settings-list-card">
              <p>Copy the endpoint and secret now. Avalon will not show this secret again.</p>
              <label className="form-field">
                <span>Endpoint</span>
                <input aria-label="Webhook endpoint" readOnly spellCheck={false} value={webhookSecretResult.endpoint} />
              </label>
              <Button onClick={() => {
                void bridge.copyText(webhookSecretResult.endpoint);
                setWebhookCopied('endpoint');
              }}>
                {webhookCopied === 'endpoint' ? <Check aria-hidden="true" size={14} /> : <Copy aria-hidden="true" size={14} />}
                {webhookCopied === 'endpoint' ? 'Endpoint copied' : 'Copy endpoint'}
              </Button>
              <label className="form-field">
                <span>Signing secret</span>
                <input aria-label="Webhook signing secret" readOnly spellCheck={false} type="password" value={webhookSecretResult.signingSecret} />
              </label>
              <Button onClick={() => {
                void bridge.copyText(webhookSecretResult.signingSecret);
                setWebhookCopied('secret');
              }}>
                {webhookCopied === 'secret' ? <Check aria-hidden="true" size={14} /> : <Copy aria-hidden="true" size={14} />}
                {webhookCopied === 'secret' ? 'Secret copied' : 'Copy secret'}
              </Button>
              <small>Sign the exact UTF-8 JSON bytes using: <code>{webhookSecretResult.signatureFormat}</code></small>
            </div>
          ) : webhookRotationTarget ? (
            <p>Update the sender as soon as you rotate. Deliveries signed with the current secret will be rejected.</p>
          ) : (
            <>
              <label className="form-field" htmlFor="webhook-display-name">
                <span>Name</span>
                <input
                  autoFocus
                  id="webhook-display-name"
                  maxLength={180}
                  onChange={(event) => setWebhookDisplayName(event.currentTarget.value)}
                  value={webhookDisplayName}
                />
              </label>
              <label className="form-field" htmlFor="webhook-event-types">
                <span>Allowed event types <small>(optional)</small></span>
                <input
                  id="webhook-event-types"
                  onChange={(event) => setWebhookEventTypes(event.currentTarget.value)}
                  placeholder="ticket.updated, incident.created"
                  value={webhookEventTypes}
                />
                <small>Separate names with commas or spaces. Leave empty to accept any valid event type.</small>
              </label>
            </>
          )}
          {(createWebhookConnection.error || rotateWebhookSecret.error) && (
            <InlineError>{createWebhookConnection.error?.message ?? rotateWebhookSecret.error?.message}</InlineError>
          )}
        </Modal>
        <Modal
          description="A workspace-wide Granola connection requires a Workspace API key. Personal Granola connections use browser sign-in and do not need a key."
          footer={(
            <>
              <Button onClick={() => setGranolaWorkspaceModalOpen(false)}>Cancel</Button>
              <Button
                className="button-primary"
                disabled={!/^grn_[\x21-\x7E]{1,508}$/u.test(granolaWorkspaceApiKey.trim()) || createGranolaWorkspaceConnection.isPending}
                onClick={() => createGranolaWorkspaceConnection.mutate()}
              >
                {createGranolaWorkspaceConnection.isPending ? <LoaderCircle aria-hidden="true" className="spin" size={14} /> : <LockKeyhole aria-hidden="true" size={14} />}
                Connect workspace
              </Button>
            </>
          )}
          onOpenChange={(open) => {
            setGranolaWorkspaceModalOpen(open);
            if (!open && !createGranolaWorkspaceConnection.isPending) setGranolaWorkspaceApiKey('');
          }}
          open={granolaWorkspaceModalOpen}
          title="Connect Granola workspace"
        >
          <section aria-labelledby="granola-key-guide-title" className="granola-key-guide">
            <h3 id="granola-key-guide-title">Generate the key in Granola</h3>
            <ol>
              <li>Open the Granola desktop app as a workspace administrator.</li>
              <li>Go to Settings → Connectors → Workspace API keys.</li>
              <li>Choose Create new key.</li>
              <li>Copy the new key, then paste it below.</li>
            </ol>
            <p>Workspace API keys require a Business or Enterprise plan. They can read public notes and spaces where Granola API access is enabled, but not other private notes.</p>
            <button
              className="granola-key-guide-link"
              onClick={() => void bridge.openExternal('https://docs.granola.ai/help-center/sharing/integrations/granola-api')}
              type="button"
            >
              Open Granola’s API key guide ↗
            </button>
          </section>
          <label className="form-field" htmlFor="granola-workspace-api-key">
            <span>Workspace API key</span>
            <input
              aria-label="Workspace API key"
              autoComplete="off"
              autoFocus
              className="granola-key-input"
              id="granola-workspace-api-key"
              onChange={(event) => setGranolaWorkspaceApiKey(event.currentTarget.value)}
              placeholder="grn_…"
              spellCheck={false}
              type="password"
              value={granolaWorkspaceApiKey}
            />
            <small>Avalon sends the key once to your regional API, encrypts it at rest, never returns it to the desktop, and registers a signed note-events webhook.</small>
          </label>
          {createGranolaWorkspaceConnection.error && <InlineError>{createGranolaWorkspaceConnection.error.message}</InlineError>}
        </Modal>
        <Modal
          description="You’ll be sent to the provider to authorize this connection again."
          footer={(
            <>
              <Button onClick={() => setReconnectTarget(null)}>Cancel</Button>
              <Button
                className="button-primary"
                onClick={() => {
                  if (!reconnectTarget) return;
                  reconnectConnection.mutate(reconnectTarget);
                  setReconnectTarget(null);
                }}
              >
                <RefreshCcw aria-hidden="true" size={14} /> Re-connect
              </Button>
            </>
          )}
          onOpenChange={(open) => {
            if (!open) setReconnectTarget(null);
          }}
          open={Boolean(reconnectTarget)}
          title={`Do you want to re-connect ${reconnectTarget?.displayName ?? 'this app'}?`}
        />
      </div>
    </div>
  );
}
