import { AshbyWorkspaceSetup, ConnectorInstallationDetails, useWorkspaceInstallationRecovery } from '../components/connector-installation';
import { ConnectorApiKeyField, ConnectorApiKeyIssuingLink } from '../components/connector-api-key-field';
import { CopyButton, CopyField } from '../components/copy-button';
import { ServerCog } from 'lucide-react';
import { connectorProviders, PERSONAL_CONNECT_LABEL } from '../lib/connector-catalog';
import { PersonalSetup } from './guided-onboarding';
import { githubAvailabilityLabels, githubRemoteLabels, mcpAuthLabels } from '../settings/choices';
import { SettingToggle } from '../settings/setting-toggle';
import { settings, collectSettings, coreSettingsProvider, defineSetting, isSettingAvailable, searchSettings, type SettingSearchResult, type SettingsSearchContext } from '../settings/registry';
import { SettingCopy, SettingLabel } from '../settings/setting-label';
import { SettingsSearchResults, useRevealSetting } from '../settings/search-results';
import { SidebarSearch } from '../components/sidebar-search';
import { digestDeliverySetting } from '../settings/digest-provider';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Tooltip from '@radix-ui/react-tooltip';
import {
  GitBranch,
  Globe,
  LockKeyhole,
  LoaderCircle,
  MailPlus,
  MonitorCog,
  Newspaper,
  Bell,
  Plug,
  RefreshCcw,
  Search,
  ShieldCheck,
  Trash2,
  UserRound,
  Users,
  Wifi,
  X,
  type LucideIcon,
} from 'lucide-react';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from 'react';
import { ConnectorInstallationProviders, connectorApiKeyAcceptable } from '@rally/contracts';
import type {
  ConnectorOAuthStart,
  CustomMcpToolPolicy,
} from '@rally/contracts';
import { parseDesktopSettingsSection } from '../../common/settings';
import type { DesktopSettingsSection } from '../../common/settings';
import type { DesktopApplicationSettings } from '../../common/desktop';
import { parseDesktopReleaseChannel, type DesktopReleaseChannel } from '../../common/release-channels';
import { Avatar, Badge, Button, ConnectorMark, DropdownSelect, EmptyState, InlineError, Modal, SegmentedControl } from '../components/primitives';
import { connectorBrandMark } from '../lib/plugin-marks';
import { ApplicationIconPicker } from '../components/application-icon-picker';
import { ThemePicker } from '../components/theme-picker';
import { DigestSettings } from '../components/digest-settings';
import { useAppSession } from '../lib/app-session';
import { invalidateCachedWorkstreamDetails } from '../lib/workstreams-cache';
import { ApiError } from '../lib/api';
import { useClientFeatureFlags } from '../lib/use-client-feature-flags';
import { desktopBridge } from '../lib/platform';
import { useOptionalWorkspaceSocket } from '../lib/workspace-socket';
import { useEscapeClosesWindow } from '../lib/window-escape';
import type {
  GitHubRepositoryAccessSettings,
  TerminalNetworkPolicyPreview,
  TerminalWorkspaceSettings,
  Workspace,
  WorkspaceInvitation,
  WorkstreamConnection,
} from '../lib/types';

type SettingsSection = DesktopSettingsSection;
type ConnectionFilter = 'all' | 'connected' | 'not_connected';

/**
 * Whether Rally manages this provider's workspace event subscriptions.
 *
 * Read off the contract's own enum rather than written out here: five places on
 * this screen asked the same question and each held its own copy of the list, so
 * a connector added to the contract and missed in one of them produced a button
 * that was silently wrong rather than a type error.
 */
const installationProviders = new Set<string>(ConnectorInstallationProviders);
function hasInstallationFacet(connectorType: string): boolean {
  return installationProviders.has(connectorType);
}

/**
 * Whether this screen still manages that provider's workspace events.
 *
 * `hasInstallationFacet` says the provider has an installation at all, which
 * stays true of a connection a workspace already made. This says the product
 * still offers the surface: a connector the catalog no longer connects for a
 * workspace — Fireflies, whose one key reads every member's meetings — keeps
 * receiving its events without offering anybody a webhook console for them.
 */
function hasWorkspaceInstallationSurface(connectorType: string): boolean {
  if (!hasInstallationFacet(connectorType)) return false;
  const provider = connectorProviders.find((candidate) => candidate.provider === connectorType);
  return provider?.scopes.includes('workspace' as never) ?? false;
}

const reconnectableConnectorTypes = new Set<WorkstreamConnection['connectorType']>([
  'ashby',
  'fireflies',
  'google',
  'github',
  'granola',
  'linear',
  'notion',
  'slack',
]);

const installedConnectorTypes = new Set<WorkstreamConnection['connectorType']>([
  ...reconnectableConnectorTypes,
  'custom_mcp',
  'generic_webhook',
  'x',
]);

function ConnectorButton({
  label,
  tooltip,
  disabled = false,
  onClick,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; tooltip: string }): React.JSX.Element {
  const [tooltipOpen, setTooltipOpen] = useState(false);
  const button = (
    <Button
      {...props}
      aria-hidden={disabled || undefined}
      aria-label={label}
      disabled={disabled}
      onClick={(event) => {
        setTooltipOpen(false);
        onClick?.(event);
      }}
    />
  );
  return (
    <Tooltip.Root delayDuration={300} onOpenChange={setTooltipOpen} open={tooltipOpen}>
      <Tooltip.Trigger asChild>
        {disabled ? (
          <span
            aria-disabled="true"
            aria-label={label}
            className="provider-action-tooltip-trigger"
            role="button"
            tabIndex={0}
          >
            {button}
          </span>
        ) : button}
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content className="tooltip settings-connection-tooltip" side="top" sideOffset={6}>
          {tooltip}
          <Tooltip.Arrow className="tooltip-arrow" />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

function ConnectionIconAction({
  label,
  tooltip,
  icon,
  disabled = false,
  onClick,
  ...props
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'aria-label'> & {
  label: string;
  tooltip: string;
  icon: ReactNode;
}): React.JSX.Element {
  const [tooltipOpen, setTooltipOpen] = useState(false);
  const button = (
    <button
      aria-hidden={disabled || undefined}
      aria-label={label}
      className="settings-icon-action"
      disabled={disabled}
      onClick={(event) => {
        setTooltipOpen(false);
        onClick?.(event);
      }}
      type="button"
      {...props}
    >
      {icon}
    </button>
  );
  return (
    <Tooltip.Root delayDuration={300} onOpenChange={setTooltipOpen} open={tooltipOpen}>
      <Tooltip.Trigger asChild>
        {disabled ? (
          <span
            aria-disabled="true"
            aria-label={label}
            className="settings-icon-tooltip-trigger"
            role="button"
            tabIndex={0}
          >
            {button}
          </span>
        ) : button}
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content className="tooltip settings-connection-tooltip" side="top" sideOffset={6}>
          {tooltip}
          <Tooltip.Arrow className="tooltip-arrow" />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

interface SettingsNavItem {
  id: SettingsSection;
  label: string;
  icon: LucideIcon;
  child?: boolean;
}

const settingsNavigation: Array<{ label: string; items: SettingsNavItem[] }> = [
  {
    label: 'Settings',
    items: [
      { id: 'account', label: 'Account', icon: UserRound },
      // Directly under Account, because a digest is a personal preference like
      // the timezone it borrows — not a workspace-level setting.
      { id: 'digest', label: 'Digest', icon: Newspaper },
      { id: 'notifications', label: 'Notifications', icon: Bell },
      { id: 'workspace', label: 'Workspace', icon: Users },
      // Under Workspace rather than beside it: the Terminal egress policy is a
      // workspace-wide setting, but it is a page of its own — a review-then-
      // confirm flow that stops running sandboxes, which does not belong in the
      // middle of a list of names, timezones and invitations.
      { id: 'internet-access', label: 'Internet access', icon: Globe, child: true },
      { id: 'connections', label: 'Connections', icon: Plug },
    ],
  },
  {
    label: 'Desktop app',
    items: [
      { id: 'application', label: 'Application', icon: MonitorCog },
    ],
  },
];


function providerSetting(provider: { id: string; name: string; description: string; scopes: readonly string[] }, admin: boolean) {
  return defineSetting({
    id: 'provider:' + provider.id, section: 'connections', kind: 'custom',
    label: provider.name, description: provider.description,
    options: [
      ...(provider.scopes.includes('you') ? [PERSONAL_CONNECT_LABEL] : []),
      ...(admin && provider.scopes.includes('workspace') ? ['Connect for workspace'] : []),
      'Setup', 'Authorization',
    ],
  });
}
function connectionSetting(connection: WorkstreamConnection, admin: boolean) {
  return defineSetting({
    id: 'connection:' + connection.id, section: 'connections', kind: 'custom',
    label: connection.displayName, description: 'Manage this installed connection.',
    options: [
      ...(admin && reconnectableConnectorTypes.has(connection.connectorType)
        && !(hasInstallationFacet(connection.connectorType) && connection.scope === 'workspace') ? ['Refresh', 'Reconnect'] : []),
      ...(connection.scope === 'you' || admin ? ['Delete', 'Disconnect'] : []),
      ...(admin && connection.connectorType === 'generic_webhook' ? ['Refresh', 'Webhook signing secret'] : []),
    ],
  });
}
const supportedTimezones = typeof Intl.supportedValuesOf === 'function'
  ? Intl.supportedValuesOf('timeZone')
  : ['America/Los_Angeles', 'Europe/London', 'UTC'];



/**
 * The mark an installed connection wears, or nothing.
 *
 * A row reaches the mark from the connector type it already carries, which is
 * the same route the provider card above it takes — so the card somebody
 * connected from and the row it produced always show the same company. An
 * inbound webhook is not a company and draws no mark; the status dot and the
 * name carry the row on their own.
 */
function InstalledConnectionMark({ connection }: { connection: WorkstreamConnection }): React.JSX.Element | null {
  const mark = connectorBrandMark(connection.connectorType, connection.displayName);
  return mark ? <ConnectorMark mark={mark} /> : null;
}

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
  return provider.scopes.some((scope) => providerHasConnectionForScope(provider, connections, scope));
}

function providerHasConnectionForScope(
  provider: (typeof connectorProviders)[number],
  connections: WorkstreamConnection[],
  scope: 'you' | 'workspace',
): boolean {
  const capabilities = providerCapabilitiesForScope(provider, scope);
  return connections.some((connection) =>
    connection.connectorType === provider.provider &&
    connection.scope === scope &&
    (capabilities.length === 0 || capabilities.some((capability) => connection.capabilities?.includes(capability))),
  );
}

/**
 * Whether one of these is ever enough.
 *
 * Every other card names one provider, so a second connection to it is a
 * second account and the card says "already installed". A custom MCP card
 * names no server at all — the whole point is that a workspace connects
 * several — so the card stays offering another one however many exist.
 */
function providerAllowsManyConnections(
  provider: (typeof connectorProviders)[number],
): boolean {
  return provider.provider === 'custom_mcp';
}

function providerHasAvailableUnconnectedScope(
  provider: (typeof connectorProviders)[number],
  connections: WorkstreamConnection[],
  isAdmin: boolean,
): boolean {
  if (providerAllowsManyConnections(provider)) {
    return provider.scopes.some((scope) => scope === 'you' || isAdmin);
  }
  return provider.scopes.some((scope) =>
    (scope === 'you' || isAdmin) && !providerHasConnectionForScope(provider, connections, scope),
  );
}

function providerHasActiveWorkspaceConnection(
  provider: (typeof connectorProviders)[number],
  connections: WorkstreamConnection[],
): boolean {
  if (providerAllowsManyConnections(provider)) return false;
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
  return (provider.provider === 'x' || hasInstallationFacet(provider.provider)) && connections.some((connection) =>
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

export function WorkspaceSettingsScreen({
  standaloneWindow = false,
  workspace,
}: { standaloneWindow?: boolean; workspace: Workspace }): React.JSX.Element {
  const {
    api,
    runtime,
    leaveWorkspace,
    signOut,
    pendingConnectorOAuth,
    setPendingConnectorOAuth,
  } = useAppSession();
  const workspaceSocket = useOptionalWorkspaceSocket();
  const featureFlags = useClientFeatureFlags(api);
  // Fails open: `digestsEnabled` defaults `true` and only an explicit `false`
  // hides the section, so a stale cache entry, an unbound Flagship, or the
  // brief window before the first fetch resolves all show the section rather
  // than hiding someone's own saved settings for no reason they could find.
  const digestSettingsAvailable = featureFlags.data?.digestsEnabled !== false;
  const queryClient = useQueryClient();
  const bridge = useMemo(() => desktopBridge(), []);
  const contentRef = useRef<HTMLElement | null>(null);
  const webhookRefreshCancelRef = useRef<HTMLButtonElement | null>(null);
  const reconnectCancelRef = useRef<HTMLButtonElement | null>(null);
  const disconnectCancelRef = useRef<HTMLButtonElement | null>(null);
  const [activeSection, setActiveSection] = useState<SettingsSection>(initialSettingsSection);
  const [navigationQuery, setNavigationQuery] = useState('');
  const [connectionFilter, setConnectionFilter] = useState<ConnectionFilter>('not_connected');
  const [githubSettingsConnectionId, setGitHubSettingsConnectionId] = useState<string | null>(null);
  const [githubRepositorySearch, setGitHubRepositorySearch] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'admin' | 'member'>('member');
  const [createdUrl, setCreatedUrl] = useState<string | null>(null);
  const [createdDelivery, setCreatedDelivery] = useState<'sent' | 'skipped' | null>(null);
  const [userTimezone, setUserTimezone] = useState(workspace.currentUser.timezone);
  const [workspaceTimezone, setWorkspaceTimezone] = useState(workspace.timezone);
  const [terminalMode, setTerminalMode] = useState<'trusted_only' | 'full_internet'>('trusted_only');
  const [terminalDomains, setTerminalDomains] = useState('');
  const [terminalPreview, setTerminalPreview] = useState<TerminalNetworkPolicyPreview | null>(null);
  const terminalPolicyDirty = useRef(false);
  const [applicationSettings, setApplicationSettings] = useState<DesktopApplicationSettings | null>(null);
  // Full settings arrive through two independent Electron channels: live
  // events and replies to reads or mutations. A live event supersedes any
  // operation that was already in flight when it arrived.
  const applicationSettingsLiveGeneration = useRef(0);
  const [applicationSettingsLoadError, setApplicationSettingsLoadError] = useState<string | null>(null);
  const [reconnectTarget, setReconnectTarget] = useState<WorkstreamConnection | null>(null);
  const [disconnectTarget, setDisconnectTarget] = useState<WorkstreamConnection | null>(null);
  const [granolaWorkspaceModalOpen, setGranolaWorkspaceModalOpen] = useState(false);
  const [ashbySetupKey, setAshbySetupKey] = useState(() => crypto.randomUUID());
  const [ashbyWorkspaceOpen, setAshbyWorkspaceOpen] = useState(false);
  const [installationTarget, setInstallationTarget] = useState<string | null>(null);
  const [granolaSetupKey, setGranolaSetupKey] = useState(() => crypto.randomUUID());
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
  const [webhookRotationTarget, setWebhookRotationTarget] = useState<WorkstreamConnection | null>(null);
  const [customMcpModalScope, setCustomMcpModalScope] = useState<'you' | 'workspace' | null>(null);
  const [customMcpName, setCustomMcpName] = useState('');
  const [customMcpServerUrl, setCustomMcpServerUrl] = useState('');
  const [customMcpAuthMode, setCustomMcpAuthMode] = useState<'oauth' | 'headers'>('oauth');
  const [customMcpHeaders, setCustomMcpHeaders] = useState<Array<{ name: string; value: string }>>(
    [{ name: '', value: '' }],
  );
  const [customMcpToolPolicy, setCustomMcpToolPolicy] = useState<CustomMcpToolPolicy>('all_tools');
  const [customMcpSettingsConnectionId, setCustomMcpSettingsConnectionId] = useState<string | null>(null);
  const [leaveConfirmationOpen, setLeaveConfirmationOpen] = useState(false);
  const timezoneOptions = useMemo(
    () => [...new Set([...supportedTimezones, userTimezone, workspaceTimezone])].sort(),
    [userTimezone, workspaceTimezone],
  );
  const isAdmin = workspace.currentUser.role === 'owner' || workspace.currentUser.role === 'admin';
  // `staleTime` rather than `refetchOnMount: 'always'`, and the difference is a
  // whole round trip: `App.tsx` holds this same key at `staleTime: Infinity` for
  // the shell's own use, so opening Settings always found data this observer had
  // to force past. Staleness is per observer, so 30s here already refetches a
  // list the shell has been sitting on — what `'always'` added was a second
  // `/workspace/members` for a list fetched milliseconds earlier by the boot
  // this screen is mounting inside of.
  const members = useQuery({
    queryKey: ['workspace-members'],
    queryFn: ({ signal }) => api!.getWorkspaceMembers(signal),
    enabled: Boolean(api),
    staleTime: 30_000,
  });
  const leavingClosesWorkspace = members.data?.length === 1;
  const departWorkspace = useMutation({
    mutationFn: () => leaveWorkspace(workspace.id, leavingClosesWorkspace ? 'abandoned' : 'left'),
    onSuccess: () => setLeaveConfirmationOpen(false),
  });
  const invitations = useQuery({
    queryKey: ['workspace-invitations'],
    queryFn: ({ signal }) => api!.getWorkspaceInvitations(signal),
    enabled: Boolean(api && isAdmin),
    staleTime: 10_000,
  });
  // Refetched when this window is focused, because authorizing a connector
  // happens in a browser and returning here is the moment the answer exists.
  // `true` and not `'always'`: `'always'` ignores `staleTime`, and this window
  // is *shown* rather than created now — a prewarmed window's reveal raises
  // `visibilitychange`, as does the reveal right after a cold create, so
  // `'always'` spent a second `/connections` on data the mount had just read.
  // Five seconds is long enough to cover that reveal and far shorter than any
  // trip out to a provider and back.
  const connections = useQuery({
    queryKey: ['connections'],
    queryFn: ({ signal }) => api!.getConnections(signal),
    enabled: Boolean(api),
    refetchOnWindowFocus: true,
    staleTime: 5_000,
  });
  const connectionToolCounts = useQueries({
    queries: (connections.data ?? []).map((connection) => ({
      queryKey: ['connection-tool-count', connection.id, connection.capabilities, connection.status],
      queryFn: ({ signal }: { signal: AbortSignal }) => api!.getConnectionToolCount(connection.id, signal),
      enabled: Boolean(api && activeSection === 'connections' && connection.status !== 'disabled'),
      refetchOnWindowFocus: true,
      staleTime: 5_000,
    })),
  });
  const toolCountByConnection = new Map((connections.data ?? []).map((connection, index) => [
    connection.id, connectionToolCounts[index],
  ]));
  const githubSettingsConnections = useMemo(
    () => (connections.data ?? []).filter((connection) => (
      connection.settingsKind === 'github_repository_access'
      && connection.status !== 'disabled'
    )),
    [connections.data],
  );
  const customMcpSettingsConnections = useMemo(
    () => (connections.data ?? []).filter((connection) => (
      connection.settingsKind === 'custom_mcp_tools'
      && connection.status !== 'disabled'
    )),
    [connections.data],
  );
  useEffect(() => {
    if (
      githubSettingsConnectionId
      && githubSettingsConnections.some((connection) => connection.id === githubSettingsConnectionId)
    ) return;
    setGitHubSettingsConnectionId(githubSettingsConnections[0]?.id ?? null);
  }, [githubSettingsConnectionId, githubSettingsConnections]);
  const githubRepositorySettings = useQuery({
    queryKey: ['github-repository-access', githubSettingsConnectionId],
    queryFn: ({ signal }) => api!.getGitHubRepositoryAccessSettings(githubSettingsConnectionId!, signal),
    enabled: Boolean(api && activeSection === 'github' && githubSettingsConnectionId),
    staleTime: 10_000,
  });
  const updateGitHubRepositorySettings = useMutation({
    mutationFn: (next: Pick<GitHubRepositoryAccessSettings, 'mode' | 'defaultRemoteAccess' | 'repositories'>) => (
      api!.updateGitHubRepositoryAccessSettings(githubSettingsConnectionId!, {
        expectedRevision: githubRepositorySettings.data!.revision,
        mode: next.mode,
        defaultRemoteAccess: next.defaultRemoteAccess,
        repositories: next.repositories,
      })
    ),
    onSuccess: (settings) => {
      queryClient.setQueryData(['github-repository-access', settings.connectionId], settings);
    },
    onError: async () => {
      await queryClient.invalidateQueries({ queryKey: ['github-repository-access', githubSettingsConnectionId] });
    },
  });
  useEffect(() => {
    if (
      customMcpSettingsConnectionId
      && customMcpSettingsConnections.some((connection) => connection.id === customMcpSettingsConnectionId)
    ) return;
    setCustomMcpSettingsConnectionId(customMcpSettingsConnections[0]?.id ?? null);
  }, [customMcpSettingsConnectionId, customMcpSettingsConnections]);
  // The catalog is read live from a third-party server on every open, so it is
  // never served from cache: a tool the server withdrew an hour ago is exactly
  // what somebody opening this screen is trying to find out about.
  const customMcpSettings = useQuery({
    queryKey: ['custom-mcp-settings', customMcpSettingsConnectionId],
    queryFn: ({ signal }) => api!.getCustomMcpSettings(customMcpSettingsConnectionId!, signal),
    enabled: Boolean(api && activeSection === 'custom-mcp' && customMcpSettingsConnectionId),
    staleTime: 0,
  });
  const updateCustomMcpToolPolicy = useMutation({
    mutationFn: (toolPolicy: CustomMcpToolPolicy) => (
      api!.updateCustomMcpToolPolicy(customMcpSettingsConnectionId!, toolPolicy)
    ),
    onSuccess: (settings) => {
      queryClient.setQueryData(['custom-mcp-settings', settings.connectionId], settings);
      void queryClient.invalidateQueries({ queryKey: ['connection-tool-count', settings.connectionId] });
    },
    onError: async () => {
      await queryClient.invalidateQueries({ queryKey: ['custom-mcp-settings', customMcpSettingsConnectionId] });
    },
  });
  const terminalSettings = useQuery({
    queryKey: ['terminal-workspace-settings'],
    queryFn: ({ signal }) => api!.getTerminalWorkspaceSettings(signal),
    enabled: Boolean(api && activeSection === 'internet-access'),
    staleTime: 10_000,
  });
  useEffect(() => {
    if (!terminalSettings.data || terminalPreview || terminalPolicyDirty.current) return;
    setTerminalMode(terminalSettings.data.mode);
    setTerminalDomains(terminalSettings.data.customDomains.join('\n'));
  }, [terminalPreview, terminalSettings.data]);
  const terminalCustomDomains = () => [...new Set(
    terminalDomains.split(/[\s,]+/u).map((domain) => domain.trim().toLowerCase().replace(/\.$/u, '')).filter(Boolean),
  )].sort();
  const terminalPolicyChanged = Boolean(terminalSettings.data && (
    terminalMode !== terminalSettings.data.mode
    || terminalCustomDomains().join('\n') !== [...terminalSettings.data.customDomains].sort().join('\n')
  ));
  const terminalDraftRemainingSlots = terminalPreview?.remainingCustomSlots
    ?? (!terminalPolicyChanged ? terminalSettings.data?.remainingCustomSlots : null);
  const [terminalPolicyFailure, setTerminalPolicyFailure] = useState<Array<{
    workstreamId: string;
    title: string;
    outcome: 'stopped' | 'deleted' | 'quarantined';
  }>>([]);
  const previewTerminalPolicy = useMutation({
    mutationFn: () => api!.previewTerminalNetworkPolicy({
      expectedRevision: terminalSettings.data!.revision,
      mode: terminalMode,
      customDomains: terminalCustomDomains(),
    }),
    onSuccess: (preview) => {
      setTerminalPolicyFailure([]);
      setTerminalPreview(preview);
    },
    onError: async () => {
      setTerminalPreview(null);
      await queryClient.invalidateQueries({ queryKey: ['terminal-workspace-settings'] });
    },
  });
  const applyTerminalPolicy = useMutation({
    mutationFn: () => api!.applyTerminalNetworkPolicy({
      mutationId: terminalPreview!.mutationId,
      expectedRevision: terminalPreview!.expectedRevision,
      confirmed: true,
    }),
    onSuccess: (settings: TerminalWorkspaceSettings) => {
      queryClient.setQueryData(['terminal-workspace-settings'], settings);
      terminalPolicyDirty.current = false;
      setTerminalMode(settings.mode);
      setTerminalDomains(settings.customDomains.join('\n'));
      setTerminalPolicyFailure([]);
      setTerminalPreview(null);
    },
    onError: async (error) => {
      const outcomes = error instanceof ApiError
        && typeof error.details === 'object'
        && error.details !== null
        && 'sandboxOutcomes' in error.details
        && Array.isArray((error.details as { sandboxOutcomes?: unknown }).sandboxOutcomes)
        ? (error.details as { sandboxOutcomes: Array<{ workstreamId: string; title: string; outcome: 'stopped' | 'deleted' | 'quarantined' }> }).sandboxOutcomes
        : [];
      setTerminalPolicyFailure(outcomes);
      setTerminalPreview(null);
      await queryClient.invalidateQueries({ queryKey: ['terminal-workspace-settings'] });
    },
  });
  const connectorCatalog = useQuery({
    queryKey: ['connector-catalog'],
    queryFn: ({ signal }) => api!.getAvailableConnectorTypes(signal),
    enabled: Boolean(api),
    staleTime: 30_000,
  });
  const connectProvider = useMutation({
    mutationFn: async (input: { provider: 'ashby' | 'fireflies' | 'google' | 'github' | 'granola' | 'linear' | 'notion' | 'slack' | 'x'; scope: 'you' | 'workspace'; capabilities: string[] }) => {
      if (input.provider === 'x') {
        await api!.createXConnection(input.capabilities);
        return { kind: 'direct' as const };
      }
      const authorization = await api!.startProviderConnection(input.provider, input.scope, input.capabilities);
      await desktopBridge().openExternal(authorization.url);
      return { kind: 'oauth' as const, authorization, provider: input.provider };
    },
    onSuccess: (result) => {
      if (result.kind === 'direct') {
        void queryClient.invalidateQueries({ queryKey: ['connections'] });
        return;
      }
      setPendingConnectorOAuth({
        attemptId: result.authorization.attemptId,
        provider: result.provider,
        region: workspace.region,
        workspaceId: workspace.id,
      });
    },
  });
  const granolaRecovery = useWorkspaceInstallationRecovery(api, 'granola', (connectionId) => {
    setGranolaWorkspaceApiKey('');
    setGranolaSetupKey(crypto.randomUUID());
    setGranolaWorkspaceModalOpen(false);
    setInstallationTarget(connectionId);
  });
  const createGranolaWorkspaceConnection = useMutation({
    mutationFn: () => api!.createGranolaWorkspaceConnection(granolaWorkspaceApiKey.trim(), granolaSetupKey),
    onSuccess: () => {
      setGranolaWorkspaceApiKey('');
      setGranolaSetupKey(crypto.randomUUID());
      setGranolaWorkspaceModalOpen(false);
      void queryClient.invalidateQueries({ queryKey: ['connections'] });
    },
    onError: () => granolaRecovery.mutate(),
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
  const customMcpRequestHeaders = (): Record<string, string> => Object.fromEntries(
    customMcpHeaders
      .map((header) => [header.name.trim(), header.value.trim()] as const)
      .filter(([name, value]) => name.length > 0 && value.length > 0),
  );
  const customMcpFormComplete = Boolean(
    customMcpName.trim()
    && /^https:\/\/\S+$/u.test(customMcpServerUrl.trim())
    && (customMcpAuthMode === 'oauth' || Object.keys(customMcpRequestHeaders()).length > 0),
  );
  const connectCustomMcp = useMutation({
    mutationFn: async () => {
      const scope = customMcpModalScope ?? 'you';
      const input = {
        displayName: customMcpName.trim(),
        scope,
        serverUrl: customMcpServerUrl.trim(),
        toolPolicy: scope === 'workspace' ? customMcpToolPolicy : ('all_tools' as const),
      };
      if (customMcpAuthMode === 'headers') {
        await api!.createCustomMcpConnection({ ...input, requestHeaders: customMcpRequestHeaders() });
        return { kind: 'direct' as const };
      }
      const authorization = await api!.startCustomMcpConnection(input);
      await desktopBridge().openExternal(authorization.url);
      return { kind: 'oauth' as const, authorization };
    },
    onSuccess: (result) => {
      setCustomMcpModalScope(null);
      if (result.kind === 'direct') {
        void queryClient.invalidateQueries({ queryKey: ['connections'] });
        return;
      }
      setPendingConnectorOAuth({
        attemptId: result.authorization.attemptId,
        provider: 'custom_mcp',
        region: workspace.region,
        workspaceId: workspace.id,
      });
    },
  });
  const rotateWebhookSecret = useMutation({
    mutationFn: (connection: WorkstreamConnection) => api!.rotateWebhookSecret(connection.id),
    onSuccess: (result) => setWebhookSecretResult(result),
  });
  const reconnectConnection = useMutation({
    mutationFn: async (connection: WorkstreamConnection) => {
      const provider = ['google', 'github', 'linear', 'notion', 'slack'].includes(connection.connectorType)
        ? connection.connectorType as 'google' | 'github' | 'linear' | 'notion' | 'slack'
        : undefined;
      const authorization: ConnectorOAuthStart = await api!.reconnectConnection(
        connection.id,
        provider,
        connection.scope,
        connection.capabilities?.length ?? 0,
      );
      const attempt = await api!.getConnectorOAuthAttempt(authorization.attemptId);
      await desktopBridge().openExternal(authorization.url);
      return { authorization, provider: attempt.provider };
    },
    onSuccess: ({ authorization, provider }) => setPendingConnectorOAuth({
      attemptId: authorization.attemptId,
      provider,
      region: workspace.region,
      workspaceId: workspace.id,
    }),
  });
  const disconnectConnection = useMutation({
    mutationFn: (id: string) => api!.disconnectConnection(id),
    onSuccess: () => {
      setDisconnectTarget(null);
      return queryClient.invalidateQueries({ queryKey: ['connections'] });
    },
  });
  const createInvitation = useMutation({
    mutationFn: () => api!.createWorkspaceInvitation(email.trim(), role),
    onSuccess: (result) => {
      setCreatedUrl(result.inviteUrl);
      setCreatedDelivery(result.emailDelivery);
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
  const applyApplicationSettingsMutation = (
    settings: DesktopApplicationSettings,
    _requested: unknown,
    liveGenerationAtStart: number | undefined,
  ): void => {
    if (liveGenerationAtStart !== applicationSettingsLiveGeneration.current) return;
    setApplicationSettings(settings);
    setApplicationSettingsLoadError(null);
  };
  const updateLockdownMode = useMutation({
    mutationFn: (enabled: boolean) => bridge.setLockdownMode(enabled),
    onMutate: () => applicationSettingsLiveGeneration.current,
    onSuccess: applyApplicationSettingsMutation,
  });
  const updateDebugEnabled = useMutation({
    mutationFn: (enabled: boolean) => bridge.setDebugEnabled(enabled),
    onMutate: () => applicationSettingsLiveGeneration.current,
    onSuccess: applyApplicationSettingsMutation,
  });
  const updatePushNotifications = useMutation({
    mutationFn: (enabled: boolean) => bridge.setPushNotificationsEnabled(enabled),
    onMutate: () => applicationSettingsLiveGeneration.current,
    onSuccess: applyApplicationSettingsMutation,
  });
  const updateMenuBarEnabled = useMutation({
    mutationFn: (enabled: boolean) => bridge.setMenuBarEnabled(enabled),
    onMutate: () => applicationSettingsLiveGeneration.current,
    onSuccess: applyApplicationSettingsMutation,
  });
  const updateLaunchAtLogin = useMutation({
    mutationFn: (enabled: boolean) => bridge.setLaunchAtLogin(enabled),
    onMutate: () => applicationSettingsLiveGeneration.current,
    onSuccess: applyApplicationSettingsMutation,
  });
  const updateProductAnalytics = useMutation({
    mutationFn: (enabled: boolean) => bridge.setProductAnalyticsEnabled(enabled),
    onMutate: () => applicationSettingsLiveGeneration.current,
    onSuccess: applyApplicationSettingsMutation,
  });
  const updateReleaseChannel = useMutation({
    mutationFn: (channel: DesktopReleaseChannel) => bridge.setReleaseChannel(channel),
    onMutate: () => applicationSettingsLiveGeneration.current,
    onSuccess: applyApplicationSettingsMutation,
  });
  const pendingInvitations = useMemo(
    () => (invitations.data ?? []).filter((invitation) => invitation.status === 'pending'),
    [invitations.data],
  );
  const previousInvitations = useMemo(
    () => (invitations.data ?? []).filter((invitation) => invitation.status !== 'pending'),
    [invitations.data],
  );
  const developerSettingsAvailable = applicationSettings?.developerSettingsAvailable ?? false;
  const settingsNavigationWithConnectors = useMemo(() => settingsNavigation.map((group) => {
    const withGithub = group.label !== 'Settings' || githubSettingsConnections.length === 0
      ? group
      : {
          ...group,
          items: group.items.flatMap((item) => item.id === 'connections'
            ? [item, {
                id: 'github' as const,
                label: 'GitHub',
                icon: GitBranch,
                child: true,
              }]
            : [item]),
        };
    // Beneath Connections like GitHub's, and only once a server is connected:
    // a pane whose whole content is one server's live tool catalog has nothing
    // to say until there is a server.
    const withCustomMcp = group.label !== 'Settings' || customMcpSettingsConnections.length === 0
      ? withGithub
      : {
          ...withGithub,
          items: withGithub.items.flatMap((item) => item.id === 'connections'
            ? [item, {
                id: 'custom-mcp' as const,
                label: 'MCP tools',
                icon: ServerCog,
                child: true,
              }]
            : [item]),
        };
    // Dropped from the list entirely rather than shown disabled: their digest
    // has in fact stopped arriving (`fireDigestSchedule` reads this same flag
    // and returns `flag_disabled`), but there is no copy in this screen for a
    // paused state, and an absent section is still an honest answer to "is
    // this available to me."
    return { ...withCustomMcp, items: withCustomMcp.items.filter((item) =>
      (item.id !== 'digest' || digestSettingsAvailable)
      && (item.id !== 'notifications' || featureFlags.data?.pushNotificationsEnabled === true)) };
  }), [githubSettingsConnections.length, customMcpSettingsConnections.length, digestSettingsAvailable, featureFlags.data?.pushNotificationsEnabled]);
  const availableSections = useMemo(
    () => new Set(settingsNavigationWithConnectors.flatMap((group) => group.items.map((item) => item.id))),
    [settingsNavigationWithConnectors],
  );
  const settingsContext = useMemo<SettingsSearchContext>(() => ({
    sections: availableSections,
    admin: isAdmin,
    developer: developerSettingsAvailable,
    menuBar: applicationSettings?.menuBarAvailable !== false,
    login: applicationSettings?.launchAtLoginAvailable !== false,
    releaseChannel: applicationSettings?.releaseChannelAvailable !== false,
  }), [availableSections, isAdmin, developerSettingsAvailable, applicationSettings?.menuBarAvailable, applicationSettings?.launchAtLoginAvailable, applicationSettings?.releaseChannelAvailable]);
  const [searchTarget, setSearchTarget] = useState<SettingSearchResult | null>(null);
  const searchEntries = useMemo(() => collectSettings([
    {
      id: 'digest-destinations',
      entries: (connections.data ?? []).filter((connection) => connection.userDelivery)
        .map((connection) => {
          const definition = digestDeliverySetting(connection);
          return { key: definition.id, definition };
        }),
    },
    { ...coreSettingsProvider, entries: coreSettingsProvider.entries.filter((entry) =>
      entry.definition.section !== 'github' && entry.definition.section !== 'custom-mcp')
      .map((entry) => ({ ...entry, instanceLabel: connectorProviders.find((provider) =>
        'provider:' + provider.id === entry.definition.entryPoint)?.name })) },
    {
      id: 'connected-settings',
      entries: [...githubSettingsConnections, ...customMcpSettingsConnections].flatMap((connection) =>
        coreSettingsProvider.entries.filter((entry) => entry.definition.section ===
          (connection.settingsKind === 'github_repository_access' ? 'github' : 'custom-mcp'))
          .map((entry) => ({ ...entry, key: entry.key + ':' + connection.id,
            instanceId: connection.id, instanceLabel: connection.displayName }))),
    },
    {
      id: 'connector-catalog',
      entries: connectorProviders.map((provider) => ({
        key: 'provider:' + provider.id, definition: providerSetting(provider, isAdmin),
      })),
    },
    {
      id: 'installed-connections',
      entries: (connections.data ?? []).filter((connection) => installedConnectorTypes.has(connection.connectorType))
        .map((connection) => ({
          key: 'connection:' + connection.id, definition: connectionSetting(connection, isAdmin),
        })),
    },
  ], settingsContext), [connections.data, githubSettingsConnections, customMcpSettingsConnections, isAdmin, settingsContext]);
  const searchResults = useMemo(() => {
    const action = navigationQuery.trim().toLowerCase();
    const exactConnectAction = [PERSONAL_CONNECT_LABEL, 'Connect for workspace'].some((label) => label.toLowerCase() === action);
    return searchSettings(searchEntries, navigationQuery).filter((entry) =>
      !exactConnectAction || !entry.key.startsWith('provider:')
      || entry.definition.options?.some((option) => option.toLowerCase() === action));
  }, [searchEntries, navigationQuery]);
  const selectSearchResult = (result: SettingSearchResult): void => {
    if (!searchEntries.some((entry) => entry.key === result.key)) return;
    if (result.definition.section === 'github' && result.instanceId) {
      setGitHubSettingsConnectionId(result.instanceId);
      setGitHubRepositorySearch('');
    }
    if (result.definition.section === 'custom-mcp' && result.instanceId) {
      setCustomMcpSettingsConnectionId(result.instanceId);
    }
    if (result.definition.section === 'connections') setConnectionFilter('all');
    setActiveSection(result.definition.section);
    setNavigationQuery('');
    setSearchTarget({ ...result });
  };
  useRevealSetting(contentRef, searchTarget && activeSection === searchTarget.definition.section && searchEntries.some((entry) => entry.key === searchTarget.key)
    ? searchTarget : null);
  const installedConnections = (connections.data ?? []).filter((connection) =>
    installedConnectorTypes.has(connection.connectorType),
  );
  const workspaceConnections = installedConnections.filter((connection) => connection.scope === 'workspace');
  const personalConnections = installedConnections.filter((connection) => connection.scope === 'you');
  const healthyConnections = installedConnections.filter((connection) => connection.status === 'healthy');
  const visibleProviders = connectorProviders.filter((provider) => {
    const connected = providerHasConnection(provider, connections.data ?? []);
    if (connectionFilter === 'connected') return connected;
    if (connectionFilter === 'not_connected') {
      return providerHasAvailableUnconnectedScope(provider, connections.data ?? [], isAdmin);
    }
    return true;
  });
  useEffect(() => {
    if (availableSections.has(activeSection)) return;
    const first = settingsNavigationWithConnectors[0]?.items[0]?.id;
    if (first) setActiveSection(first);
  }, [activeSection, availableSections, settingsNavigationWithConnectors]);

  // The gesture belongs to the Settings *window*, not to this screen. The same
  // screen is also a route inside the main window on surfaces with no separate
  // window to open, and there the keystroke would shut the workspace itself
  // rather than the settings the person is looking at. The visible pane is
  // swept for unsaved text because Settings saves immediately and has no undo:
  // a half-written invitation, endpoint, or API key has nowhere to come from
  // once this window is gone.
  useEscapeClosesWindow({ enabled: standaloneWindow, unsavedTextScope: contentRef });

  useEffect(() => bridge.onSettingsSectionRequested((section) => {
    const nextSection = parseDesktopSettingsSection(section);
    if (!nextSection) return;
    setNavigationQuery('');
    setSearchTarget(null);
    setActiveSection(nextSection);
  }), [bridge]);

  useEffect(() => {
    let cancelled = false;
    const unsubscribe = bridge.onApplicationSettingsChanged((settings) => {
      applicationSettingsLiveGeneration.current += 1;
      if (!cancelled) {
        setApplicationSettings(settings);
        setApplicationSettingsLoadError(null);
      }
    });
    const generationAtRead = applicationSettingsLiveGeneration.current;
    void bridge.getApplicationSettings().then((settings) => {
      if (!cancelled && applicationSettingsLiveGeneration.current === generationAtRead) {
        setApplicationSettings(settings);
        setApplicationSettingsLoadError(null);
      }
    }).catch((error: unknown) => {
      if (!cancelled && applicationSettingsLiveGeneration.current === generationAtRead) {
        setApplicationSettingsLoadError(
          error instanceof Error ? error.message : 'Application settings could not be loaded.',
        );
      }
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [bridge]);

  useEffect(() => {
    if (!api || !pendingConnectorOAuth
      || pendingConnectorOAuth.region !== workspace.region
      || pendingConnectorOAuth.workspaceId !== workspace.id) return;
    let cancelled = false;

    const reconcile = async (): Promise<void> => {
      try {
        const attempt = await api.getConnectorOAuthAttempt(pendingConnectorOAuth.attemptId);
        if (cancelled) return;
        if (attempt.status === 'pending') return;
        setPendingConnectorOAuth(null);
        if (attempt.status === 'succeeded') {
          void Promise.all([
            queryClient.invalidateQueries({ queryKey: ['connections'] }),
            invalidateCachedWorkstreamDetails(queryClient),
            queryClient.invalidateQueries({ queryKey: ['automation'] }),
          ]);
        }
      } catch {
        // Keep the pending attempt so the next workspace update can reconcile it.
      }
    };

    void reconcile();
    return () => {
      cancelled = true;
    };
  }, [
    api,
    pendingConnectorOAuth,
    queryClient,
    workspace.id,
    workspace.region,
    workspaceSocket?.state,
    workspaceSocket?.topicWaterlines.connector_oauth_attempts,
  ]);

  const openCustomMcpModal = (scope: 'you' | 'workspace'): void => {
    connectCustomMcp.reset();
    setCustomMcpName('');
    setCustomMcpServerUrl('');
    setCustomMcpAuthMode('oauth');
    setCustomMcpHeaders([{ name: '', value: '' }]);
    setCustomMcpToolPolicy('all_tools');
    setCustomMcpModalScope(scope);
  };

  const githubSettings = githubRepositorySettings.data;
  const selectedGitHubSettingsConnection = githubSettingsConnections.find((connection) => (
    connection.id === githubSettingsConnectionId
  ));
  const canEditGitHubSettings = selectedGitHubSettingsConnection?.scope === 'you' || isAdmin;
  const visibleGitHubRepositories = useMemo(() => {
    const query = githubRepositorySearch.trim().toLowerCase();
    const repositories = githubSettings?.availableRepositories ?? [];
    return query
      ? repositories.filter((repository) => repository.repositoryFullName.toLowerCase().includes(query))
      : repositories;
  }, [githubRepositorySearch, githubSettings?.availableRepositories]);
  const saveGitHubRepositoryPolicy = (
    next: Pick<GitHubRepositoryAccessSettings, 'mode' | 'defaultRemoteAccess' | 'repositories'>,
  ): void => {
    if (canEditGitHubSettings && !updateGitHubRepositorySettings.isPending) {
      updateGitHubRepositorySettings.mutate(next);
    }
  };
  const setGitHubRepositoryRemoteAccess = (
    repository: GitHubRepositoryAccessSettings['availableRepositories'][number],
    remoteAccess: 'read_only' | 'full_access' | null,
  ): void => {
    if (!githubSettings) return;
    const repositories = githubSettings.repositories.filter((candidate) => (
      candidate.repositoryId !== repository.repositoryId
    ));
    if (remoteAccess && (
      githubSettings.mode === 'selected_repositories'
      || remoteAccess !== githubSettings.defaultRemoteAccess
    )) {
      repositories.push({
        repositoryId: repository.repositoryId,
        repositoryFullName: repository.repositoryFullName,
        remoteAccess,
      });
    }
    saveGitHubRepositoryPolicy({
      mode: githubSettings.mode,
      defaultRemoteAccess: githubSettings.defaultRemoteAccess,
      repositories,
    });
  };

  const sectionTitle = settingsNavigationWithConnectors
    .flatMap((group) => group.items)
    .find((item) => item.id === activeSection)?.label ?? 'Settings';

  return (
    <div className="workspace-settings-screen screen-with-titlebar">
      <div className="screen-drag-strip window-drag" />
      <div className="settings-window">
        <aside className="settings-sidebar" onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === 'Escape' && navigationQuery) {
            event.preventDefault();
            event.stopPropagation();
            setNavigationQuery('');
            event.currentTarget.querySelector('input')?.focus();
          }
        }}>
          <SidebarSearch
            mode="input"
            aria-label="Search settings"
            onChange={(event) => {
              setSearchTarget(null);
              setNavigationQuery(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === 'Escape' && navigationQuery) {
                event.preventDefault();
                event.stopPropagation();
                setNavigationQuery('');
              } else if (event.key === 'ArrowDown' && navigationQuery.trim()) {
                event.preventDefault();
                event.currentTarget.closest('aside')?.querySelector<HTMLButtonElement>('.settings-search-results button')?.focus();
              } else if (event.key === 'Enter' && searchResults[0]) {
                event.preventDefault();
                selectSearchResult(searchResults[0]);
              }
            }}
            placeholder="Search"
            value={navigationQuery}
          />
          {navigationQuery.trim() ? <SettingsSearchResults results={searchResults} onSelect={selectSearchResult} /> : <nav aria-label="Settings sections" className="settings-navigation">
            {settingsNavigationWithConnectors.map((group) => (
              <div className="settings-navigation-group" key={group.label}>
                <span>{group.label}</span>
                {group.items.map((item) => {
                  const Icon = item.icon;
                  return (
                    <button
                      aria-current={activeSection === item.id ? 'page' : undefined}
                      className={item.child ? 'settings-navigation-child' : undefined}
                      key={item.id}
                      onClick={() => { setSearchTarget(null); setActiveSection(item.id); }}
                      type="button"
                    >
                      <Icon aria-hidden="true" size={16} />
                      {item.label}
                    </button>
                  );
                })}
              </div>
            ))}
          </nav>}
        </aside>

        <main className="settings-content" ref={contentRef}>
          <header className="settings-content-header window-drag">
            <h1 id="settings-title">{sectionTitle}</h1>
            <button aria-label="Close settings" className="settings-close window-no-drag" onClick={() => window.close()} type="button">
              <X aria-hidden="true" size={18} />
            </button>
          </header>
          <div className="settings-content-scroll">
            {activeSection === 'account' && (
              <section aria-labelledby="settings-title" className="settings-pane">
                <div className="settings-pane-heading"><h2><SettingLabel setting={settings.profile} /></h2><p>Your Rally identity and access in this workspace.</p></div>
                <PersonalSetup variant="settings" profileDetails={(displayName) => <>
                  <span><strong>{displayName}</strong><small>{workspace.currentUser.email}</small></span>
                  <Badge className="role-badge">{workspace.currentUser.role}</Badge>
                </>} />
                <div className="settings-pane-heading settings-pane-heading-spaced"><h2>Preferences</h2></div>
                <div className="settings-list-card">
                  <label className="settings-preference-row">
                    <SettingCopy setting={settings.personalTimezone} />
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
                    <SettingCopy setting={settings.signOut} />
                    <Button onClick={() => void signOut()}>Sign out</Button>
                  </div>
                </div>
              </section>
            )}

            {activeSection === 'notifications' && featureFlags.data?.pushNotificationsEnabled && (
              <section className="settings-pane">
                <div className="settings-pane-heading"><h2>On this Mac</h2></div>
                <SettingToggle setting={settings.pushNotifications}
                  checked={applicationSettings?.pushNotificationsEnabled ?? true}
                  disabled={!applicationSettings || applicationSettings.pushNotificationStatus === 'unavailable' || updatePushNotifications.isPending}
                  onChange={(event) => updatePushNotifications.mutate(event.currentTarget.checked)} />
                {applicationSettings?.pushNotificationStatus === 'unavailable' && <p className="settings-section-copy">Notifications need an installed release build of Rally.</p>}
                {applicationSettings?.pushNotificationStatus === 'denied' && <p className="settings-section-copy">Notifications are turned off in macOS. <button className="button-secondary" onClick={() => void bridge.openNotificationSettings()}>Open System Settings</button></p>}
                {updatePushNotifications.error && <InlineError>{updatePushNotifications.error.message}</InlineError>}
              </section>
            )}
            {activeSection === 'digest'  && api && digestSettingsAvailable && (
              <DigestSettings
                api={api}
                connections={connections.data ?? []}
                onEditTimezone={() => setActiveSection('account')}
              />
            )}

            {activeSection === 'workspace' && (
              <section aria-labelledby="settings-title" className="settings-pane">
                <div className="settings-pane-heading"><h2>Workspace preferences</h2><p>Review workspace details and defaults shared by workspace automations.</p></div>
                <div className="settings-list-card">
                  <div className="settings-preference-row">
                    <SettingCopy setting={settings.workspaceIdentity} />
                    <span className="settings-row-value"><strong>{workspace.name}</strong></span>
                  </div>
                  <label className="settings-preference-row">
                    <SettingCopy setting={settings.workspaceTimezone} />
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
                </div>
                {updateWorkspaceTimezone.error && <InlineError>{updateWorkspaceTimezone.error.message}</InlineError>}
                <div className="settings-pane-heading settings-pane-heading-count settings-pane-heading-spaced">
                  <div><h2><SettingLabel setting={settings.members} /></h2><p>People with access to {workspace.name}.</p></div>
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

                {isSettingAvailable(settings.invitations, settingsContext) && (
                  <div className="settings-subsection">
                    <div className="settings-pane-heading settings-pane-heading-count">
                      <div><h2><SettingLabel setting={settings.invitations} /></h2><p>Invite teammates by email. Links expire after seven days.</p></div>
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
                        <span><SettingLabel setting={settings.inviteEmail} /></span>
                        <input autoComplete="email" onChange={(event) => setEmail(event.target.value)} placeholder="teammate@company.com" type="email" value={email} />
                      </label>
                      <label>
                        <span><SettingLabel setting={settings.inviteRole} /></span>
                        <select onChange={(event) => setRole(event.target.value as 'admin' | 'member')} value={role}>
                          <option value="member">Member</option>
                          {workspace.currentUser.role === 'owner' && <option value="admin">Administrator</option>}
                        </select>
                      </label>
                      <Button className="button-primary" disabled={!email.trim() || createInvitation.isPending} type="submit">
                        {createInvitation.isPending ? <LoaderCircle aria-hidden="true" className="spin" size={15} /> : <MailPlus aria-hidden="true" size={15} />}
                        <SettingLabel setting={settings.inviteSend} />
                      </Button>
                    </form>
                    {createInvitation.error && <InlineError>{createInvitation.error.message}</InlineError>}
                    {createdUrl && (
                      <div className="invite-link-result" role="status">
                        <div>
                          <strong>{createdDelivery === 'sent' ? 'Invitation emailed' : 'Invite link ready'}</strong>
                          <small>{createdDelivery === 'sent' ? 'It expires in seven days. You can also copy the one-time link.' : 'Email delivery is disabled outside production. Copy the one-time link to test the flow.'}</small>
                        </div>
                        <CopyButton label="Copy invite link" size={15} value={createdUrl} />
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
                <div className="settings-pane-heading settings-pane-heading-spaced">
                  <h2><SettingLabel setting={settings.workspaceAccess} /></h2>
                  <p>Leaving removes this workspace from your Rally account on every device.</p>
                </div>
                <div className="settings-list-card">
                  <div className="settings-preference-row">
                    <span className="settings-row-copy">
                      <strong>{leavingClosesWorkspace ? 'Leave and close this workspace' : 'Leave this workspace'}</strong>
                      <small>{leavingClosesWorkspace
                        ? 'You are the last member. The workspace will become unavailable without deleting its retained data.'
                        : 'The workspace stays available to its other members.'}</small>
                    </span>
                    <Button
                      className="button-danger"
                      disabled={members.isLoading || members.isError}
                      onClick={() => setLeaveConfirmationOpen(true)}
                    >
                      {leavingClosesWorkspace ? 'Leave and close workspace' : 'Leave this workspace'}
                    </Button>
                  </div>
                </div>
                {members.isError && <InlineError>Rally could not verify whether anyone else belongs to this workspace.</InlineError>}
              </section>
            )}

            {activeSection === 'internet-access' && (
              <section aria-labelledby="settings-title" className="settings-pane">
                <div className="settings-pane-heading">
                  <h2><SettingLabel setting={settings.terminal} /></h2>
                  <p>Choose where code running in Daytona may connect. Rally-managed platform access is applied automatically.</p>
                </div>
                {terminalSettings.isLoading ? (
                  <div className="settings-loading"><LoaderCircle aria-hidden="true" className="spin" size={15} /> Loading Terminal policy…</div>
                ) : terminalSettings.error ? (
                  <InlineError>{terminalSettings.error.message}</InlineError>
                ) : terminalSettings.data && (
                  <div className="terminal-network-card settings-list-card">
                    {terminalSettings.data.availability !== 'supported' && (
                      <div className="terminal-network-notice" role="status">
                        <ShieldCheck aria-hidden="true" size={17} />
                        <span><strong>Terminal unavailable</strong><small>{terminalSettings.data.availability === 'emergency_disabled' ? 'Temporarily disabled by the regional safety switch.' : 'This regional service has not enabled Daytona Terminal.'}</small></span>
                      </div>
                    )}
                    <fieldset className="terminal-network-modes" disabled={!isAdmin || terminalSettings.data.availability !== 'supported' || previewTerminalPolicy.isPending || applyTerminalPolicy.isPending}>
                      <legend>Outbound access</legend>
                      <label>
                        <input checked={terminalMode === 'trusted_only'} name="terminal-network-mode" onChange={() => { terminalPolicyDirty.current = true; setTerminalMode('trusted_only'); setTerminalPreview(null); }} type="radio" />
                        <span><strong><SettingLabel setting={settings.trustedNetwork} /></strong><small>{settings.trustedNetwork.description}</small></span>
                      </label>
                      <label>
                        <input checked={terminalMode === 'full_internet'} name="terminal-network-mode" onChange={() => { terminalPolicyDirty.current = true; setTerminalMode('full_internet'); setTerminalPreview(null); }} type="radio" />
                        <span><strong><SettingLabel setting={settings.fullNetwork} /></strong><small>{settings.fullNetwork.description}</small></span>
                      </label>
                    </fieldset>
                    {terminalMode === 'full_internet' && searchTarget?.definition.id === 'terminalDomains' && (
                      <div className="terminal-network-domains">
                        <SettingCopy setting={settings.terminalDomains}
                          description="Workspace-approved domains apply only to Trusted only mode." />
                      </div>
                    )}
                    {terminalMode === 'trusted_only' && (
                      <div className="terminal-network-domains">
                        <label>
                          <span><SettingLabel setting={settings.terminalDomains} /></span>
                          <textarea
                            aria-label="Additional Terminal domains"
                            data-saved-value={terminalSettings.data.customDomains.join('\n')}
                            disabled={!isAdmin || terminalSettings.data.availability !== 'supported'}
                            onChange={(event) => { terminalPolicyDirty.current = true; setTerminalDomains(event.target.value); setTerminalPreview(null); }}
                            placeholder="packages.example.com&#10;*.downloads.example.com"
                            rows={3}
                            value={terminalDomains}
                          />
                          <small>{terminalDraftRemainingSlots === null
                            ? 'Review the change to verify remaining workspace-domain capacity.'
                            : `${terminalDraftRemainingSlots ?? 0} workspace domain slots remain.`} Enter domains only—no schemes, ports, paths, IPs, or CIDR blocks.</small>
                        </label>
                      </div>
                    )}
                    <div className="terminal-network-actions">
                      <span><Badge>{terminalSettings.data.verificationState}</Badge> Revision {terminalSettings.data.revision}</span>
                      <Button
                        disabled={!isAdmin || !terminalPolicyChanged || terminalSettings.data.availability !== 'supported' || previewTerminalPolicy.isPending || applyTerminalPolicy.isPending}
                        onClick={() => previewTerminalPolicy.mutate()}
                      >
                        {previewTerminalPolicy.isPending && <LoaderCircle aria-hidden="true" className="spin" size={14} />}
                        Review network change
                      </Button>
                    </div>
                    {previewTerminalPolicy.error && <InlineError>{previewTerminalPolicy.error.message}</InlineError>}
                    {applyTerminalPolicy.error && <InlineError>{applyTerminalPolicy.error.message}</InlineError>}
                    {terminalPolicyFailure.length > 0 && (
                      <div className="terminal-network-failure-outcomes" role="status">
                        <strong>Sandbox outcomes</strong>
                        <ul>{terminalPolicyFailure.map((outcome) => (
                          <li key={outcome.workstreamId}>{outcome.title}: {outcome.outcome}</li>
                        ))}</ul>
                      </div>
                    )}
                    {terminalPreview && (
                      <div className="terminal-network-confirmation" role="alert">
                        <Wifi aria-hidden="true" size={18} />
                        <span>
                          <strong>Confirm {terminalPreview.proposedMode === 'full_internet' ? 'Full internet' : 'Trusted only'}</strong>
                          <small>{terminalPreview.warning} {terminalPreview.affectedWorkstreamIds.length} active sandbox{terminalPreview.affectedWorkstreamIds.length === 1 ? '' : 'es'} will be stopped.</small>
                          <details>
                            <summary>Review exact before and after targets</summary>
                            <strong>Before</strong>
                            <ul>{terminalSettings.data.customDomains.length > 0
                              ? terminalSettings.data.customDomains.map((domain) => <li key={`before:${domain}`}><code>{domain}</code></li>)
                              : <li>None</li>}</ul>
                            <strong>After</strong>
                            <ul>{terminalPreview.customDomains.length > 0
                              ? terminalPreview.customDomains.map((domain) => <li key={`after:${domain}`}><code>{domain}</code></li>)
                              : <li>None</li>}</ul>
                            {terminalPreview.affectedWorkstreams.length > 0 && (
                              <><strong>Work streams stopped</strong><ul>{terminalPreview.affectedWorkstreams.map((stream) => <li key={stream.id}>{stream.title}</li>)}</ul></>
                            )}
                          </details>
                        </span>
                        <div className="terminal-network-confirmation-actions">
                          <Button onClick={() => {
                            const contents = terminalPreview.customDomains.join('\n');
                            const url = URL.createObjectURL(new Blob([`${contents}\n`], { type: 'text/plain' }));
                            const anchor = document.createElement('a');
                            anchor.href = url;
                            anchor.download = `terminal-workspace-domains-revision-${terminalPreview.expectedRevision + 1}.txt`;
                            anchor.click();
                            URL.revokeObjectURL(url);
                          }}>Download workspace domains</Button>
                          <Button disabled={applyTerminalPolicy.isPending} onClick={() => applyTerminalPolicy.mutate()}>
                            {applyTerminalPolicy.isPending && <LoaderCircle aria-hidden="true" className="spin" size={14} />}
                            Confirm network change
                          </Button>
                          <Button disabled={applyTerminalPolicy.isPending} onClick={() => setTerminalPreview(null)}>Cancel</Button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </section>
            )}

            {activeSection === 'connections' && (
              <section aria-labelledby="settings-title" className="settings-pane settings-connections-pane">
                <div className="settings-pane-heading settings-pane-heading-count">
                  <div><h2><SettingLabel setting={settings.connections} /></h2><p>Credentials currently available to you or this workspace.</p></div>
                  <span>{installedConnections.length}</span>
                </div>
                <div className="settings-connection-tables">
                  {([
                    {
                      id: 'personal-connections',
                      title: 'Personal connections',
                      items: personalConnections,
                      emptyTitle: 'No personal connections yet',
                      emptyDescription: 'Connect a connector below to use its tools privately with your provider identity.',
                    },
                    {
                      id: 'workspace-connections',
                      title: 'Workspace connections',
                      items: workspaceConnections,
                      emptyTitle: 'No workspace connections yet',
                      emptyDescription: 'Connect a connector below to make its tools available across this workspace.',
                    },
                  ] as const).map((group) => (
                    <section className="settings-connection-group" key={group.id}>
                      <div className="settings-connection-group-heading">
                        <h3 id={group.id}>{group.title}</h3>
                        <span>{group.items.length}</span>
                      </div>
                      <div className="settings-list-card settings-connection-table-frame">
                        <table aria-labelledby={group.id} className="settings-connection-table">
                          <thead>
                            <tr>
                              <th scope="col">Connection</th>
                              <th scope="col">Status</th>
                              <th className="settings-connection-tools" scope="col">Tools</th>
                              <th scope="col"><span className="sr-only">Actions</span></th>
                            </tr>
                          </thead>
                          <tbody>
                            {group.items.map((connection) => (
                              <tr className="settings-connection-row" key={connection.id}>
                                <td>
                                  <span className="settings-connection-name">
                                    <span className={`connection-provider-dot ${connection.status}`} aria-hidden="true" />
                                    <InstalledConnectionMark connection={connection} />
                                    <span className="settings-connection-copy"><strong><SettingLabel setting={connectionSetting(connection, isAdmin)} /></strong></span>
                                  </span>
                                </td>
                                <td><Badge>{connection.status === 'reconnect_required' ? 'Reconnect required' : connection.status}</Badge></td>
                                <td className="settings-connection-tools">{connection.status === 'disabled'
                                  ? '—'
                                  : toolCountByConnection.get(connection.id)?.isError
                                  ? 'Unavailable'
                                  : toolCountByConnection.get(connection.id)?.data ?? 'Loading…'}</td>
                                <td>
                                  <span className="settings-connection-actions">
                                    {isAdmin && connection.scope === 'workspace' && hasWorkspaceInstallationSurface(connection.connectorType) && (
                                      <Button aria-label={`Manage events for ${connection.displayName}`} onClick={() => setInstallationTarget(connection.id)}>Manage events</Button>
                                    )}
                                    {(isAdmin || connection.scope === 'you') && reconnectableConnectorTypes.has(connection.connectorType)
                                      && !(hasInstallationFacet(connection.connectorType) && connection.scope === 'workspace') && (
                                      <ConnectionIconAction
                                        disabled={reconnectConnection.isPending || Boolean(pendingConnectorOAuth)}
                                        icon={<RefreshCcw aria-hidden="true" size={14} />}
                                        label={`Refresh ${connection.displayName}`}
                                        onClick={() => setReconnectTarget(connection)}
                                        tooltip="Refresh authorization with the provider."
                                      />
                                    )}
                                    {isAdmin && connection.connectorType === 'generic_webhook' && (
                                      <ConnectionIconAction
                                        disabled={rotateWebhookSecret.isPending}
                                        icon={<RefreshCcw aria-hidden="true" size={14} />}
                                        label={`Refresh ${connection.displayName}`}
                                        onClick={() => {
                                          setWebhookModalScope(connection.scope);
                                          setWebhookDisplayName(connection.displayName);
                                          setWebhookEventTypes('');
                                          setWebhookSecretResult(null);
                                          setWebhookRotationTarget(connection);
                                        }}
                                        tooltip="Refresh this webhook by replacing its signing secret."
                                      />
                                    )}
                                    {(connection.scope === 'you' || isAdmin) && (
                                      <ConnectionIconAction
                                        disabled={disconnectConnection.isPending}
                                        icon={<Trash2 aria-hidden="true" size={14} />}
                                        label={`Delete ${connection.displayName}`}
                                        onClick={() => {
                                          disconnectConnection.reset();
                                          setDisconnectTarget(connection);
                                        }}
                                        tooltip="Delete this connection from Rally."
                                      />
                                    )}
                                  </span>
                                </td>
                              </tr>
                            ))}
                            {!connections.isLoading && group.items.length === 0 && (
                              <tr className="settings-connection-empty-row">
                                <td colSpan={4}>
                                  <EmptyState description={group.emptyDescription} title={group.emptyTitle} />
                                </td>
                              </tr>
                            )}
                          </tbody>
                        </table>
                      </div>
                    </section>
                  ))}
                </div>
                <div className="settings-subsection">
                  <div className="settings-connection-toolbar">
                    <SegmentedControl
                      ariaLabel="Filter connections"
                      onChange={setConnectionFilter}
                      options={[
                        { value: 'not_connected', label: 'Not connected' },
                        { value: 'connected', label: 'Connected' },
                        { value: 'all', label: 'All' },
                      ]}
                      value={connectionFilter}
                    />
                    <span>{healthyConnections.length} connected</span>
                  </div>
                  <p className="settings-section-copy">Personal connections are available only to you and act with your provider identity. Workspace connections expose granted capabilities to every member; workspace automations use only the connections explicitly bound to them.</p>
                  <div className="provider-grid">
                    {visibleProviders.map((provider) => {
                      const mark = 'mark' in provider ? provider.mark : null;
                      const Icon = 'icon' in provider ? provider.icon : null;
                      const connected = providerHasConnection(provider, connections.data ?? []);
                      const providerAvailable = connectorCatalog.data?.includes(provider.provider) ?? false;
                      const awaitingProvider = pendingConnectorOAuth?.provider === provider.provider;
                      const hasActivePersonalConnection = provider.provider !== 'generic_webhook'
                        && providerHasActivePersonalConnection(provider, connections.data ?? []);
                      const hasActiveWorkspaceConnection = provider.provider !== 'generic_webhook'
                        && providerHasActiveWorkspaceConnection(provider, connections.data ?? []);
                      const personalConnectionStateUnavailable = hasInstallationFacet(provider.provider) && (connections.isLoading || connections.isError);
                      const personalConnectDisabled = !providerAvailable || personalConnectionStateUnavailable || connectProvider.isPending || Boolean(pendingConnectorOAuth) || hasActivePersonalConnection;
                      const personalConnectTitle = hasActivePersonalConnection
                        ? `A ${provider.name} personal connection is already installed. Manage it above.`
                        : !providerAvailable && !connectorCatalog.isLoading
                          ? `${provider.name} is not configured in this Rally region.`
                        : personalConnectionStateUnavailable && connections.isLoading
                          ? 'Checking installed personal connections…'
                          : personalConnectionStateUnavailable && connections.isError
                            ? 'Installed personal connections could not be loaded.'
                            : undefined;
                      const workspaceConnectDisabled = !providerAvailable || connections.isLoading || connections.isError || connectProvider.isPending || createGranolaWorkspaceConnection.isPending || Boolean(pendingConnectorOAuth) || hasActiveWorkspaceConnection;
                      const workspaceConnectTitle = hasActiveWorkspaceConnection
                        ? `A ${provider.name} workspace connection is already installed. Manage it above.`
                        : !providerAvailable && !connectorCatalog.isLoading
                          ? `${provider.name} is not configured in this Rally region.`
                        : connections.isLoading
                          ? 'Checking installed workspace connections…'
                          : connections.isError
                            ? 'Installed workspace connections could not be loaded.'
                            : undefined;
                      return (
                        <article className="provider-card" key={provider.id}>
                          <div className="provider-card-heading">
                            <div className="provider-icon">
                              {mark
                                ? <ConnectorMark mark={mark} />
                                : Icon && <Icon aria-hidden="true" size={18} />}
                            </div>
                            <div><strong><SettingLabel setting={providerSetting(provider, isAdmin)} /></strong><span>{awaitingProvider ? 'Waiting for authorization' : connected ? 'Connected' : connectorCatalog.isLoading ? 'Checking availability' : providerAvailable ? 'Available' : 'Unavailable'}</span></div>
                          </div>
                          <p>{provider.description}</p>
                          {provider.provider === 'ashby' && <p>Personal account: {hasActivePersonalConnection ? 'Connected' : 'Not connected'}. Workspace events: {hasActiveWorkspaceConnection ? 'Configured — manage delivery above' : 'Not configured'}.</p>}
                          {provider.provider === 'ashby' && <p>Personal sign-in requires your organization's Ashby MCP opt-in and an eligible account. <Button onClick={() => void desktopBridge().openExternal('https://rallywith.ai/support/connectors/ashby/')}>Ashby setup guide ↗</Button></p>}
                          {provider.provider === 'fireflies' && <p>Personal account: {hasActivePersonalConnection ? 'Connected' : 'Not connected'}.</p>}
                          {searchTarget?.definition.entryPoint === 'provider:' + provider.id && (
                            <p className="settings-search-guidance" role="status">
                              {searchTarget.definition.label} is part of setup. Choose the appropriate connection scope below.
                            </p>
                          )}
                            <div className="provider-actions">
                              {provider.scopes.includes('you' as never) && (
                                <ConnectorButton
                                  disabled={personalConnectDisabled}
                                  label={PERSONAL_CONNECT_LABEL}
                                  onClick={() => {
                                    if (provider.provider === 'custom_mcp') {
                                      openCustomMcpModal('you');
                                      return;
                                    }
                                    if (provider.provider === 'generic_webhook') {
                                      setWebhookModalScope('you');
                                      setWebhookDisplayName('Inbound webhook');
                                      setWebhookEventTypes('');
                                      setWebhookIdempotencyKey(crypto.randomUUID());
                                      setWebhookSecretResult(null);
                                      setWebhookRotationTarget(null);
                                      return;
                                    }
                                    connectProvider.mutate({ provider: provider.provider, scope: 'you', capabilities: providerCapabilitiesForScope(provider, 'you') });
                                  }}
                                  tooltip={`Only you can use this connection; it acts with your provider identity.${personalConnectTitle ? ` ${personalConnectTitle}` : ''}`}
                                >{awaitingProvider ? <><LoaderCircle aria-hidden="true" className="spin" size={13} /> Waiting…</> : PERSONAL_CONNECT_LABEL}</ConnectorButton>
                              )}
                            {provider.scopes.includes('workspace' as never) && isAdmin && (
                              <ConnectorButton
                                disabled={workspaceConnectDisabled}
                                label={'Connect for workspace'}
                                onClick={() => {
                                  if (provider.provider === 'custom_mcp') {
                                    openCustomMcpModal('workspace');
                                    return;
                                  }
                                  if (provider.provider === 'ashby') {
                                    setAshbyWorkspaceOpen(true);
                                    return;
                                  }
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
                                    setWebhookRotationTarget(null);
                                    return;
                                  }
                                  connectProvider.mutate({ provider: provider.provider, scope: 'workspace', capabilities: providerCapabilitiesForScope(provider, 'workspace') });
                                }}
                                tooltip={`Everyone in this workspace can use this connection; it acts for the workspace.${workspaceConnectTitle ? ` ${workspaceConnectTitle}` : ''}`}
                              >
                                {'Connect for workspace'}
                              </ConnectorButton>
                            )}
                          </div>
                        </article>
                      );
                    })}
                    {visibleProviders.length === 0 && <EmptyState title="No connectors here" description="Change the filter to see other available providers." />}
                  </div>
                </div>
              </section>
            )}

            {activeSection === 'github' && (
              <section aria-labelledby="settings-title" className="settings-pane settings-github-pane">
                <div className="settings-pane-heading">
                  <h2><SettingLabel setting={settings.githubAccess} instanceId={githubSettingsConnectionId ?? undefined} /></h2>
                  <p>Choose which GitHub repositories Rally may use and whether it may change the remote repository.</p>
                </div>
                {githubSettingsConnections.length > 1 && (
                  <label className="settings-field settings-github-connection">
                    <span>Connection</span>
                    <select
                      aria-label="GitHub connection"
                      disabled={updateGitHubRepositorySettings.isPending}
                      onChange={(event) => {
                        setGitHubSettingsConnectionId(event.currentTarget.value);
                        setGitHubRepositorySearch('');
                      }}
                      value={githubSettingsConnectionId ?? ''}
                    >
                      {githubSettingsConnections.map((connection) => (
                        <option key={connection.id} value={connection.id}>{connection.displayName} · {connection.scope === 'you' ? 'Personal' : 'Workspace'}</option>
                      ))}
                    </select>
                  </label>
                )}
                {githubRepositorySettings.isLoading ? (
                  <div className="settings-loading"><LoaderCircle aria-hidden="true" className="spin" size={15} /> Loading GitHub repositories…</div>
                ) : githubSettings ? (
                  <>
                    {!canEditGitHubSettings && (
                      <p className="settings-section-copy">Workspace repository access is read-only here. Ask a workspace administrator to change it.</p>
                    )}
                    <div className="settings-list-card settings-github-policy">
                      <label className="settings-preference-row">
                        <SettingCopy setting={settings.githubAvailability} instanceId={githubSettingsConnectionId ?? undefined} />
                        <select
                          aria-label="Repository availability"
                          disabled={!canEditGitHubSettings || updateGitHubRepositorySettings.isPending}
                          onChange={(event) => saveGitHubRepositoryPolicy({
                            mode: event.currentTarget.value as GitHubRepositoryAccessSettings['mode'],
                            defaultRemoteAccess: githubSettings.defaultRemoteAccess,
                            repositories: githubSettings.repositories,
                          })}
                          value={githubSettings.mode}
                        >
                          <option value="all_repositories">{githubAvailabilityLabels.all_repositories}</option>
                          <option value="selected_repositories">{githubAvailabilityLabels.selected_repositories}</option>
                        </select>
                      </label>
                      {githubSettings.mode !== 'all_repositories' && searchTarget?.definition.id === 'githubRemote' && (
                        <div className="settings-preference-row">
                          <SettingCopy setting={settings.githubRemote} instanceId={githubSettingsConnectionId ?? undefined}
                            description="A default applies only to All repositories. Configure individual access under Repositories below." />
                        </div>
                      )}
                      {githubSettings.mode === 'all_repositories' && (
                        <label className="settings-preference-row">
                          <SettingCopy setting={settings.githubRemote} instanceId={githubSettingsConnectionId ?? undefined} />
                          <select
                            aria-label="Default remote access"
                            disabled={!canEditGitHubSettings || updateGitHubRepositorySettings.isPending}
                            onChange={(event) => saveGitHubRepositoryPolicy({
                              mode: githubSettings.mode,
                              defaultRemoteAccess: event.currentTarget.value as GitHubRepositoryAccessSettings['defaultRemoteAccess'],
                              repositories: githubSettings.repositories,
                            })}
                            value={githubSettings.defaultRemoteAccess}
                          >
                            <option value="read_only">{githubRemoteLabels.read_only}</option>
                            <option value="full_access">{githubRemoteLabels.full_access}</option>
                          </select>
                        </label>
                      )}
                    </div>
                    <div className="settings-github-repository-heading">
                      <div>
                        <strong><SettingLabel setting={settings.githubRepositories} instanceId={githubSettingsConnectionId ?? undefined} /></strong>
                        <small>{githubSettings.availableRepositories.length} available through {githubSettings.connectionName}</small>
                      </div>
                      <label className="settings-search settings-github-search">
                        <Search aria-hidden="true" size={15} />
                        <span className="sr-only">Search GitHub repositories</span>
                        <input
                          data-saved-value={githubRepositorySearch}
                          onChange={(event) => setGitHubRepositorySearch(event.currentTarget.value)}
                          placeholder="Search repositories"
                          type="search"
                          value={githubRepositorySearch}
                        />
                      </label>
                    </div>
                    <div className="settings-list-card settings-github-repository-list">
                      {visibleGitHubRepositories.map((repository) => {
                        const configured = githubSettings.repositories.find((candidate) => (
                          candidate.repositoryId === repository.repositoryId
                        ));
                        const selected = githubSettings.mode === 'all_repositories' || Boolean(configured);
                        const effectiveAccess = configured?.remoteAccess
                          ?? (githubSettings.mode === 'all_repositories' ? githubSettings.defaultRemoteAccess : 'read_only');
                        return (
                          <div className="settings-github-repository-row" key={repository.repositoryId}>
                            <span>
                              <strong>{repository.repositoryFullName}</strong>
                              <small>{repository.private ? 'Private repository' : 'Public repository'}</small>
                            </span>
                            {selected ? (
                              <>
                                <select
                                  aria-label={`Remote access for ${repository.repositoryFullName}`}
                                  disabled={!canEditGitHubSettings || updateGitHubRepositorySettings.isPending}
                                  onChange={(event) => setGitHubRepositoryRemoteAccess(
                                    repository,
                                    event.currentTarget.value as 'read_only' | 'full_access',
                                  )}
                                  value={effectiveAccess}
                                >
                                  <option value="read_only">{githubRemoteLabels.read_only}</option>
                                  <option value="full_access">{githubRemoteLabels.full_access}</option>
                                </select>
                                {githubSettings.mode === 'selected_repositories' && (
                                  <Button
                                    disabled={!canEditGitHubSettings || updateGitHubRepositorySettings.isPending}
                                    onClick={() => setGitHubRepositoryRemoteAccess(repository, null)}
                                  >Remove</Button>
                                )}
                              </>
                            ) : (
                              <Button
                                disabled={!canEditGitHubSettings || updateGitHubRepositorySettings.isPending}
                                onClick={() => setGitHubRepositoryRemoteAccess(repository, 'read_only')}
                              >Add</Button>
                            )}
                          </div>
                        );
                      })}
                      {visibleGitHubRepositories.length === 0 && (
                        <EmptyState title="No repositories found" description="Try a different repository name." />
                      )}
                    </div>
                    <p className="settings-section-copy settings-github-footnote">
                      Models see the effective remote access when they search or check out a repository. The Terminal harness always permits local edits and local commits; read-only blocks remote publication, while full access allows native Git and GitHub remote operations.
                    </p>
                  </>
                ) : null}
                {(githubRepositorySettings.error || updateGitHubRepositorySettings.error) && (
                  <InlineError>{githubRepositorySettings.error?.message ?? updateGitHubRepositorySettings.error?.message}</InlineError>
                )}
              </section>
            )}

            {activeSection === 'custom-mcp' && (
              <section aria-labelledby="settings-title" className="settings-pane settings-custom-mcp-pane">
                <div className="settings-pane-heading">
                  <h2><SettingLabel setting={settings.mcpTools} instanceId={customMcpSettingsConnectionId ?? undefined} /></h2>
                  <p>What each connected MCP server currently offers, and how much of it Rally may use.</p>
                </div>
                {customMcpSettingsConnections.length > 1 && (
                  <label className="settings-field settings-custom-mcp-connection">
                    <span>Connection</span>
                    <select
                      aria-label="MCP connection"
                      onChange={(event) => setCustomMcpSettingsConnectionId(event.currentTarget.value)}
                      value={customMcpSettingsConnectionId ?? ''}
                    >
                      {customMcpSettingsConnections.map((connection) => (
                        <option key={connection.id} value={connection.id}>
                          {connection.displayName} · {connection.scope === 'you' ? 'Personal' : 'Workspace'}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {customMcpSettings.isLoading ? (
                  <div className="settings-loading"><LoaderCircle aria-hidden="true" className="spin" size={15} /> Reading this server’s tools…</div>
                ) : customMcpSettings.data ? (
                  <>
                    <div className="settings-list-card">
                      <div className="settings-preference-row">
                        <span className="settings-row-copy">
                          <strong><SettingLabel setting={settings.mcpServer} instanceId={customMcpSettingsConnectionId ?? undefined} /></strong>
                          <span>{customMcpSettings.data.serverUrl}</span>
                          <small>
                            {customMcpSettings.data.authMode === 'oauth'
                              ? 'Authorized through the server’s own OAuth. Rally registered itself as a client and holds a token for this connection.'
                              : 'Authenticated with the request headers configured for this connection. Rally never shows their values again.'}
                          </small>
                        </span>
                        {customMcpSettings.data.authMode === 'oauth'
                          && (customMcpSettings.data.scope === 'personal' || isAdmin) && (
                          <Button
                            disabled={reconnectConnection.isPending || Boolean(pendingConnectorOAuth)}
                            onClick={() => {
                              const connection = customMcpSettingsConnections
                                .find((candidate) => candidate.id === customMcpSettings.data.connectionId);
                              if (connection) setReconnectTarget(connection);
                            }}
                          >
                            <RefreshCcw aria-hidden="true" size={14} />
                            Authorize again
                          </Button>
                        )}
                      </div>
                      <label className="settings-preference-row">
                        <SettingCopy setting={settings.mcpPolicy} instanceId={customMcpSettingsConnectionId ?? undefined} description={<> {customMcpSettings.data.toolPolicyEditable
                              ? 'Read-only exposes just the tools this server marks as read-only. The marking is the server’s own claim, which Rally cannot verify; it grants no additional access.'
                              : 'A personal connection is only ever yours and acts with your own identity on that server, so it exposes everything the server offers you.'} </>} />
                        <select
                          aria-label="Tools Rally may use"
                          disabled={!customMcpSettings.data.toolPolicyEditable || updateCustomMcpToolPolicy.isPending}
                          onChange={(event) => updateCustomMcpToolPolicy.mutate(
                            event.currentTarget.value as CustomMcpToolPolicy,
                          )}
                          value={customMcpSettings.data.toolPolicy}
                        >
                          <option value="all_tools">All tools</option>
                          <option value="read_only_tools">Read-only tools</option>
                        </select>
                      </label>
                    </div>
                    <div className="settings-custom-mcp-tool-heading">
                      <div>
                        <strong><SettingLabel setting={settings.mcpCatalog} instanceId={customMcpSettingsConnectionId ?? undefined} /></strong>
                        <small>
                          {customMcpSettings.data.toolsUnavailable
                            ? 'Read live from the server each time this screen opens.'
                            : `${customMcpSettings.data.tools.filter((tool) => tool.available).length} of ${customMcpSettings.data.tools.length} available to Rally right now`}
                        </small>
                      </div>
                    </div>
                    <div className="settings-list-card settings-custom-mcp-tool-list">
                      {customMcpSettings.data.toolsUnavailable ? (
                        <EmptyState
                          description={customMcpSettings.data.toolsUnavailable}
                          title="This server’s tools could not be read"
                        />
                      ) : customMcpSettings.data.tools.length === 0 ? (
                        <EmptyState
                          description="The server responded but advertises no tools."
                          title="No tools offered"
                        />
                      ) : customMcpSettings.data.tools.map((tool) => (
                        <div className="settings-custom-mcp-tool-row" key={tool.name}>
                          <span>
                            <strong>{tool.name}</strong>
                            <small>{tool.description || 'This server gave the tool no description.'}</small>
                          </span>
                          <Badge>{tool.readOnly ? 'Read-only' : tool.destructive ? 'Destructive' : 'Write'}</Badge>
                          <Badge>{tool.available ? 'Available' : 'Withheld'}</Badge>
                        </div>
                      ))}
                    </div>
                    <p className="settings-section-copy settings-custom-mcp-footnote">
                      Tool names, descriptions, and markings come from the server itself and are shown as it sent them. Rally treats them as information, never as instructions. Tools run within the connection's granted access and your request, without per-tool confirmation prompts.
                    </p>
                  </>
                ) : null}
                {(customMcpSettings.error || updateCustomMcpToolPolicy.error) && (
                  <InlineError>{customMcpSettings.error?.message ?? updateCustomMcpToolPolicy.error?.message}</InlineError>
                )}
              </section>
            )}

            {activeSection === 'application' && (
              <section aria-labelledby="settings-title" className="settings-pane">
                <div className="settings-pane-heading"><h2>Security</h2><p>Choose how Rally protects the saved authentication session on this Mac.</p></div>
                <div className="settings-list-card">
                  <SettingToggle
                    setting={settings.lockdown}
                    description={applicationSettings && !applicationSettings.lockdownAvailable
                    ? applicationSettings.lockdownMode
                    ? 'This Mac’s keystore is unavailable. Turn off Lockdown mode to keep using the loaded session.'
                    : 'Lockdown mode is off because this Mac’s keystore is unavailable.'
                    : 'Protect the saved session with this Mac’s keystore instead of Rally’s shared encryption key.'}
                    aria-label="Lockdown mode"
                    checked={applicationSettings?.lockdownMode ?? false}
                    disabled={
                    applicationSettings === null
                    || updateLockdownMode.isPending
                    || (!applicationSettings.lockdownAvailable && !applicationSettings.lockdownMode)
                    }
                    onChange={(event) => updateLockdownMode.mutate(event.currentTarget.checked)}
                    role="switch"
                  />
                </div>
                {(applicationSettingsLoadError || updateLockdownMode.error) && (
                  <InlineError>{applicationSettingsLoadError ?? updateLockdownMode.error?.message}</InlineError>
                )}
                <div className="settings-pane-heading settings-pane-heading-spaced"><h2>Privacy & diagnostics</h2><p>Control product analytics and detailed crash reporting for your account.</p></div>
                <div className="settings-list-card">
                  <SettingToggle
                    setting={settings.analytics}
                    aria-label="Product analytics"
                    checked={applicationSettings?.productAnalyticsEnabled ?? true}
                    disabled={
                    applicationSettings?.productAnalyticsAvailable === false
                    || applicationSettings === null
                    || updateProductAnalytics.isPending
                    }
                    onChange={(event) => updateProductAnalytics.mutate(event.currentTarget.checked)}
                    role="switch"
                  />
                </div>
                {applicationSettings?.productAnalyticsAvailable === false && (
                  <p className="settings-oauth-status">Product analytics is managed in the Rally desktop app.</p>
                )}
                {applicationSettings?.productAnalyticsPreferencePending && (
                  <p className="settings-oauth-status" role="status"><LoaderCircle aria-hidden="true" className="spin" size={14} />Waiting to sync this account preference.</p>
                )}
                {applicationSettings?.nativeCrashRestartRequired && (
                  <p className="settings-oauth-status" role="status">Crash upload has stopped for this launch. Restart Rally to remove local native crash dumps and apply the current setting.</p>
                )}
                {updateProductAnalytics.error && <InlineError>{updateProductAnalytics.error.message}</InlineError>}
                <div className="settings-pane-heading settings-pane-heading-spaced"><h2>Appearance</h2><p>Make Rally feel at home on this Mac.</p></div>
                <ThemePicker />
                {isSettingAvailable(settings.menuBar, settingsContext) && (
                  <>
                    <div className="settings-list-card">
                      {/* The preference file is shared with Lockdown. Keep one write in flight while it re-encrypts the session. */}
                      <SettingToggle
                        setting={settings.menuBar}
                        aria-label="Show Rally in the menu bar"
                        checked={applicationSettings?.menuBarEnabled ?? true}
                        disabled={
                        applicationSettings === null
                        || updateMenuBarEnabled.isPending
                        || updateLockdownMode.isPending
                        }
                        onChange={(event) => updateMenuBarEnabled.mutate(event.currentTarget.checked)}
                        role="switch"
                      />
                    </div>
                    {updateMenuBarEnabled.error && <InlineError>{updateMenuBarEnabled.error.message}</InlineError>}
                    {/* The write succeeded and the item still is not there —
                      * creating one can fail, and without this the switch reads
                      * on beside an empty menu bar with nothing said about it. */}
                    {applicationSettings?.menuBarEnabled
                      && applicationSettings.menuBarAvailable
                      && !applicationSettings.menuBarPresent
                      && !updateMenuBarEnabled.isPending
                      && (
                        <InlineError>
                          Rally could not add itself to the menu bar. Turn this off and on to try again, or restart Rally.
                        </InlineError>
                      )}
                  </>
                )}
                <ApplicationIconPicker />
                {applicationSettings && isSettingAvailable(settings.releaseChannel, settingsContext) && (
                  <>
                    <div className="settings-pane-heading settings-pane-heading-spaced"><h2>Updates</h2><p>Choose how quickly this Mac receives Rally releases.</p></div>
                    <div className="settings-list-card">
                      <label className="settings-preference-row">
                        <SettingCopy setting={settings.releaseChannel} />
                        <DropdownSelect
                          ariaLabel="Update channel"
                          disabled={updateReleaseChannel.isPending || updateLockdownMode.isPending}
                          onValueChange={(value) => {
                            const channel = parseDesktopReleaseChannel(value);
                            if (channel) updateReleaseChannel.mutate(channel);
                          }}
                          options={[
                            { value: 'stable', label: 'Stable', description: 'At most one release every 24 hours' },
                            { value: 'faster', label: 'Faster', description: 'Every desktop release' },
                          ]}
                          value={applicationSettings.releaseChannel}
                          variant="secondary"
                        />
                      </label>
                    </div>
                    {updateReleaseChannel.error && <InlineError>{updateReleaseChannel.error.message}</InlineError>}
                  </>
                )}
                {isSettingAvailable(settings.login, settingsContext) && (
                  <>
                    <div className="settings-pane-heading settings-pane-heading-spaced"><h2>Startup</h2><p>Decide whether this Mac starts Rally for you.</p></div>
                    <div className="settings-list-card">
                      {/* macOS owns this registration. Display the state the system returns after the write, including pending approval. */}
                      <SettingToggle
                        setting={settings.login}
                        aria-label="Open Rally at login"
                        checked={applicationSettings?.launchAtLogin ?? false}
                        disabled={
                        applicationSettings === null
                        || updateLaunchAtLogin.isPending
                        || updateLockdownMode.isPending
                        }
                        onChange={(event) => updateLaunchAtLogin.mutate(event.currentTarget.checked)}
                        role="switch"
                      />
                    </div>
                    {updateLaunchAtLogin.error && <InlineError>{updateLaunchAtLogin.error.message}</InlineError>}
                  </>
                )}
                {/* The service decides whether this section exists at all, and
                  * answers on a poll, so it can appear or disappear without the
                  * window reloading. It is absent rather than disabled: a
                  * section nobody outside Juno can turn on is not a control
                  * that happens to be unavailable. */}
                {applicationSettings && isSettingAvailable(settings.debug, settingsContext) && (
                  <>
                    <div className="settings-pane-heading settings-pane-heading-spaced"><h2>Developer</h2><p>Extra tooling for reporting and diagnosing problems.</p></div>
                    <div className="settings-list-card">
                      {/* Debug shares the preference file with Lockdown, so writes wait for session re-encryption. */}
                      <SettingToggle
                        setting={settings.debug}
                        aria-label="Debug enabled"
                        checked={applicationSettings.debugEnabled}
                        disabled={updateDebugEnabled.isPending || updateLockdownMode.isPending}
                        onChange={(event) => updateDebugEnabled.mutate(event.currentTarget.checked)}
                        role="switch"
                      />
                    </div>
                    {updateDebugEnabled.error && <InlineError>{updateDebugEnabled.error.message}</InlineError>}
                  </>
                )}
                <div className="settings-pane-heading settings-pane-heading-spaced"><h2><SettingLabel setting={settings.about} /></h2><p>Which release of Rally this Mac is running.</p></div>
                <dl className="settings-diagnostics settings-list-card">
                  <div><dt><SettingLabel setting={settings.version} /></dt><dd>{runtime?.appVersion ?? 'Unknown'}</dd></div>
                </dl>
              </section>
            )}
          </div>
        </main>
        <Modal
          description={webhookRotationTarget
            ? 'Continue to replace the endpoint signing secret. The previous secret stops working immediately.'
            : `Create a ${webhookModalScope === 'workspace' ? 'workspace' : 'personal'} signed activity endpoint.`}
          footer={webhookSecretResult ? (
            <Button className="button-primary" onClick={() => setWebhookModalScope(null)}>Done</Button>
          ) : (
            <>
              <Button
                disabled={createWebhookConnection.isPending || rotateWebhookSecret.isPending}
                ref={webhookRefreshCancelRef}
                onClick={() => setWebhookModalScope(null)}
              >
                Cancel
              </Button>
              {webhookRotationTarget ? (
                <Button
                  className="button-primary"
                  disabled={rotateWebhookSecret.isPending}
                  onClick={() => rotateWebhookSecret.mutate(webhookRotationTarget)}
                >
                  {rotateWebhookSecret.isPending && <LoaderCircle aria-hidden="true" className="spin" size={14} />}
                  Continue
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
          initialFocusRef={webhookRotationTarget ? webhookRefreshCancelRef : undefined}
          onOpenChange={(open) => {
            if (open || createWebhookConnection.isPending || rotateWebhookSecret.isPending) return;
            setWebhookModalScope(null);
            setWebhookRotationTarget(null);
            setWebhookSecretResult(null);
          }}
          open={webhookModalScope !== null}
          title={webhookRotationTarget ? `Refresh ${webhookDisplayName}?` : 'Create inbound webhook'}
        >
          {webhookSecretResult ? (
            <div className="settings-list-card webhook-secret-result">
              <p>Copy the endpoint and secret now. Rally will not show this secret again.</p>
              <CopyField
                copyLabel="Copy endpoint"
                inputLabel="Webhook endpoint"
                label={<SettingLabel setting={settings.webhookEndpoint} />}
                value={webhookSecretResult.endpoint}
              />
              <CopyField
                copyLabel="Copy secret"
                inputLabel="Webhook signing secret"
                label={<SettingLabel setting={settings.webhookSecret} />}
                secret
                value={webhookSecretResult.signingSecret}
              />
              <small>Sign the exact UTF-8 JSON bytes using: <code>{webhookSecretResult.signatureFormat}</code></small>
            </div>
          ) : webhookRotationTarget ? (
            <p>Update the sender as soon as you rotate. Deliveries signed with the current secret will be rejected.</p>
          ) : (
            <>
              <label className="form-field" htmlFor="webhook-display-name">
                <span><SettingLabel setting={settings.webhookName} /></span>
                <input
                  autoFocus
                  id="webhook-display-name"
                  maxLength={180}
                  onChange={(event) => setWebhookDisplayName(event.currentTarget.value)}
                  value={webhookDisplayName}
                />
              </label>
              <label className="form-field" htmlFor="webhook-event-types">
                <span><SettingLabel setting={settings.webhookEvents} /> <small>(optional)</small></span>
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
          description={customMcpModalScope === 'workspace'
            ? 'Everyone in this workspace will be able to use this server’s tools, acting through the one authorization set up here.'
            : 'Only you will be able to use this server’s tools, acting as whoever you authorize as.'}
          footer={(
            <>
              <Button
                disabled={connectCustomMcp.isPending}
                onClick={() => setCustomMcpModalScope(null)}
              >
                Cancel
              </Button>
              <Button
                className="button-primary"
                disabled={!customMcpFormComplete || connectCustomMcp.isPending}
                onClick={() => connectCustomMcp.mutate()}
              >
                {connectCustomMcp.isPending && <LoaderCircle aria-hidden="true" className="spin" size={14} />}
                {customMcpAuthMode === 'oauth' ? 'Authorize server' : 'Add server'}
              </Button>
            </>
          )}
          onOpenChange={(open) => {
            if (open || connectCustomMcp.isPending) return;
            setCustomMcpModalScope(null);
          }}
          open={customMcpModalScope !== null}
          title="Connect an MCP server"
        >
          <label className="form-field" htmlFor="custom-mcp-name">
            <span><SettingLabel setting={settings.mcpName} /></span>
            <input
              autoFocus
              id="custom-mcp-name"
              maxLength={180}
              onChange={(event) => setCustomMcpName(event.currentTarget.value)}
              placeholder="Acme docs"
              value={customMcpName}
            />
            <small>How this connection is listed in Rally. The server is never asked what it is called.</small>
          </label>
          <label className="form-field" htmlFor="custom-mcp-url">
            <span><SettingLabel setting={settings.mcpUrl} /></span>
            <input
              id="custom-mcp-url"
              onChange={(event) => setCustomMcpServerUrl(event.currentTarget.value)}
              placeholder="https://mcp.example.com/mcp"
              spellCheck={false}
              value={customMcpServerUrl}
            />
            <small>The Streamable HTTP endpoint, over HTTPS. Rally checks it responds before saving anything.</small>
          </label>
          <label className="form-field" htmlFor="custom-mcp-auth-mode">
            <span><SettingLabel setting={settings.mcpAuth} /></span>
            <select
              id="custom-mcp-auth-mode"
              onChange={(event) => setCustomMcpAuthMode(event.currentTarget.value as 'oauth' | 'headers')}
              value={customMcpAuthMode}
            >
              <option value="oauth">{mcpAuthLabels.oauth}</option>
              <option value="headers">{mcpAuthLabels.headers}</option>
            </select>
            <small>
              {customMcpAuthMode === 'oauth'
                ? customMcpModalScope === 'workspace'
                  ? 'You authorize once, in your browser. The workspace shares the resulting token, so everybody reaches the server as the account you sign in with.'
                  : 'You authorize in your browser and Rally holds the resulting token for you alone.'
                : 'Sent with every request to this server and encrypted at rest. Rally never shows them again or returns them to this app.'}
            </small>
          </label>
          {customMcpAuthMode === 'headers' && (
            <div className="settings-list-card settings-custom-mcp-headers">
              {customMcpHeaders.map((header, index) => (
                <div className="settings-custom-mcp-header-row" key={index}>
                  <label className="form-field">
                    <span className="sr-only"><SettingLabel setting={settings.mcpHeaders} /></span>
                    <input
                      aria-label={`Header ${index + 1} name`}
                      onChange={(event) => {
                        // Read before the updater runs: React clears
                        // `currentTarget` once the handler returns, and the
                        // updater is called after that.
                        const name = event.currentTarget.value;
                        setCustomMcpHeaders((current) => current.map((entry, position) => (
                          position === index ? { ...entry, name } : entry
                        )));
                      }}
                      placeholder="Authorization"
                      spellCheck={false}
                      value={header.name}
                    />
                  </label>
                  <label className="form-field">
                    <span className="sr-only"><SettingLabel setting={settings.mcpHeaderValue} /></span>
                    <input
                      aria-label={`Header ${index + 1} value`}
                      autoComplete="off"
                      onChange={(event) => {
                        // Read before the updater runs: React clears
                        // `currentTarget` once the handler returns, and the
                        // updater is called after that.
                        const value = event.currentTarget.value;
                        setCustomMcpHeaders((current) => current.map((entry, position) => (
                          position === index ? { ...entry, value } : entry
                        )));
                      }}
                      placeholder="Bearer …"
                      spellCheck={false}
                      type="password"
                      value={header.value}
                    />
                  </label>
                  <button
                    aria-label={`Remove header ${index + 1}`}
                    disabled={customMcpHeaders.length === 1}
                    onClick={() => setCustomMcpHeaders((current) => current.filter((_, position) => position !== index))}
                    type="button"
                  >
                    <Trash2 aria-hidden="true" size={14} />
                  </button>
                </div>
              ))}
              <Button
                onClick={() => setCustomMcpHeaders((current) => [...current, { name: '', value: '' }])}
              >
                Add another header
              </Button>
            </div>
          )}
          {customMcpModalScope === 'workspace' && (
            <label className="form-field" htmlFor="custom-mcp-tool-policy">
              <span><SettingLabel setting={settings.mcpSetupPolicy} /></span>
              <select
                id="custom-mcp-tool-policy"
                onChange={(event) => setCustomMcpToolPolicy(event.currentTarget.value as CustomMcpToolPolicy)}
                value={customMcpToolPolicy}
              >
                <option value="all_tools">All tools</option>
                <option value="read_only_tools">Read-only tools</option>
              </select>
              <small>Changeable later. Read-only keeps just the tools the server marks read-only; either way every call asks first.</small>
            </label>
          )}
          {connectCustomMcp.error && <InlineError>{connectCustomMcp.error.message}</InlineError>}
        </Modal>
        {api && ashbyWorkspaceOpen && <AshbyWorkspaceSetup api={api} attemptId={ashbySetupKey} onSuccess={() => setAshbySetupKey(crypto.randomUUID())} onClose={() => setAshbyWorkspaceOpen(false)} onRecovered={setInstallationTarget} />}
        {api && installationTarget && <ConnectorInstallationDetails api={api} connectionId={installationTarget} connectionEnabled={connections.data?.some((connection) => connection.id === installationTarget && connection.status !== 'disabled') ?? false} onClose={() => setInstallationTarget(null)} />}
        <Modal
          description="A workspace-wide Granola connection requires a Workspace API key. Personal Granola connections use browser sign-in and do not need a key."
          footer={(
            <>
              <Button onClick={() => setGranolaWorkspaceModalOpen(false)}>Cancel</Button>
              <Button
                className="button-primary"
                disabled={!connectorApiKeyAcceptable('granola', granolaWorkspaceApiKey) || createGranolaWorkspaceConnection.isPending || granolaRecovery.isPending || granolaRecovery.isError}
                onClick={() => createGranolaWorkspaceConnection.mutate()}
              >
                {createGranolaWorkspaceConnection.isPending ? <LoaderCircle aria-hidden="true" className="spin" size={14} /> : <LockKeyhole aria-hidden="true" size={14} />}
                Connect for workspace
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
            <ConnectorApiKeyIssuingLink provider="granola" />
          </section>
          <ConnectorApiKeyField
            autoFocus
            help="Rally sends the key once to your regional API, encrypts it at rest, never returns it to the desktop, and registers a signed note-events webhook."
            id="granola-workspace-api-key"
            inputClassName="connector-key-input"
            inputLabel="Workspace API key"
            label={<SettingLabel setting={settings.granolaKey} />}
            onChange={setGranolaWorkspaceApiKey}
            provider="granola"
            value={granolaWorkspaceApiKey}
          />
          {createGranolaWorkspaceConnection.error && <InlineError>{createGranolaWorkspaceConnection.error.message}</InlineError>}
          {granolaRecovery.isPending && <p role="status">Checking for an existing workspace installation…</p>}
          {granolaRecovery.error && <><InlineError>Existing installations could not be checked. Check again before retrying setup.</InlineError><Button disabled={granolaRecovery.isPending} onClick={() => granolaRecovery.mutate()}>Find existing installation</Button></>}
        </Modal>
        <Modal
          description="You’ll be sent to the provider to authorize this connection again."
          footer={(
            <>
              <Button ref={reconnectCancelRef} onClick={() => setReconnectTarget(null)}>Cancel</Button>
              <Button
                className="button-primary"
                onClick={() => {
                  if (!reconnectTarget) return;
                  reconnectConnection.mutate(reconnectTarget);
                  setReconnectTarget(null);
                }}
              >
                <RefreshCcw aria-hidden="true" size={14} /> Continue
              </Button>
            </>
          )}
          initialFocusRef={reconnectCancelRef}
          onOpenChange={(open) => {
            if (!open) setReconnectTarget(null);
          }}
          open={Boolean(reconnectTarget)}
          title={`Refresh ${reconnectTarget?.displayName ?? 'this connection'}?`}
        />
        <Modal
          description={leavingClosesWorkspace
            ? `You are the last member. ${workspace.name} will close, and nobody will be able to open it again.`
            : `${workspace.name} stays available to its other members.`}
          footer={(
            <>
              <Button
                disabled={departWorkspace.isPending}
                onClick={() => {
                  setLeaveConfirmationOpen(false);
                  departWorkspace.reset();
                }}
              >
                Cancel
              </Button>
              <Button
                className="button-danger"
                disabled={departWorkspace.isPending}
                onClick={() => departWorkspace.mutate()}
              >
                {departWorkspace.isPending && <LoaderCircle aria-hidden="true" className="spin" size={14} />}
                {leavingClosesWorkspace ? 'Leave and close' : 'Leave workspace'}
              </Button>
            </>
          )}
          onOpenChange={(open) => {
            if (!open && !departWorkspace.isPending) {
              setLeaveConfirmationOpen(false);
              departWorkspace.reset();
            }
          }}
          open={leaveConfirmationOpen}
          title={leavingClosesWorkspace ? `Leave and close ${workspace.name}?` : `Leave ${workspace.name}?`}
        >
          {departWorkspace.error && <InlineError>{departWorkspace.error.message}</InlineError>}
        </Modal>
        <Modal
          description={disconnectTarget?.scope === 'workspace'
            ? 'This removes the connection and its tools from everyone in this workspace.'
            : 'This removes the connection and its tools from your Rally account.'}
          footer={(
            <>
              <Button
                disabled={disconnectConnection.isPending}
                onClick={() => {
                  setDisconnectTarget(null);
                  disconnectConnection.reset();
                }}
                ref={disconnectCancelRef}
              >
                Cancel
              </Button>
              <Button
                className="button-danger"
                disabled={disconnectConnection.isPending}
                onClick={() => {
                  if (disconnectTarget) disconnectConnection.mutate(disconnectTarget.id);
                }}
              >
                {disconnectConnection.isPending && <LoaderCircle aria-hidden="true" className="spin" size={14} />}
                Continue
              </Button>
            </>
          )}
          initialFocusRef={disconnectCancelRef}
          onOpenChange={(open) => {
            if (!open && !disconnectConnection.isPending) {
              setDisconnectTarget(null);
              disconnectConnection.reset();
            }
          }}
          open={Boolean(disconnectTarget)}
          title={`Delete ${disconnectTarget?.displayName ?? 'this connection'}?`}
        >
          {disconnectConnection.error && <InlineError>{disconnectConnection.error.message}</InlineError>}
        </Modal>
      </div>
    </div>
  );
}
