import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Tooltip from '@radix-ui/react-tooltip';
import {
  Building2,
  Check,
  Clock3,
  Copy,
  GitBranch,
  Globe2,
  LockKeyhole,
  LoaderCircle,
  LogOut,
  MailPlus,
  MonitorCog,
  Newspaper,
  PanelTop,
  Plug,
  Power,
  RefreshCcw,
  Search,
  ShieldCheck,
  Trash2,
  UserRound,
  Users,
  Wifi,
  Webhook,
  Wrench,
  X,
  type LucideIcon,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from 'react';
import type { ConnectorOAuthProvider, ConnectorOAuthStart } from '@rally/contracts';
import { parseDesktopSettingsSection } from '../../common/settings';
import type { DesktopSettingsSection } from '../../common/settings';
import type { DesktopApplicationSettings, DesktopTelemetryInspectorEntry } from '../../common/desktop';
import { Avatar, Badge, Button, ConnectorMark, DropdownSelect, EmptyState, InlineError, Modal } from '../components/primitives';
import { connectorBrandMark } from '../lib/plugin-marks';
import { ApplicationIconPicker } from '../components/application-icon-picker';
import { ThemePicker } from '../components/theme-picker';
import { DigestSettings } from '../components/digest-settings';
import { SLACK_PERSONAL_CAPABILITIES } from '../lib/slack-personal-capabilities';
import { useAppSession } from '../lib/app-session';
import { ApiError } from '../lib/api';
import { useClientFeatureFlags } from '../lib/use-client-feature-flags';
import { desktopBridge } from '../lib/platform';
import { useOptionalWorkspaceSocket } from '../lib/workspace-socket';
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

interface PendingConnectorOAuth {
  attemptId: string;
  provider: ConnectorOAuthProvider;
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
  searchTerms: string;
  icon: LucideIcon;
  child?: boolean;
}

const settingsNavigation: Array<{ label: string; items: SettingsNavItem[] }> = [
  {
    label: 'Settings',
    items: [
      { id: 'account', label: 'Account', searchTerms: 'profile identity email sign out', icon: UserRound },
      // Directly under Account, because a digest is a personal preference like
      // the timezone it borrows — not a workspace-level setting.
      { id: 'digest', label: 'Digest', searchTerms: 'digest summary email schedule times days notifications updates slack deliver', icon: Newspaper },
      { id: 'workspace', label: 'Workspace', searchTerms: 'region data residency organization members invitations invite roles', icon: Users },
      { id: 'connections', label: 'Connections', searchTerms: 'connectors google github granola meetings notes linear notion slack x integrations', icon: Plug },
    ],
  },
  {
    label: 'Desktop app',
    items: [
      { id: 'application', label: 'Application', searchTerms: 'app security privacy analytics telemetry crash diagnostics lockdown encryption keychain session icon appearance menu bar status item startup login dock customize version platform api realtime', icon: MonitorCog },
    ],
  },
];

/** Words that only lead somewhere while the Developer section is on offer. They
 * are appended to Application rather than written into it, so searching "debug"
 * cannot send someone the flag excludes to a pane that has no such section. */
const developerSectionSearchTerms = 'developer debug identifiers';

function navigationSearchTerms(item: SettingsNavItem, developerSettingsAvailable: boolean): string {
  return item.id === 'application' && developerSettingsAvailable
    ? `${item.searchTerms} ${developerSectionSearchTerms}`
    : item.searchTerms;
}

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
    mark: 'google' as const,
    scopes: ['you'] as const,
    capabilities: ['gmail.read', 'gmail.draft', 'gmail.send', 'calendar.read', 'calendar.write'],
  },
  {
    id: 'google-drive-workspace' as const,
    provider: 'google' as const,
    name: 'Google Drive + Docs + Sheets',
    description: 'Read Drive files and work with Google Docs and Sheets content.',
    mark: 'google-drive' as const,
    scopes: ['you', 'workspace'] as const,
    capabilities: ['drive.read', 'docs.read', 'docs.write', 'sheets.read', 'sheets.write'],
  },
  {
    id: 'github' as const,
    provider: 'github' as const,
    name: 'GitHub',
    description: 'Repositories, issues, pull requests, checks, and development events.',
    mark: 'github' as const,
    scopes: ['you', 'workspace'] as const,
    capabilities: ['github.metadata.read', 'github.contents.read', 'github.issues.read', 'github.issues.write', 'github.pull_requests.read', 'github.pull_requests.write', 'github.actions.read', 'github.checks.read'],
  },
  {
    id: 'granola' as const,
    provider: 'granola' as const,
    name: 'Granola',
    description: 'Personal meeting context through Granola MCP, or workspace notes and transcripts through an admin API key.',
    mark: 'granola' as const,
    scopes: ['you', 'workspace'] as const,
    personalCapabilities: ['granola.personal.read'],
    capabilities: ['granola.workspace.read'],
  },
  {
    id: 'linear' as const,
    provider: 'linear' as const,
    name: 'Linear',
    description: 'Connect personally to act as you, or install Rally for shared workspace access and real-time activity.',
    mark: 'linear' as const,
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
    description: 'Messages, files, people, canvases, conversations, and the Rally workspace Agent.',
    mark: 'slack' as const,
    scopes: ['you', 'workspace'] as const,
    personalCapabilities: SLACK_PERSONAL_CAPABILITIES,
    capabilities: ['slack.agent', 'slack.notifications.write'],
  },
  {
    id: 'notion' as const,
    provider: 'notion' as const,
    name: 'Notion',
    description: 'Your Notion through its live MCP tools, or selected pages and change notifications shared with your Rally workspace.',
    mark: 'notion' as const,
    scopes: ['you', 'workspace'] as const,
    personalCapabilities: ['notion.personal.mcp'],
    capabilities: ['notion.read', 'notion.insert', 'notion.update', 'notion.comment.read', 'notion.comment.insert'],
  },
  {
    id: 'generic-webhook' as const,
    provider: 'generic_webhook' as const,
    name: 'Inbound webhook',
    description: 'Receive signed activity from systems that do not have a native Rally connector.',
    icon: Webhook,
    scopes: ['you', 'workspace'] as const,
    capabilities: [],
  },
  {
    id: 'x' as const,
    provider: 'x' as const,
    name: 'Public X via TwitterAPI.io',
    description: 'Read-only public X timelines, threads, replies, and Lists using a Rally-managed third-party API key.',
    mark: 'x' as const,
    scopes: ['workspace'] as const,
    capabilities: ['x.read'],
  },
] as const;

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
  return mark ? <ConnectorMark className="settings-connection-mark" mark={mark} /> : null;
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

function providerHasAvailableUnconnectedScope(
  provider: (typeof connectorProviders)[number],
  connections: WorkstreamConnection[],
  isAdmin: boolean,
): boolean {
  return provider.scopes.some((scope) =>
    (scope === 'you' || isAdmin) && !providerHasConnectionForScope(provider, connections, scope),
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

/** Input types Escape may close the window over: the rest hold no typing. */
const TEXT_ENTRY_INPUT_TYPES = new Set(['email', 'number', 'password', 'search', 'tel', 'text', 'url']);

function holdsUnsavedText(target: Element | null): boolean {
  if (target instanceof HTMLTextAreaElement) return target.value.trim() !== '';
  if (target instanceof HTMLInputElement) {
    return TEXT_ENTRY_INPUT_TYPES.has(target.type) && target.value.trim() !== '';
  }
  return target instanceof HTMLElement && target.isContentEditable;
}

/**
 * Whether the visible settings pane holds typing, wherever focus happens to be.
 *
 * A draft is abandoned by the window closing, not by the caret leaving it: an
 * invitation typed and then left while its Role select or Send button takes
 * focus is the same unsaved text it was a keystroke earlier. Scoping the sweep
 * to the pane is what keeps that from becoming "any text anywhere" — the
 * sidebar's search box is a filter rather than a draft, a generated endpoint or
 * signing secret is `readOnly` and already saved, and Radix portals every
 * dialog's fields out of this subtree, where an open dialog owns Escape anyway.
 * A pane that is not the active one is not in the DOM, so what is protected is
 * what the person can see.
 */
function paneHoldsUnsavedText(pane: Element | null): boolean {
  if (!pane) return false;
  return [...pane.querySelectorAll('input, textarea')].some((field) => {
    if (field instanceof HTMLInputElement && !TEXT_ENTRY_INPUT_TYPES.has(field.type)) return false;
    const editable = field as HTMLInputElement | HTMLTextAreaElement;
    const savedValue = editable.dataset.savedValue;
    if (savedValue !== undefined) return !editable.readOnly && !editable.disabled && editable.value !== savedValue;
    return !editable.readOnly && !editable.disabled && editable.value.trim() !== '';
  });
}

/**
 * Whether an Escape keystroke is a request to close the Settings window.
 *
 * macOS spends Escape on *cancelling* — a sheet, a popover, an operation in
 * flight — and closes an ordinary window like this one with Command-W, so
 * Escape here is a convenience rather than the platform gesture. It is offered
 * because every other desktop application has trained people to expect it, and
 * it is answered only when nothing nearer has a claim on the keystroke:
 *
 * - Radix renders dialogs and select menus into portals and dismisses them on
 *   Escape itself. That keystroke belongs to the layer on top; taking the
 *   window with it would close Settings out from under a confirmation.
 * - Settings applies every change immediately and has no undo. An Escape aimed
 *   at a half-written invitation, endpoint, or API key would discard text with
 *   nowhere else to come from — the loss Apple's rule exists to prevent. The
 *   focused element is checked for the sidebar's search box, which sits outside
 *   the pane; the pane itself is swept because a draft does not stop being one
 *   when focus moves off it.
 */
export function escapeClosesSettings(event: KeyboardEvent, pane: Element | null): boolean {
  if (event.key !== 'Escape' || event.defaultPrevented) return false;
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false;
  const target = event.target instanceof Element ? event.target : null;
  const dismissableLayer = target?.closest(
    '[role="dialog"], [role="alertdialog"], [role="listbox"], [role="menu"], [data-radix-popper-content-wrapper]',
  );
  return !dismissableLayer && !holdsUnsavedText(target) && !paneHoldsUnsavedText(pane);
}

export function WorkspaceSettingsScreen({
  standaloneWindow = false,
  workspace,
}: { standaloneWindow?: boolean; workspace: Workspace }): React.JSX.Element {
  const { api, runtime, session, signOut } = useAppSession();
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
  const [copied, setCopied] = useState(false);
  const [userTimezone, setUserTimezone] = useState(workspace.currentUser.timezone);
  const [workspaceTimezone, setWorkspaceTimezone] = useState(workspace.timezone);
  const [terminalMode, setTerminalMode] = useState<'trusted_only' | 'full_internet'>('trusted_only');
  const [terminalDomains, setTerminalDomains] = useState('');
  const [terminalPreview, setTerminalPreview] = useState<TerminalNetworkPolicyPreview | null>(null);
  const terminalPolicyDirty = useRef(false);
  const [applicationSettings, setApplicationSettings] = useState<DesktopApplicationSettings | null>(null);
  const [telemetryInspector, setTelemetryInspector] = useState<DesktopTelemetryInspectorEntry[]>([]);
  const [telemetryInspectorLoading, setTelemetryInspectorLoading] = useState(false);
  const [telemetryInspectorError, setTelemetryInspectorError] = useState<string | null>(null);
  const telemetryInspectorRequest = useRef(0);
  const [applicationSettingsLoadError, setApplicationSettingsLoadError] = useState<string | null>(null);
  const [pendingConnectorOAuth, setPendingConnectorOAuth] = useState<PendingConnectorOAuth | null>(null);
  const [reconnectTarget, setReconnectTarget] = useState<WorkstreamConnection | null>(null);
  const [disconnectTarget, setDisconnectTarget] = useState<WorkstreamConnection | null>(null);
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
  const githubSettingsConnections = useMemo(
    () => (connections.data ?? []).filter((connection) => (
      connection.settingsKind === 'github_repository_access'
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
  const terminalSettings = useQuery({
    queryKey: ['terminal-workspace-settings'],
    queryFn: ({ signal }) => api!.getTerminalWorkspaceSettings(signal),
    enabled: Boolean(api && activeSection === 'workspace'),
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
    onMutate: () => {
      setConnectorOAuthMessage(null);
      setConnectorOAuthError(null);
    },
    onSuccess: ({ authorization, provider }) => setPendingConnectorOAuth({
      attemptId: authorization.attemptId,
      provider,
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
  const updateLockdownMode = useMutation({
    mutationFn: (enabled: boolean) => bridge.setLockdownMode(enabled),
    onSuccess: setApplicationSettings,
  });
  const updateDebugEnabled = useMutation({
    mutationFn: (enabled: boolean) => bridge.setDebugEnabled(enabled),
    onSuccess: setApplicationSettings,
  });
  const updateMenuBarEnabled = useMutation({
    mutationFn: (enabled: boolean) => bridge.setMenuBarEnabled(enabled),
    onSuccess: setApplicationSettings,
  });
  const updateLaunchAtLogin = useMutation({
    mutationFn: (enabled: boolean) => bridge.setLaunchAtLogin(enabled),
    onSuccess: setApplicationSettings,
  });
  const updateProductAnalytics = useMutation({
    mutationFn: (enabled: boolean) => bridge.setProductAnalyticsEnabled(enabled),
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
                searchTerms: 'github repositories remote read only full access push pull request',
                icon: GitBranch,
                child: true,
              }]
            : [item]),
        };
    // Dropped from the list entirely rather than shown disabled: their digest
    // has in fact stopped arriving (`fireDigestSchedule` reads this same flag
    // and returns `flag_disabled`), but there is no copy in this screen for a
    // paused state, and an absent section is still an honest answer to "is
    // this available to me."
    return digestSettingsAvailable
      ? withGithub
      : { ...withGithub, items: withGithub.items.filter((item) => item.id !== 'digest') };
  }), [githubSettingsConnections.length, digestSettingsAvailable]);
  const filteredNavigation = useMemo(() => {
    const query = navigationQuery.trim().toLowerCase();
    if (!query) return settingsNavigationWithConnectors;
    return settingsNavigationWithConnectors
      .map((group) => ({
        ...group,
        items: group.items.filter((item) =>
          `${item.label} ${navigationSearchTerms(item, developerSettingsAvailable)}`
            .toLowerCase()
            .includes(query)),
      }))
      .filter((group) => group.items.length > 0);
  }, [navigationQuery, developerSettingsAvailable, settingsNavigationWithConnectors]);
  const availableSections = useMemo(
    () => new Set(filteredNavigation.flatMap((group) => group.items.map((item) => item.id))),
    [filteredNavigation],
  );
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
    const first = filteredNavigation[0]?.items[0]?.id;
    if (first) setActiveSection(first);
  }, [activeSection, availableSections, filteredNavigation]);

  // Only the Settings window closes on Escape. The same screen is also a route
  // inside the main window on surfaces with no separate window to open, and
  // there the keystroke would shut the workspace itself.
  useEffect(() => {
    if (!standaloneWindow) return undefined;
    const close = (event: KeyboardEvent): void => {
      if (escapeClosesSettings(event, contentRef.current)) window.close();
    };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [standaloneWindow]);

  useEffect(() => bridge.onSettingsSectionRequested((section) => {
    const nextSection = parseDesktopSettingsSection(section);
    if (!nextSection) return;
    setNavigationQuery('');
    setActiveSection(nextSection);
  }), [bridge]);

  const loadTelemetryInspector = useCallback(async (): Promise<void> => {
    const request = telemetryInspectorRequest.current + 1;
    telemetryInspectorRequest.current = request;
    setTelemetryInspectorLoading(true);
    setTelemetryInspectorError(null);
    try {
      const entries = await bridge.getTelemetryInspector();
      if (telemetryInspectorRequest.current === request) setTelemetryInspector(entries);
    } catch (error) {
      if (telemetryInspectorRequest.current === request) {
        setTelemetryInspectorError(
          error instanceof Error ? error.message : 'Telemetry decisions could not be loaded.',
        );
      }
    } finally {
      if (telemetryInspectorRequest.current === request) setTelemetryInspectorLoading(false);
    }
  }, [bridge]);

  useEffect(() => {
    if (!applicationSettings?.developerSettingsAvailable) {
      telemetryInspectorRequest.current += 1;
      setTelemetryInspector([]);
      setTelemetryInspectorError(null);
      setTelemetryInspectorLoading(false);
      return;
    }
    void loadTelemetryInspector();
  }, [applicationSettings?.developerSettingsAvailable, loadTelemetryInspector]);

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
    const providerName = connectorProviderName[pendingConnectorOAuth.provider];

    const reconcile = async (): Promise<void> => {
      try {
        const attempt = await api.getConnectorOAuthAttempt(pendingConnectorOAuth.attemptId);
        if (cancelled) return;
        if (attempt.status === 'pending') return;
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
        if (!cancelled) {
          setConnectorOAuthError(`${providerName} authorization could not be confirmed. Refresh connections or try again.`);
        }
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
    workspaceSocket?.state,
    workspaceSocket?.topicWaterlines.connector_oauth_attempts,
  ]);

  const copyInvitation = async (): Promise<void> => {
    if (!createdUrl) return;
    await desktopBridge().copyText(createdUrl);
    setCopied(true);
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
                      className={item.child ? 'settings-navigation-child' : undefined}
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
                <div className="settings-pane-heading"><h2>Profile</h2><p>Your Rally identity and access in this workspace.</p></div>
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
                    <span className="settings-row-copy"><strong>Sign out of Rally</strong><small>Remove the local session from this Mac.</small></span>
                    <Button onClick={() => void signOut()}>Sign out</Button>
                  </div>
                </div>
              </section>
            )}

            {activeSection === 'digest' && api && digestSettingsAvailable && (
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
                      <small>The shared Rally workspace active in this desktop app.</small>
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
                </div>
                {updateWorkspaceTimezone.error && <InlineError>{updateWorkspaceTimezone.error.message}</InlineError>}
                <div className="settings-pane-heading settings-pane-heading-spaced">
                  <h2>Terminal network access</h2>
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
                        <span><strong>Trusted only</strong><small>Rally-managed platform access plus domains your workspace approves.</small></span>
                      </label>
                      <label>
                        <input checked={terminalMode === 'full_internet'} name="terminal-network-mode" onChange={() => { terminalPolicyDirty.current = true; setTerminalMode('full_internet'); setTerminalPreview(null); }} type="radio" />
                        <span><strong>Full internet</strong><small>Allow arbitrary public destinations. Private network access remains blocked by Daytona.</small></span>
                      </label>
                    </fieldset>
                    {terminalMode === 'trusted_only' && (
                      <div className="terminal-network-domains">
                        <label>
                          <span>Workspace-approved domains</span>
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
                  <div><h2>Your connections</h2><p>Credentials currently available to you or this workspace.</p></div>
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
                              <th className="settings-connection-capabilities" scope="col">Capabilities</th>
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
                                    <span className="settings-connection-copy"><strong>{connection.displayName}</strong></span>
                                  </span>
                                </td>
                                <td><Badge>{connection.status === 'reconnect_required' ? 'Reconnect required' : connection.status}</Badge></td>
                                <td className="settings-connection-capabilities">{connection.capabilities?.length ?? 0} capabilities</td>
                                <td>
                                  <span className="settings-connection-actions">
                                    {isAdmin && reconnectableConnectorTypes.has(connection.connectorType)
                                      && !(connection.connectorType === 'granola' && connection.scope === 'workspace') && (
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
                                          setWebhookCopied(null);
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
                    <div className="settings-segmented" role="group" aria-label="Filter connections">
                      {([
                        ['not_connected', 'Not connected'],
                        ['connected', 'Connected'],
                        ['all', 'All'],
                      ] as const).map(([value, label]) => (
                        <button aria-pressed={connectionFilter === value} key={value} onClick={() => setConnectionFilter(value)} type="button">{label}</button>
                      ))}
                    </div>
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
                      const personalConnectionStateUnavailable = provider.provider === 'granola' && (connections.isLoading || connections.isError);
                      const personalConnectDisabled = !providerAvailable || personalConnectionStateUnavailable || connectProvider.isPending || Boolean(pendingConnectorOAuth) || hasActivePersonalConnection;
                      const personalConnectTitle = hasActivePersonalConnection
                        ? `A ${provider.name} personal connection is already installed. Manage it above.`
                        : !providerAvailable && !connectorCatalog.isLoading
                          ? `${provider.name} is not configured in this Rally region.`
                        : provider.provider === 'granola' && connections.isLoading
                          ? 'Checking installed personal connections…'
                          : provider.provider === 'granola' && connections.isError
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
                                ? <ConnectorMark className="provider-mark" mark={mark} />
                                : Icon && <Icon aria-hidden="true" size={18} />}
                            </div>
                            <div><strong>{provider.name}</strong><span>{awaitingProvider ? 'Waiting for authorization' : connected ? 'Connected' : connectorCatalog.isLoading ? 'Checking availability' : providerAvailable ? 'Available' : 'Unavailable'}</span></div>
                          </div>
                          <p>{provider.description}</p>
                            <div className="provider-actions">
                              {provider.scopes.includes('you' as never) && (
                                <ConnectorButton
                                  disabled={personalConnectDisabled}
                                  label="Connect for me"
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
                                  tooltip={`Only you can use this connection; it acts with your provider identity.${personalConnectTitle ? ` ${personalConnectTitle}` : ''}`}
                                >{awaitingProvider ? <><LoaderCircle aria-hidden="true" className="spin" size={13} /> Waiting…</> : 'Connect for me'}</ConnectorButton>
                              )}
                            {provider.scopes.includes('workspace' as never) && isAdmin && (
                              <ConnectorButton
                                disabled={workspaceConnectDisabled}
                                label="Connect workspace"
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
                                tooltip={`Everyone in this workspace can use this connection; it acts for the workspace.${workspaceConnectTitle ? ` ${workspaceConnectTitle}` : ''}`}
                              >
                                Connect workspace
                              </ConnectorButton>
                            )}
                          </div>
                        </article>
                      );
                    })}
                    {visibleProviders.length === 0 && <EmptyState title="No connectors here" description="Change the filter to see other available providers." />}
                  </div>
                </div>
                {connectorOAuthMessage && <p className="settings-oauth-status" role="status"><Check aria-hidden="true" size={14} />{connectorOAuthMessage}</p>}
                {(connectorOAuthError || connections.error || connectorCatalog.error || connectProvider.error || createGranolaWorkspaceConnection.error || createWebhookConnection.error || rotateWebhookSecret.error || reconnectConnection.error) && (
                  <InlineError>{connectorOAuthError ?? connections.error?.message ?? connectorCatalog.error?.message ?? connectProvider.error?.message ?? createGranolaWorkspaceConnection.error?.message ?? createWebhookConnection.error?.message ?? rotateWebhookSecret.error?.message ?? reconnectConnection.error?.message}</InlineError>
                )}
              </section>
            )}

            {activeSection === 'github' && (
              <section aria-labelledby="settings-title" className="settings-pane settings-github-pane">
                <div className="settings-pane-heading">
                  <h2>Repository access</h2>
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
                        <span className="settings-row-icon"><GitBranch aria-hidden="true" size={18} /></span>
                        <span className="settings-row-copy">
                          <strong>Repository availability</strong>
                          <small>All repositories follows the GitHub App installation. Selected repositories exposes only the entries you add below.</small>
                        </span>
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
                          <option value="all_repositories">All repositories</option>
                          <option value="selected_repositories">Selected repositories</option>
                        </select>
                      </label>
                      {githubSettings.mode === 'all_repositories' && (
                        <label className="settings-preference-row">
                          <span className="settings-row-icon"><LockKeyhole aria-hidden="true" size={18} /></span>
                          <span className="settings-row-copy">
                            <strong>Default remote access</strong>
                            <small>Read-only still allows Rally to edit and commit locally. It blocks push, pull requests, issues, reviews, and other remote mutations.</small>
                          </span>
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
                            <option value="read_only">Read-only remote</option>
                            <option value="full_access">Full remote access</option>
                          </select>
                        </label>
                      )}
                    </div>
                    <div className="settings-github-repository-heading">
                      <div>
                        <strong>Repositories</strong>
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
                                  <option value="read_only">Read-only remote</option>
                                  <option value="full_access">Full remote access</option>
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

            {activeSection === 'application' && (
              <section aria-labelledby="settings-title" className="settings-pane">
                <div className="settings-pane-heading"><h2>Security</h2><p>Choose how Rally protects the saved authentication session on this Mac.</p></div>
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
                          : 'Protect the saved session with this Mac’s keystore instead of Rally’s shared encryption key.'}
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
                <div className="settings-pane-heading settings-pane-heading-spaced"><h2>Privacy & diagnostics</h2><p>Control product analytics and detailed crash reporting for your account.</p></div>
                <div className="settings-list-card">
                  <label className="settings-preference-row">
                    <span className="settings-row-icon"><ShieldCheck aria-hidden="true" size={18} /></span>
                    <span className="settings-row-copy">
                      <strong>Product analytics</strong>
                      <small>
                        Share semantic product usage, sanitized errors and breadcrumbs, and native crash reports. Global telemetry can include your verified name and email so Rally can contact you; EU telemetry stays in Rally’s EU platform. Essential content-free reliability signals continue when this is off.
                      </small>
                    </span>
                    <span className="settings-toggle">
                      <input
                        aria-label="Product analytics"
                        checked={applicationSettings?.productAnalyticsEnabled ?? true}
                        disabled={
                          applicationSettings?.productAnalyticsAvailable === false
                          || applicationSettings === null
                          || updateProductAnalytics.isPending
                        }
                        onChange={(event) => updateProductAnalytics.mutate(event.currentTarget.checked)}
                        role="switch"
                        type="checkbox"
                      />
                      <span aria-hidden="true" />
                    </span>
                  </label>
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
                {applicationSettings?.menuBarAvailable !== false && (
                  <>
                    <div className="settings-list-card">
                      <label className="settings-preference-row">
                        <span className="settings-row-icon"><PanelTop aria-hidden="true" size={18} /></span>
                        <span className="settings-row-copy">
                          <strong>Show Rally in the menu bar</strong>
                          <small>Keep the Rally mark in the menu bar for a new meeting or note, a new automation, what Rally suggests next, and your recent work streams.</small>
                        </span>
                        <span className="settings-toggle">
                          <input
                            aria-label="Show Rally in the menu bar"
                            checked={applicationSettings?.menuBarEnabled ?? true}
                            /* One preference file behind all three toggles, and
                             * a Lockdown transition holds it for as long as it
                             * takes to re-encrypt the session. Keep one write in
                             * flight. */
                            disabled={
                              applicationSettings === null
                              || updateMenuBarEnabled.isPending
                              || updateLockdownMode.isPending
                            }
                            onChange={(event) => updateMenuBarEnabled.mutate(event.currentTarget.checked)}
                            role="switch"
                            type="checkbox"
                          />
                          <span aria-hidden="true" />
                        </span>
                      </label>
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
                {applicationSettings?.launchAtLoginAvailable !== false && (
                  <>
                    <div className="settings-pane-heading settings-pane-heading-spaced"><h2>Startup</h2><p>Decide whether this Mac starts Rally for you.</p></div>
                    <div className="settings-list-card">
                      <label className="settings-preference-row">
                        <span className="settings-row-icon"><Power aria-hidden="true" size={18} /></span>
                        <span className="settings-row-copy">
                          <strong>Open Rally at login</strong>
                          <small>Start Rally when you log in. With Rally in the menu bar it starts there quietly, with no window; without it, a window opens as usual.</small>
                        </span>
                        <span className="settings-toggle">
                          <input
                            aria-label="Open Rally at login"
                            /* macOS owns this, not Rally's preference file, so
                             * the checked state is what the system reports back
                             * after the write — which is how a registration it
                             * is still waiting to have approved shows honestly. */
                            checked={applicationSettings?.launchAtLogin ?? false}
                            disabled={
                              applicationSettings === null
                              || updateLaunchAtLogin.isPending
                              || updateLockdownMode.isPending
                            }
                            onChange={(event) => updateLaunchAtLogin.mutate(event.currentTarget.checked)}
                            role="switch"
                            type="checkbox"
                          />
                          <span aria-hidden="true" />
                        </span>
                      </label>
                    </div>
                    {updateLaunchAtLogin.error && <InlineError>{updateLaunchAtLogin.error.message}</InlineError>}
                  </>
                )}
                {/* The service decides whether this section exists at all, and
                  * answers on a poll, so it can appear or disappear without the
                  * window reloading. It is absent rather than disabled: a
                  * section nobody outside Juno can turn on is not a control
                  * that happens to be unavailable. */}
                {applicationSettings?.developerSettingsAvailable && (
                  <>
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
                            checked={applicationSettings.debugEnabled}
                            /* A Lockdown transition re-encrypts every durable session
                             * component, so it stays pending long enough to click this.
                             * Both preferences write one file; keep one in flight. */
                            disabled={updateDebugEnabled.isPending || updateLockdownMode.isPending}
                            onChange={(event) => updateDebugEnabled.mutate(event.currentTarget.checked)}
                            role="switch"
                            type="checkbox"
                          />
                          <span aria-hidden="true" />
                        </span>
                      </label>
                    </div>
                    {updateDebugEnabled.error && <InlineError>{updateDebugEnabled.error.message}</InlineError>}
                    <div className="settings-pane-heading settings-pane-heading-spaced">
                      <div><h3>Telemetry inspector</h3><p>Recent contract decisions only. Values and identifiers are always redacted.</p></div>
                      <Button
                        aria-label="Refresh telemetry inspector"
                        disabled={telemetryInspectorLoading}
                        onClick={() => void loadTelemetryInspector()}
                      >
                        <RefreshCcw aria-hidden="true" className={telemetryInspectorLoading ? 'spin' : undefined} size={14} />
                        Refresh
                      </Button>
                    </div>
                    {telemetryInspectorError && <InlineError>{telemetryInspectorError}</InlineError>}
                    {telemetryInspectorLoading && telemetryInspector.length === 0 ? (
                      <div className="settings-list-card"><p role="status">Loading telemetry decisions…</p></div>
                    ) : telemetryInspector.length === 0 ? (
                      <div className="settings-list-card"><p>No telemetry decisions in this process yet.</p></div>
                    ) : (
                      <dl className="settings-list-card settings-diagnostics">
                        {telemetryInspector.map((entry, index) => (
                          <div key={`${entry.name}-${index}`}>
                            <dt>{entry.name}</dt>
                            <dd>
                              {entry.propertyNames.join(', ') || 'No properties'}
                              <small>{entry.route === 'eu' ? 'EU' : 'Global'} · {entry.validation} · {entry.queueState}</small>
                            </dd>
                          </div>
                        ))}
                      </dl>
                    )}
                  </>
                )}
                <div className="settings-pane-heading settings-pane-heading-spaced"><h2>About</h2><p>Build and service details for this Rally installation.</p></div>
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
            setWebhookCopied(null);
          }}
          open={webhookModalScope !== null}
          title={webhookRotationTarget ? `Refresh ${webhookDisplayName}?` : 'Create inbound webhook'}
        >
          {webhookSecretResult ? (
            <div className="settings-list-card">
              <p>Copy the endpoint and secret now. Rally will not show this secret again.</p>
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
            <small>Rally sends the key once to your regional API, encrypts it at rest, never returns it to the desktop, and registers a signed note-events webhook.</small>
          </label>
          {createGranolaWorkspaceConnection.error && <InlineError>{createGranolaWorkspaceConnection.error.message}</InlineError>}
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
