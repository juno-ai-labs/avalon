import { startConnectorAuthorization } from '../lib/start-connector-authorization';
import { useDocumentTitle } from '../lib/document-title';
import { AshbyWorkspaceSetup, ConnectorInstallationDetails, useWorkspaceInstallationRecovery } from '../components/connector-installation';
import { ConnectorApiKeyField, ConnectorApiKeyIssuingLink } from '../components/connector-api-key-field';
import { CopyButton, CopyField } from '../components/copy-button';
import { SupportAccessSetting } from '../components/support-access-setting';
import { MemoryFactList, useMemoryFacts } from '../components/memory-review';
import { CANVA_CONNECTION_DISCLOSURE, connectorProviders, PERSONAL_CONNECT_LABEL } from '../lib/connector-catalog';
import { PersonalSetup } from './guided-onboarding';
import { githubAvailabilityLabels, githubRemoteLabels, mcpAuthLabels } from '../settings/choices';
import { SettingToggle } from '../settings/setting-toggle';
import { useMemberPreferences, useSaveMemberPreferences } from '../lib/use-member-preferences';
import { settings, collectSettings, coreSettingsProvider, defineSetting, isSettingAvailable, searchSettings, type SettingSearchResult, type SettingsSearchContext } from '../settings/registry';
import { SettingCopy, SettingLabel } from '../settings/setting-label';
import { SettingsSearchResults, useRevealSetting } from '../settings/search-results';
import { SidebarSearch } from '../components/sidebar-search';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import * as Tooltip from '@radix-ui/react-tooltip';
import {
  LockKeyhole,
  LoaderCircle,
  MailPlus,
  Menu,
  MonitorCog,
  Bell,
  ChevronRight,
  Ellipsis,
  Plug,
  RefreshCcw,
  Search,
  ShieldCheck,
  Trash2,
  UserRound,
  Users,
  UsersRound,
  Webhook,
  X,
  type LucideIcon,
} from 'lucide-react';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ButtonHTMLAttributes,
  type ReactNode,
} from 'react';
import { ConnectorEventConsoleProviders, ConnectorInstallationProviders, WorkspaceNameSchema, connectorApiKeyAcceptable } from '@rally/contracts';
import type {
  ConnectorOAuthStart,
  CustomMcpToolPolicy,
  MemoryReview,
} from '@rally/contracts';
import { parseDesktopSettingsSection } from '../../common/settings';
import type { DesktopSettingsSection } from '../../common/settings';
import type { DesktopApplicationSettings } from '../../common/desktop';
import { parseDesktopReleaseChannel, type DesktopReleaseChannel } from '../../common/release-channels';
import { Avatar, Badge, Button, ConnectorMark, DropdownSelect, EmptyState, IconButton, ErrorNotice, Modal, SegmentedControl, Tip } from '../components/primitives';
import { connectorBrandMark, type PluginBrandMark } from '../lib/plugin-marks';
import { ApplicationIconPicker } from '../components/application-icon-picker';
import { ThemePicker } from '../components/theme-picker';
import { NotificationChannelSettings } from '../components/notification-settings';
import { UsageSettingsSection } from '../components/organization-usage';
import { InlineEditableText } from '../components/inline-editable-text';
import { useAppSession } from '../lib/app-session';
import { useShellCapabilities } from '../lib/collaboration-session';
import { useCloseWindowSurface } from '../lib/window-surface';
import { invalidateCachedWorkstreamDetails } from '../lib/workstreams-cache';
import { ApiError, type RallyApi } from '../lib/api';
import { useClientFeatureFlags } from '../lib/use-client-feature-flags';
import { desktopBridge } from '../lib/platform';
import { AboutRally } from '../components/easter-eggs/about-credits';
import { MAC_APP_CONNECT_NOTE, MAC_APP_DOWNLOADABLE, MAC_APP_DOWNLOAD_URL, connectorStartsHere } from '../lib/browser-connectors';
import { disableWebPush, enableWebPush, webPushState } from '../lib/web-push';
import { useOptionalWorkspaceSocket } from '../lib/workspace-socket';
import { useEscapeClosesWindow } from '../lib/window-escape';
import { useWorkspaceMembers } from '../lib/workspace-members';
import type {
  GitHubRepositoryAccessSettings,
  TerminalWorkspaceSettings,
  Workspace,
  WorkspaceInvitation,
  WorkstreamConnection,
} from '../lib/types';
import { deviceTimezone, MY_TIMEZONE_QUERY_KEY } from '../lib/device-timezone';

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
 * Whether this screen offers a window onto that provider's workspace events.
 *
 * `hasInstallationFacet` says the provider has an installation at all, which
 * stays true of every connection a workspace already made. This asks the
 * narrower product question, and the contract answers it: an installation that
 * runs on its own — Granola's, and Fireflies', whose workspace scope is closed
 * besides — keeps receiving its events without anybody being handed a webhook
 * console over them.
 */
const eventConsoleProviders = new Set<string>(ConnectorEventConsoleProviders);
function hasWorkspaceInstallationSurface(connectorType: string): boolean {
  return eventConsoleProviders.has(connectorType);
}

const reconnectableConnectorTypes = new Set<WorkstreamConnection['connectorType']>([
  'apollo',
  'ashby',
  'canva',
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

/** A row under the Mac's notification toggle saying why macOS is not showing them, with the way to fix it. */
function MacNotificationNotice({ title, detail, onOpen }: {
  title: string;
  detail: string;
  onOpen?: () => void;
}): React.JSX.Element {
  return (
    <div className="settings-preference-row">
      <span className="settings-row-copy">
        <strong>{title}</strong>
        <small>{detail}</small>
      </span>
      {onOpen && <Button onClick={onOpen}>Open System Settings</Button>}
    </div>
  );
}

/** Settings → Notifications in a browser tab: this browser's Web Push subscription. */
function BrowserNotificationsSetting({ api }: { api: RallyApi }): React.JSX.Element {
  const queryClient = useQueryClient();
  const state = useQuery({ queryKey: ['web-push-state'], queryFn: () => webPushState(api), staleTime: 0 });
  const update = useMutation({
    mutationFn: (enabled: boolean) => enabled ? enableWebPush(api) : disableWebPush(api),
    onSuccess: (next) => queryClient.setQueryData(['web-push-state'], next),
  });
  const current = state.data;
  return (
    <section className="settings-pane">
      <div className="settings-pane-heading"><h2>In this browser</h2></div>
      <div className="settings-list-card">
        <SettingToggle setting={settings.pushNotifications}
          checked={current === 'on'}
          disabled={!current || current === 'unsupported' || current === 'home-screen' || current === 'unavailable' || current === 'denied' || update.isPending}
          onChange={(event) => update.mutate(event.currentTarget.checked)}
          role="switch" />
      </div>
      {current === 'unsupported' && <p className="settings-section-copy">This browser cannot show Rally notifications.</p>}
      {current === 'home-screen' && <p className="settings-section-copy">To get notifications on this device, tap Share, then Add to Home Screen. Open Rally from your Home Screen and turn this on there.</p>}
      {current === 'unavailable' && <p className="settings-section-copy">Browser notifications are not available yet.</p>}
      {current === 'denied' && <p className="settings-section-copy">Notifications are blocked for this site. Allow them in your browser's site settings, then turn this on.</p>}
      {state.error && <ErrorNotice occurrence={state.error}>{state.error.message}</ErrorNotice>}
      {/* A browser's own subscribe() error names its internals, not anything the member can act on. */}
      {update.error && <ErrorNotice occurrence={update.error}>{update.error instanceof ApiError ? update.error.message : 'Rally could not change notifications in this browser. Try again.'}</ErrorNotice>}
    </section>
  );
}

/** Settings → Account: the text the agent adds to its system prompt on turns this person starts. */
function PersonalSystemPromptSetting({ api, workspaceId }: { api: RallyApi; workspaceId: string }): React.JSX.Element {
  const queryClient = useQueryClient();
  // Per Organization, so the key carries it: another Organization's text must
  // never show while this one's read is in flight.
  const queryKey = ['personal-system-prompt', workspaceId];
  const saved = useQuery({
    queryKey,
    queryFn: ({ signal }) => api.getMyPersonalSystemPrompt(signal),
  });
  const [draft, setDraft] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (text: string) => api.updateMyPersonalSystemPrompt(text),
    onSuccess: (text) => {
      queryClient.setQueryData(queryKey, text);
      setDraft(null);
    },
  });
  const value = draft ?? saved.data ?? '';
  const changed = draft !== null && draft !== saved.data;
  return (
    <div className="personal-system-prompt">
      <label>
        <SettingCopy setting={settings.personalSystemPrompt} />
        <textarea
          aria-label="Personal system prompt"
          disabled={saved.data === undefined || save.isPending}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="For example: Answer briefly. I work in Go and Postgres."
          rows={5}
          value={value}
        />
      </label>
      <div className="personal-system-prompt-actions">
        <Button disabled={!changed || save.isPending} onClick={() => save.mutate(value)}>
          {save.isPending && <LoaderCircle aria-hidden="true" className="spin" size={14} />}
          Save
        </Button>
      </div>
      {saved.error && <ErrorNotice occurrence={saved.error}>{saved.error.message}</ErrorNotice>}
      {save.error && <ErrorNotice occurrence={save.error}>{save.error.message}</ErrorNotice>}
    </div>
  );
}

/**
 * A settings heading over one scope's remembered facts: the person's own under
 * Account, the Organization's under Organization. Per Organization, so the key
 * carries it; Remove shows where the server says the reader may remove a fact.
 */
function MemoryReviewSection({ emptyCopy, forget, heading, queryKey, read }: {
  emptyCopy: string;
  forget: (factId: string) => Promise<unknown>;
  heading: string;
  queryKey: readonly unknown[];
  read: (signal: AbortSignal) => Promise<MemoryReview>;
}): React.JSX.Element {
  const memory = useMemoryFacts({ forget, queryKey, read });
  return <>
    <div className="settings-pane-heading settings-pane-heading-spaced"><h2>{heading}</h2></div>
    <div className="settings-list-card">
      <MemoryFactList {...memory} emptyCopy={emptyCopy} label={heading} />
    </div>
  </>;
}

/** Settings → Account → Agent: whether this person's transcripts show the agent's work. */
function AgentWorkSetting({ api, workspaceId }: { api: RallyApi; workspaceId: string }): React.JSX.Element {
  const preferences = useMemberPreferences(api, workspaceId);
  const save = useSaveMemberPreferences(api, workspaceId);
  return (
    <>
      <SettingToggle setting={settings.showAgentWork}
        checked={preferences.data.showAgentWork}
        disabled={save.isPending}
        onChange={(event) => save.mutate({ showAgentWork: event.currentTarget.checked })}
        role="switch" />
      {save.error && <ErrorNotice occurrence={save.error}>{save.error.message}</ErrorNotice>}
    </>
  );
}

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
  /** Drawn in place of `icon` when the item is a company's. */
  mark?: PluginBrandMark | null;
  /** Set on a `connection` page's item, which is one of many sharing its section. */
  connectionId?: string;
  child?: boolean;
  /** Drawn but not openable, with `GUEST_SECTION_DISABLED_REASON`. */
  disabled?: boolean;
}

/** The icon a connection's page wears when its company has no mark to draw. */
function fallbackConnectionIcon(connection: WorkstreamConnection): LucideIcon {
  if (connection.connectorType === 'generic_webhook') return Webhook;
  return Plug;
}

/**
 * The sections a guest can open: their own profile, who is in the Organization,
 * and this app. Every other section configures the Organization or a member's
 * place in it, and its routes refuse a guest, so a guest sees it disabled.
 */
const GUEST_SETTINGS_SECTIONS: ReadonlySet<SettingsSection> = new Set(['account', 'members', 'application']);
const GUEST_SECTION_DISABLED_REASON = 'Only members of this organization can open this.';

const settingsNavigation: Array<{ label: string; items: SettingsNavItem[] }> = [
  {
    label: 'Settings',
    items: [
      { id: 'account', label: 'Account', icon: UserRound },
      { id: 'notifications', label: 'Notifications', icon: Bell },
      { id: 'workspace', label: 'Organization', icon: Users },
      // Its own page beneath Organization: the roster, guests and invitations
      // are a place people are sent to directly, from the account menu.
      { id: 'members', label: 'Members', icon: UsersRound, child: true },
      // Its own top-level page rather than part of Organization: the Terminal
      // egress policy is a review-then-confirm flow that stops running
      // sandboxes, which does not belong in the middle of a list of names,
      // timezones and invitations.
      { id: 'internet-access', label: 'Security', icon: ShieldCheck },
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
      ...(admin && provider.scopes.includes('workspace') ? ['Connect for organization'] : []),
      'Setup', 'Authorization',
    ],
  });
}
function connectionSetting(connection: WorkstreamConnection, admin: boolean) {
  return defineSetting({
    id: 'connection:' + connection.id, section: 'connection', kind: 'custom',
    label: connection.displayName, description: 'Status, access, tools and management for this installed connection.',
    options: [
      ...(admin && reconnectableConnectorTypes.has(connection.connectorType)
        && !(hasInstallationFacet(connection.connectorType) && connection.scope === 'workspace') ? ['Refresh', 'Reconnect'] : []),
      ...(connection.scope === 'you' || admin ? ['Delete', 'Disconnect'] : []),
      ...(admin && connection.connectorType === 'generic_webhook' ? ['Refresh', 'Webhook signing secret'] : []),
    ],
  });
}
/**
 * What a dash in the Tools column means, from the reason the list reported. A
 * region that predates the reason still says "disabled" from the status.
 */
function missingToolCountLabel(connection: WorkstreamConnection): string {
  switch (connection.toolCountMissing ?? (connection.status === 'disabled' ? 'disabled' : undefined)) {
    case 'disabled': return 'No tool count: this connection is disabled';
    case 'connector_unavailable': return 'No tool count: this connector is not available in this region';
    case 'counting': return 'No tool count yet: counting this connection’s tools';
    case 'not_counted': return 'No tool count: the last tool discovery did not succeed';
    default: return 'No tool count available';
  }
}
function connectionStatusLabel(connection: WorkstreamConnection): string {
  return connection.status === 'reconnect_required' ? 'Reconnect required' : connection.status;
}
function connectionStatusDescription(connection: WorkstreamConnection): string {
  switch (connection.status) {
    case 'healthy': return 'Rally can use this connection.';
    case 'reconnect_required': return 'The provider no longer accepts this connection’s authorization. Refresh it to keep using its tools.';
    case 'disabled': return 'This connection is disabled and exposes no tools.';
  }
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

/** The phone layout's `max-width` in `app.css`; the two move together. */
const PHONE_LAYOUT_QUERY = '(max-width: 640px)';

// jsdom and some Electron startup states have no `matchMedia`, so it is reached
// optionally and reads as wide.
function subscribePhoneLayout(onChange: () => void): () => void {
  const query = window.matchMedia?.(PHONE_LAYOUT_QUERY);
  query?.addEventListener('change', onChange);
  return () => query?.removeEventListener('change', onChange);
}

function isPhoneLayout(): boolean {
  return window.matchMedia?.(PHONE_LAYOUT_QUERY).matches ?? false;
}

function linkedSettingsSection(): SettingsSection | null {
  const nativeSection = parseDesktopSettingsSection(
    new URLSearchParams(window.location.search).get('settingsSection'),
  );
  if (nativeSection) return nativeSection;
  const hashQuery = window.location.hash.split('?', 2)[1];
  return parseDesktopSettingsSection(new URLSearchParams(hashQuery ?? '').get('section'));
}

export function WorkspaceSettingsScreen({
  standaloneWindow = false,
  workspace,
}: { standaloneWindow?: boolean; workspace: Workspace }): React.JSX.Element {
  const {
    api,
    session,
    runtime,
    leaveWorkspace,
    signOut,
    endSupportSession,
    pendingConnectorOAuth,
    setPendingConnectorOAuth,
  } = useAppSession();
  const { host, guest } = useShellCapabilities();
  const browserHost = host === 'browser';
  // The tab and the Settings window are named for what they show.
  useDocumentTitle('Settings');
  const workspaceSocket = useOptionalWorkspaceSocket();
  const featureFlags = useClientFeatureFlags(api);
  const queryClient = useQueryClient();
  const bridge = useMemo(() => desktopBridge(), []);
  const contentRef = useRef<HTMLElement | null>(null);
  const webhookRefreshCancelRef = useRef<HTMLButtonElement | null>(null);
  const reconnectCancelRef = useRef<HTMLButtonElement | null>(null);
  const disconnectCancelRef = useRef<HTMLButtonElement | null>(null);
  const [linkedSection] = useState(linkedSettingsSection);
  const [requestedSection, setActiveSection] = useState<SettingsSection>(linkedSection ?? 'account');
  // At phone width the sections list is a sheet over the page. It starts open
  // so Settings opens on the list, unless a link named the page to show.
  // Above 640px CSS ignores it and both columns show.
  const [navigationOpen, setNavigationOpen] = useState(linkedSection === null);
  const phoneLayout = useSyncExternalStore(subscribePhoneLayout, isPhoneLayout);
  const navigationSheetOpen = phoneLayout && navigationOpen;
  const navigationToggle = useRef<HTMLButtonElement>(null);
  // While the sheet covers the page, the page is inert so Tab and a screen
  // reader stay in the sheet. Escape shuts it and hands focus back to the
  // button, as the shell's phone sheet does. It listens in the bubble phase:
  // the search field's Escape clears the query first and stops there, and a
  // menu or dialog open over the sheet takes the keystroke for itself.
  useEffect(() => {
    if (!navigationSheetOpen) return undefined;
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (document.querySelector('[role="menu"], [role="dialog"], [role="listbox"]')) return;
      setNavigationOpen(false);
      navigationToggle.current?.focus();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [navigationSheetOpen]);
  // Clamped while rendering, not after: a link or the hash can name a member's
  // section, and its reads would start in the frame before an effect moved on.
  const activeSection: SettingsSection = guest && !GUEST_SETTINGS_SECTIONS.has(requestedSection) ? 'account' : requestedSection;
  const [navigationQuery, setNavigationQuery] = useState('');
  const [connectionFilter, setConnectionFilter] = useState<ConnectionFilter>('not_connected');
  // Which connection the `connection` page is showing. A section names a page
  // and this names the instance, the same way search results carry both.
  const [connectionPageId, setConnectionPageId] = useState<string | null>(null);
  const [githubRepositorySearch, setGitHubRepositorySearch] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'admin' | 'member'>('member');
  const [createdUrl, setCreatedUrl] = useState<string | null>(null);
  const [createdDelivery, setCreatedDelivery] = useState<'sent' | 'skipped' | null>(null);
  const [workspaceTimezone, setWorkspaceTimezone] = useState(workspace.timezone);
  const [terminalMode, setTerminalMode] = useState<'trusted_only' | 'full_internet'>('trusted_only');
  const [terminalDomains, setTerminalDomains] = useState('');
  const [terminalConfirmOpen, setTerminalConfirmOpen] = useState(false);
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
  const [leaveConfirmationOpen, setLeaveConfirmationOpen] = useState(false);
  // The account's zone and whether it follows the device. Read here rather
  // than from the session, which holds whatever sign-in last wrote.
  const myTimezone = useQuery({
    queryKey: MY_TIMEZONE_QUERY_KEY,
    queryFn: ({ signal }) => api!.getMyTimezone(signal),
    enabled: Boolean(api) && !guest,
    // The desktop Settings window is mounted hidden, with its own cache, and
    // the main window's device report can move the zone meanwhile: re-read
    // whenever it is brought forward.
    refetchOnWindowFocus: 'always',
  });
  const userTimezone = myTimezone.data?.timezone ?? workspace.currentUser.timezone;
  const timezoneOptions = useMemo(
    () => [...new Set([...supportedTimezones, userTimezone, workspaceTimezone, deviceTimezone() ?? userTimezone])].sort(),
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
  const members = useWorkspaceMembers(api, { staleTime: 30_000 });
  const [promotion, setPromotion] = useState<{ id: string; name: string; incarnation: string; revision: number } | null>(null);
  const promoteGuest = useMutation({
    mutationFn: (guest: { id: string; incarnation: string; revision: number }) =>
      api!.promoteWorkspaceGuest(guest.id, { incarnation: guest.incarnation, expectedRevision: guest.revision }),
    onSuccess: () => setPromotion(null),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['workspace-members'] }),
  });
  // Members first, then guests, each by the name the row shows.
  const sortedMembers = useMemo(() => {
    const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    const people = members.data ?? [];
    return [
      ...people.filter((member) => member.accessClass !== 'guest').sort(byName),
      ...people.filter((member) => member.accessClass === 'guest').sort(byName),
    ];
  }, [members.data]);
  const [suspension, setSuspension] = useState<{ id: string; name: string; guest: boolean } | null>(null);
  // "Suspend" is the server's member removal: the row goes, access ends at
  // once, and an invitation brings them back. Their contributions stay.
  const suspendMember = useMutation({
    mutationFn: (userId: string) => api!.removeWorkspaceMember(workspace.id, userId),
    onSuccess: () => setSuspension(null),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['workspace-members'] }),
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
    enabled: Boolean(api && !guest),
    refetchOnWindowFocus: true,
    staleTime: 5_000,
  });
  const installedConnections = useMemo(
    () => (connections.data ?? []).filter((connection) => installedConnectorTypes.has(connection.connectorType)),
    [connections.data],
  );
  const pageConnection = installedConnections.find((connection) => connection.id === connectionPageId);
  // A disabled connection keeps its page, but its kind-specific settings read
  // through credentials it no longer has.
  const pageSettingsKind = pageConnection?.status === 'disabled' ? null : pageConnection?.settingsKind ?? null;
  const githubSettingsConnectionId = pageSettingsKind === 'github_repository_access' ? pageConnection!.id : null;
  const customMcpSettingsConnectionId = pageSettingsKind === 'custom_mcp_tools' ? pageConnection!.id : null;
  const githubRepositorySettings = useQuery({
    queryKey: ['github-repository-access', githubSettingsConnectionId],
    queryFn: ({ signal }) => api!.getGitHubRepositoryAccessSettings(githubSettingsConnectionId!, signal),
    enabled: Boolean(api && activeSection === 'connection' && githubSettingsConnectionId),
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
  // The catalog is read live from a third-party server on every open, so it is
  // never served from cache: a tool the server withdrew an hour ago is exactly
  // what somebody opening this screen is trying to find out about.
  const customMcpSettings = useQuery({
    queryKey: ['custom-mcp-settings', customMcpSettingsConnectionId],
    queryFn: ({ signal }) => api!.getCustomMcpSettings(customMcpSettingsConnectionId!, signal),
    enabled: Boolean(api && activeSection === 'connection' && customMcpSettingsConnectionId),
    staleTime: 0,
  });
  const updateCustomMcpToolPolicy = useMutation({
    mutationFn: (toolPolicy: CustomMcpToolPolicy) => (
      api!.updateCustomMcpToolPolicy(customMcpSettingsConnectionId!, toolPolicy)
    ),
    onSuccess: (settings) => {
      queryClient.setQueryData(['custom-mcp-settings', settings.connectionId], settings);
      // The save stored the narrowed count on the connection before answering,
      // so the list read after it already carries the new number.
      void queryClient.invalidateQueries({ queryKey: ['connections'] });
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
    if (!terminalSettings.data || terminalPolicyDirty.current) return;
    setTerminalMode(terminalSettings.data.mode);
    setTerminalDomains(terminalSettings.data.customDomains.join('\n'));
  }, [terminalSettings.data]);
  const terminalCustomDomains = () => [...new Set(
    terminalDomains.split(/[\s,]+/u).map((domain) => domain.trim().toLowerCase().replace(/\.$/u, '')).filter(Boolean),
  )].sort();
  const terminalPolicyChanged = Boolean(terminalSettings.data && (
    terminalMode !== terminalSettings.data.mode
    || terminalCustomDomains().join('\n') !== [...terminalSettings.data.customDomains].sort().join('\n')
  ));
  const terminalDraftRemainingSlots = !terminalPolicyChanged ? terminalSettings.data?.remainingCustomSlots : null;
  // The server still takes a preview then an apply, fenced by the preview's
  // mutation ID. The admin confirms once in the modal, so both run back to back.
  const saveTerminalPolicy = useMutation({
    mutationFn: async () => {
      const preview = await api!.previewTerminalNetworkPolicy({
        expectedRevision: terminalSettings.data!.revision,
        mode: terminalMode,
        customDomains: terminalCustomDomains(),
      });
      return api!.applyTerminalNetworkPolicy({
        mutationId: preview.mutationId,
        expectedRevision: preview.expectedRevision,
        confirmed: true,
      });
    },
    onSuccess: (settings: TerminalWorkspaceSettings) => {
      queryClient.setQueryData(['terminal-workspace-settings'], settings);
      terminalPolicyDirty.current = false;
      setTerminalMode(settings.mode);
      setTerminalDomains(settings.customDomains.join('\n'));
      setTerminalConfirmOpen(false);
    },
    onError: async () => {
      setTerminalConfirmOpen(false);
      await queryClient.invalidateQueries({ queryKey: ['terminal-workspace-settings'] });
    },
  });
  const connectorCatalog = useQuery({
    queryKey: ['connector-catalog'],
    queryFn: ({ signal }) => api!.getAvailableConnectorTypes(signal),
    enabled: Boolean(api && !guest),
    staleTime: 30_000,
  });
  const connectProvider = useMutation({
    mutationFn: async (input: { provider: 'apollo' | 'ashby' | 'canva' | 'fireflies' | 'google' | 'github' | 'granola' | 'linear' | 'notion' | 'slack' | 'x'; scope: 'you' | 'workspace'; capabilities: string[] }) => {
      if (input.provider === 'x') {
        await api!.createXConnection(input.capabilities);
        return { kind: 'direct' as const };
      }
      const authorization = await startConnectorAuthorization(api!, input.provider, input.scope, input.capabilities);
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
  // Recovery closes the setup dialog on the installation it found, and that is
  // all it can offer now: Granola has no events console to open onto it, so
  // reopening setup over a connection that already exists is the failure to
  // avoid, not a window to show.
  const granolaRecovery = useWorkspaceInstallationRecovery(api, 'granola', () => {
    setGranolaWorkspaceApiKey('');
    setGranolaSetupKey(crypto.randomUUID());
    setGranolaWorkspaceModalOpen(false);
    void queryClient.invalidateQueries({ queryKey: ['connections'] });
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
      if (connection.connectorType === 'canva') {
        const authorization = await startConnectorAuthorization(api!, 'canva', connection.scope, connection.capabilities ?? []);
        return { authorization, provider: 'canva' as const };
      }
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
  // Promotion and demotion are the same write, so they are the same mutation:
  // a `promote`/`demote` pair would be two pending states and two error slots
  // for one field with two values.
  const setMemberRole = useMutation({
    mutationFn: (input: { userId: string; role: 'admin' | 'member' }) =>
      api!.setWorkspaceMemberRole(input.userId, input.role),
    onSuccess: () => Promise.all([
      queryClient.invalidateQueries({ queryKey: ['workspace-members'] }),
      // The viewer may have just demoted themselves, and `workspace` is where
      // the role that draws these controls comes from.
      queryClient.invalidateQueries({ queryKey: ['workspace'] }),
    ]),
  });
  const revokeInvitation = useMutation({
    mutationFn: (id: string) => api!.revokeWorkspaceInvitation(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['workspace-invitations'] }),
  });
  const updateUserTimezone = useMutation({
    mutationFn: (choice: { timezone: string; followDevice: boolean }) =>
      api!.updateMyTimezone(choice.timezone, choice.followDevice),
    // Read back rather than written from the response, so a failed save never
    // leaves the controls showing a choice the server does not hold; the
    // digest names the zone too.
    onSettled: () => Promise.all([
      queryClient.invalidateQueries({ queryKey: MY_TIMEZONE_QUERY_KEY }),
      queryClient.invalidateQueries({ queryKey: ['digest-schedule'] }),
    ]),
  });
  // While a save is in flight, the controls show where it is going.
  const pendingTimezone = updateUserTimezone.isPending ? updateUserTimezone.variables : undefined;
  const timezoneFollowsDevice = pendingTimezone?.followDevice ?? myTimezone.data?.followsDevice === true;
  const updateWorkspaceTimezone = useMutation({
    mutationFn: (timezone: string) => api!.updateWorkspace({ timezone }),
    onSuccess: (updated) => setWorkspaceTimezone(updated.timezone),
  });
  const renameWorkspace = useMutation({
    mutationFn: (name: string) => api!.updateWorkspace({ name }),
    // Written straight into the read, so the name is in `workspace` before the
    // field lets go of it, without a refetch; the sync echo refetches anyway.
    onSuccess: (updated) => queryClient.setQueriesData<Workspace>(
      { queryKey: ['workspace'] },
      (current) => current && { ...current, name: updated.name },
    ),
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
  // Every installed connection is a page of its own beneath Connections, in
  // the order the tables list them, whether or not it has settings beyond its
  // status: the page is where a connection is looked at and managed, and a
  // connection with nothing to configure is still one somebody looks for.
  const connectionNavigationItems = useMemo<SettingsNavItem[]>(() => [
    ...installedConnections.filter((connection) => connection.scope === 'you'),
    ...installedConnections.filter((connection) => connection.scope === 'workspace'),
  ].map((connection) => ({
    id: 'connection' as const,
    connectionId: connection.id,
    label: connection.displayName,
    icon: fallbackConnectionIcon(connection),
    mark: connectorBrandMark(connection.connectorType, connection.displayName),
    child: true,
  })), [installedConnections]);
  const settingsNavigationWithConnectors = useMemo(() => settingsNavigation.map((group) => {
    const withConnections = group.label !== 'Settings'
      ? group
      : { ...group, items: group.items.flatMap((item) => item.id === 'connections' ? [item, ...connectionNavigationItems] : [item]) };
    // A guest sees every section, and the ones they cannot open disabled.
    return { ...withConnections, items: guest
      ? withConnections.items.map((item) => GUEST_SETTINGS_SECTIONS.has(item.id) ? item : { ...item, disabled: true })
      : withConnections.items };
  // Every Application setting but appearance is about the Mac app itself, so a
  // browser drops the whole Desktop app group and shows appearance in Account.
  }).filter((group) => !browserHost || group.label !== 'Desktop app'), [browserHost, guest, connectionNavigationItems]);
  const availableSections = useMemo(
    () => new Set(settingsNavigationWithConnectors.flatMap((group) => group.items.flatMap((item) => item.disabled ? [] : [item.id]))),
    [settingsNavigationWithConnectors],
  );
  const settingsContext = useMemo<SettingsSearchContext>(() => ({
    sections: availableSections,
    admin: isAdmin,
    developer: developerSettingsAvailable,
    menuBar: applicationSettings?.menuBarAvailable !== false,
    login: applicationSettings?.launchAtLoginAvailable !== false,
    releaseChannel: applicationSettings?.releaseChannelAvailable !== false,
    browser: browserHost,
  }), [browserHost, availableSections, isAdmin, developerSettingsAvailable, applicationSettings?.menuBarAvailable, applicationSettings?.launchAtLoginAvailable, applicationSettings?.releaseChannelAvailable]);
  const [searchTarget, setSearchTarget] = useState<SettingSearchResult | null>(null);
  const searchEntries = useMemo(() => collectSettings([
    { ...coreSettingsProvider, entries: coreSettingsProvider.entries.filter((entry) => !entry.definition.connectionKind)
      .map((entry) => ({ ...entry, instanceLabel: connectorProviders.find((provider) =>
        'provider:' + provider.id === entry.definition.entryPoint)?.name })) },
    {
      id: 'connected-settings',
      entries: installedConnections.filter((connection) => connection.settingsKind && connection.status !== 'disabled')
        .flatMap((connection) => coreSettingsProvider.entries
          .filter((entry) => entry.definition.connectionKind === connection.settingsKind)
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
      entries: installedConnections.map((connection) => ({
        key: 'connection:' + connection.id, definition: connectionSetting(connection, isAdmin),
        instanceId: connection.id,
      })),
    },
  ], settingsContext), [connections.data, installedConnections, isAdmin, settingsContext]);
  const searchResults = useMemo(() => {
    const action = navigationQuery.trim().toLowerCase();
    const exactConnectAction = [PERSONAL_CONNECT_LABEL, 'Connect for organization'].some((label) => label.toLowerCase() === action);
    return searchSettings(searchEntries, navigationQuery).filter((entry) =>
      !exactConnectAction || !entry.key.startsWith('provider:')
      || entry.definition.options?.some((option) => option.toLowerCase() === action));
  }, [searchEntries, navigationQuery]);
  const openConnectionPage = (connectionId: string): void => {
    if (connectionId !== connectionPageId) setGitHubRepositorySearch('');
    setConnectionPageId(connectionId);
  };
  const selectSearchResult = (result: SettingSearchResult): void => {
    if (!searchEntries.some((entry) => entry.key === result.key)) return;
    if (result.definition.section === 'connection' && result.instanceId) openConnectionPage(result.instanceId);
    if (result.definition.section === 'connections') setConnectionFilter('all');
    setActiveSection(result.definition.section);
    setNavigationQuery('');
    setNavigationOpen(false);
    setSearchTarget({ ...result });
  };
  useRevealSetting(contentRef, searchTarget && activeSection === searchTarget.definition.section && searchEntries.some((entry) => entry.key === searchTarget.key)
    ? searchTarget : null);
  const workspaceConnections = installedConnections.filter((connection) => connection.scope === 'workspace');
  const personalConnections = installedConnections.filter((connection) => connection.scope === 'you');
  const visibleProviders = connectorProviders.filter((provider) => {
    const connected = providerHasConnection(provider, connections.data ?? []);
    if (connectionFilter === 'connected') return connected;
    if (connectionFilter === 'not_connected') {
      return providerHasAvailableUnconnectedScope(provider, connections.data ?? [], isAdmin);
    }
    return true;
  });
  // A connection's page outlives the connection only until the list says so:
  // deleting it from its own page, or a deep link to no connection, lands on
  // the list it belonged to. Waits for the list, so a cold open does not bounce.
  useEffect(() => {
    if (activeSection === 'connection' && connections.data && !pageConnection) setActiveSection('connections');
  }, [activeSection, connections.data, pageConnection]);
  useEffect(() => {
    if (activeSection === 'connection' || availableSections.has(activeSection)) return;
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
  // A browser tab cannot close itself: there Settings is a route, and closing
  // it returns to the workspace.
  const closeSettings = useCloseWindowSurface();
  useEscapeClosesWindow({ enabled: standaloneWindow, unsavedTextScope: contentRef, onClose: closeSettings });

  // The settings window is kept and reused, so a pane already on screen does
  // not remount when Settings is asked for again. Usage counts each request
  // for its pane as the section opening, which is when it refreshes.
  const [usageRequest, setUsageRequest] = useState(0);
  useEffect(() => bridge.onSettingsSectionRequested((section) => {
    const nextSection = parseDesktopSettingsSection(section);
    if (!nextSection) return;
    setNavigationQuery('');
    setSearchTarget(null);
    // A section request names no connection, so it must not reopen whichever
    // page was last shown; `connection` without one lands on Connections.
    setConnectionPageId(null);
    setActiveSection(nextSection);
    if (nextSection === 'workspace') setUsageRequest((count) => count + 1);
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
    if (!api || !pendingConnectorOAuth || pendingConnectorOAuth.source === 'resource'
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
  const canEditGitHubSettings = pageConnection?.scope === 'you' || isAdmin;
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

  /** The management actions a connection offers, on its own page. */
  const renderConnectionActions = (connection: WorkstreamConnection): React.JSX.Element => (
    <span className="settings-connection-actions">
      {isAdmin && connection.scope === 'workspace' && hasWorkspaceInstallationSurface(connection.connectorType) && (
        <Button aria-label={`Manage events for ${connection.displayName}`} onClick={() => setInstallationTarget(connection.id)}>Manage events</Button>
      )}
      {(isAdmin || connection.scope === 'you') && reconnectableConnectorTypes.has(connection.connectorType)
        && !(hasInstallationFacet(connection.connectorType) && connection.scope === 'workspace') && (
        <ConnectionIconAction
          disabled={!connectorStartsHere(session, connection.connectorType) || reconnectConnection.isPending || Boolean(pendingConnectorOAuth)}
          icon={<RefreshCcw aria-hidden="true" size={14} />}
          label={`Refresh ${connection.displayName}`}
          onClick={() => setReconnectTarget(connection)}
          tooltip={connectorStartsHere(session, connection.connectorType) ? 'Refresh authorization with the provider.' : MAC_APP_CONNECT_NOTE}
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
  );

  const sectionTitle = activeSection === 'connection'
    ? pageConnection?.displayName ?? 'Connections'
    : settingsNavigationWithConnectors
      .flatMap((group) => group.items)
      .find((item) => item.id === activeSection)?.label ?? 'Settings';

  return (
    <div className="workspace-settings-screen screen-with-titlebar">
      <div className="screen-drag-strip window-drag" />
      <div className="settings-window">
        <aside className={navigationOpen ? 'settings-sidebar is-mobile-open' : 'settings-sidebar'} id="settings-navigation-sheet" onKeyDown={(event) => {
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
                  const current = activeSection === item.id
                    && (!item.connectionId || item.connectionId === connectionPageId);
                  const button = (
                    <button
                      aria-current={current ? 'page' : undefined}
                      // Not `disabled`, which would take it out of the tab
                      // order and its reason with it.
                      aria-disabled={item.disabled || undefined}
                      className={item.child ? 'settings-navigation-child' : undefined}
                      key={item.connectionId ?? item.id}
                      onClick={() => {
                        if (item.disabled) return;
                        setSearchTarget(null);
                        if (item.connectionId) openConnectionPage(item.connectionId);
                        setActiveSection(item.id);
                        setNavigationOpen(false);
                      }}
                      type="button"
                    >
                      {item.mark ? <ConnectorMark mark={item.mark} /> : <Icon aria-hidden="true" size={16} />}
                      <span className="settings-navigation-label">{item.label}</span>
                    </button>
                  );
                  // A connection's name is cut to the sidebar's width, and two
                  // accounts of one company differ only in the part cut off.
                  if (item.disabled) return <Tip key={item.id} label={GUEST_SECTION_DISABLED_REASON} side="right">{button}</Tip>;
                  return item.connectionId
                    ? <Tip describesTrigger={false} key={item.connectionId} label={item.label} side="right">{button}</Tip>
                    : button;
                })}
              </div>
            ))}
          </nav>}
        </aside>

        <main className="settings-content" ref={contentRef}>
          <header className="settings-content-header window-drag">
            {/* The phone sheet's menu button; CSS hides it above 640px. */}
            <IconButton
              aria-controls="settings-navigation-sheet"
              aria-expanded={navigationOpen}
              className="sidebar-menu-toggle settings-menu-toggle window-no-drag"
              label={navigationOpen ? 'Close settings sections' : 'Open settings sections'}
              onClick={() => setNavigationOpen(!navigationOpen)}
              ref={navigationToggle}
              showTooltip={false}
            >
              <Menu aria-hidden="true" className="sidebar-menu-glyph is-menu" size={18} />
              <X aria-hidden="true" className="sidebar-menu-glyph is-close" size={18} />
            </IconButton>
            <h1 id="settings-title">{activeSection === 'connection' && pageConnection
              ? <SettingLabel setting={connectionSetting(pageConnection, isAdmin)} instanceId={pageConnection.id} />
              : sectionTitle}</h1>
            <button aria-label="Close settings" className="settings-close window-no-drag" onClick={closeSettings} type="button">
              <X aria-hidden="true" size={18} />
            </button>
          </header>
          <div className="settings-content-scroll" inert={navigationSheetOpen}>
            {activeSection === 'account' && (
              <section aria-labelledby="settings-title" className="settings-pane">
                <div className="settings-pane-heading"><h2><SettingLabel setting={settings.profile} /></h2><p>Your Rally identity and access in this Organization.</p></div>
                <PersonalSetup variant="settings" profileDetails={(displayName) => <>
                  <span><strong>{displayName}</strong><small>{workspace.currentUser.email}</small></span>
                  <Badge className="role-badge">{guest ? 'Guest' : workspace.currentUser.role}</Badge>
                </>} />
                {/* The timezone is saved through a member-only route, and only
                    a member's automations read it. */}
                {!guest && <>
                <div className="settings-pane-heading settings-pane-heading-spaced"><h2>Preferences</h2></div>
                <div className="settings-list-card">
                  {/* Waits for the read: on or off is unknown until then. Off
                      fixes the zone the account is in now. */}
                  <SettingToggle setting={settings.personalTimezoneAutomatic}
                    checked={timezoneFollowsDevice}
                    disabled={updateUserTimezone.isPending || !myTimezone.data}
                    onChange={(event) => updateUserTimezone.mutate(event.currentTarget.checked
                      ? { timezone: deviceTimezone() ?? userTimezone, followDevice: true }
                      : { timezone: userTimezone, followDevice: false })}
                    role="switch" />
                  <label className="settings-preference-row">
                    <SettingCopy setting={settings.personalTimezone} />
                    <DropdownSelect
                      ariaLabel="Personal default timezone"
                      // Usable even if the read fails, falling back to the
                      // session's zone, as before the switch existed.
                      disabled={updateUserTimezone.isPending || timezoneFollowsDevice}
                      onValueChange={(timezone) => updateUserTimezone.mutate({ timezone, followDevice: false })}
                      options={timezoneOptions.map((timezone) => ({ label: timezone, value: timezone }))}
                      // The server's zone, which another device may have moved.
                      value={pendingTimezone?.timezone ?? userTimezone}
                      variant="secondary"
                    />
                  </label>
                </div>
                {updateUserTimezone.error && <ErrorNotice occurrence={updateUserTimezone.error}>{updateUserTimezone.error.message}</ErrorNotice>}
                {api && <>
                  <div className="settings-pane-heading settings-pane-heading-spaced"><h2>Agent</h2></div>
                  <div className="settings-list-card">
                    <PersonalSystemPromptSetting api={api} key={workspace.id} workspaceId={workspace.id} />
                    <AgentWorkSetting api={api} workspaceId={workspace.id} />
                  </div>
                  <MemoryReviewSection
                    emptyCopy="Rally has not remembered anything about you yet."
                    forget={(factId) => api.forgetMyMemory(factId)}
                    heading="What Rally remembers about you"
                    queryKey={['memory', 'me', workspace.id]}
                    read={(signal) => api.getMyMemory(signal)}
                  />
                </>}
                </>}
                {browserHost && <>
                  <div className="settings-pane-heading settings-pane-heading-spaced"><h2>Appearance</h2></div>
                  <ThemePicker setting={settings.accountAppearance} />
                </>}
                <div className="settings-pane-heading settings-pane-heading-spaced"><h2>Session</h2></div>
                <div className="settings-list-card">
                  <div className="settings-preference-row">
                    {session?.impersonator
                      ? <>
                          <SettingCopy setting={settings.signOut} description={`You are signed in as ${session.user.name}. Ending returns you to your own account.`} />
                          <Button onClick={() => void endSupportSession()}>End impersonation</Button>
                        </>
                      : <>
                          <SettingCopy setting={settings.signOut} />
                          <Button onClick={() => void signOut()}>Sign out</Button>
                        </>}
                  </div>
                </div>
              </section>
            )}

            {activeSection === 'notifications' && featureFlags.data?.pushNotificationsEnabled && browserHost && api && (
              <BrowserNotificationsSetting api={api} />
            )}
            {activeSection === 'notifications' && featureFlags.data?.pushNotificationsEnabled && !browserHost && (
              <section className="settings-pane">
                <div className="settings-pane-heading"><h2>On this Mac</h2></div>
                <div className="settings-list-card">
                  <SettingToggle setting={settings.pushNotifications}
                    checked={applicationSettings?.pushNotificationsEnabled ?? true}
                    disabled={!applicationSettings || applicationSettings.pushNotificationStatus === 'unavailable' || updatePushNotifications.isPending}
                    onChange={(event) => updatePushNotifications.mutate(event.currentTarget.checked)} />
                  {applicationSettings?.pushNotificationStatus === 'unavailable' && (
                    <MacNotificationNotice title="Not available in this build"
                      detail="Notifications need an installed release build of Rally." />
                  )}
                  {applicationSettings?.pushNotificationStatus === 'denied' && (
                    <MacNotificationNotice title="Turned off in macOS"
                      detail="Rally can't show alerts or a Dock badge until you allow notifications."
                      onOpen={() => void bridge.openNotificationSettings()} />
                  )}
                  {applicationSettings?.pushNotificationStatus === 'enabled' && applicationSettings.notificationBadgeStatus === 'disabled' && (
                    <MacNotificationNotice title="Badges turned off in macOS"
                      detail="The Dock icon won't show what needs your attention until you allow badges."
                      onOpen={() => void bridge.openNotificationSettings()} />
                  )}
                </div>
                {updatePushNotifications.error && <ErrorNotice occurrence={updatePushNotifications.error}>{updatePushNotifications.error.message}</ErrorNotice>}
              </section>
            )}
            {activeSection === 'notifications' && api && (
              <NotificationChannelSettings
                api={api}
                email={session?.user.email ?? null}
                pushAvailable={featureFlags.data?.pushNotificationsEnabled === true}
                workspaceId={workspace.id}
              />
            )}

            {activeSection === 'workspace' && (
              <section aria-labelledby="settings-title" className="settings-pane">
                <div className="settings-pane-heading"><h2>Organization preferences</h2><p>Review organization details and defaults shared by the Organization’s Sidekicks.</p></div>
                <div className="settings-list-card">
                  <div className="settings-preference-row">
                    <SettingCopy setting={settings.workspaceIdentity} />
                    <span className="settings-row-value">
                      <InlineEditableText
                        ariaLabel="Organization name"
                        disabled={!isAdmin || !api}
                        onSave={(name) => renameWorkspace.mutateAsync(name)}
                        validate={(name) => (WorkspaceNameSchema.safeParse(name).success ? null : 'Use 2 to 120 characters.')}
                        value={workspace.name}
                      />
                    </span>
                  </div>
                  <label className="settings-preference-row">
                    <SettingCopy setting={settings.workspaceTimezone} />
                    <DropdownSelect
                      ariaLabel="Organization default timezone"
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
                  <SupportAccessSetting
                    api={api ?? null}
                    impersonating={Boolean(session?.impersonator)}
                    isAdmin={isAdmin}
                    workspaceId={workspace.id}
                  />
                </div>
                {renameWorkspace.error && <ErrorNotice occurrence={renameWorkspace.error}>{renameWorkspace.error.message}</ErrorNotice>}
                {updateWorkspaceTimezone.error && <ErrorNotice occurrence={updateWorkspaceTimezone.error}>{updateWorkspaceTimezone.error.message}</ErrorNotice>}
                {api && <MemoryReviewSection
                  emptyCopy="Rally has not remembered anything about the Organization yet."
                  forget={(factId) => api.forgetOrganizationMemory(factId)}
                  heading="What Rally remembers about the Organization"
                  queryKey={['memory', 'organization', workspace.id]}
                  read={(signal) => api.getOrganizationMemory(signal)}
                />}
                <UsageSettingsSection api={api ?? null} canChangePlan={isAdmin} organizationName={workspace.name} openRequest={usageRequest} />
                <div className="settings-pane-heading settings-pane-heading-spaced">
                  <h2><SettingLabel setting={settings.workspaceAccess} /></h2>
                  <p>Leaving removes this organization from your Rally account on every device.</p>
                </div>
                <div className="settings-list-card">
                  <div className="settings-preference-row">
                    <span className="settings-row-copy">
                      <strong>{leavingClosesWorkspace ? 'Leave and close this organization' : 'Leave this organization'}</strong>
                      <small>{leavingClosesWorkspace
                        ? 'You are the last member. The organization will become unavailable without deleting its retained data.'
                        : 'The organization stays available to its other members.'}</small>
                    </span>
                    <Button
                      className="button-danger"
                      disabled={members.isLoading || members.isError}
                      onClick={() => setLeaveConfirmationOpen(true)}
                    >
                      {leavingClosesWorkspace ? 'Leave and close organization' : 'Leave this organization'}
                    </Button>
                  </div>
                </div>
                {members.isError && <ErrorNotice occurrence={members.error}>Rally could not verify whether anyone else belongs to this workspace.</ErrorNotice>}
              </section>
            )}

            {activeSection === 'members' && (
              <section aria-labelledby="settings-title" className="settings-pane">
                <div className="settings-pane-heading settings-pane-heading-count">
                  <div><h2><SettingLabel setting={settings.members} /></h2><p>People with access to {workspace.name}.</p></div>
                  <span>{members.data?.length ?? 0}</span>
                </div>
                {members.error && <ErrorNotice occurrence={members.error}>{members.error.message}</ErrorNotice>}
                <div className="settings-member-list settings-list-card">
                  {sortedMembers.map((member) => {
                    const isGuest = member.accessClass === 'guest';
                    // Every row draws the menu so they line up, but two are
                    // disabled. The owner's role is not reassignable, and an
                    // organization has one owner, so nobody here may remove
                    // them. Someone still invited is not a member to act on yet.
                    const menuDisabled = member.role === 'owner' || member.status === 'invited';
                    const canPromoteGuest = isGuest && Boolean(member.incarnation && member.revision);
                    const self = member.id === workspace.currentUser.id;
                    return (
                      <div className="settings-member-row" key={member.id}>
                        <Avatar member={member} size="medium" />
                        <span><strong>{member.name}</strong><small>{member.email}</small></span>
                        <div className="settings-member-actions">
                          <Badge className="role-badge">{isGuest ? 'Guest' : member.role ?? 'member'}</Badge>
                          {isAdmin && (
                            <DropdownMenu.Root>
                              <DropdownMenu.Trigger asChild disabled={menuDisabled}>
                                {/* The email is in the name because two people can share a display name. */}
                                <IconButton label={`${member.name} (${member.email}) member actions`} showTooltip={false}>
                                  <Ellipsis size={16} />
                                </IconButton>
                              </DropdownMenu.Trigger>
                              <DropdownMenu.Portal>
                                <DropdownMenu.Content align="end" className="menu-content" sideOffset={6}>
                                  {/*
                                    * Two promotions meet here and neither is the
                                    * other: a guest holds no role at all and is
                                    * made a member first, while a member is handed
                                    * the same powers the viewer is using now.
                                    */}
                                  {isGuest ? (
                                    <DropdownMenu.Item className="menu-item" disabled={!canPromoteGuest || promoteGuest.isPending}
                                      onSelect={() => { promoteGuest.reset(); setPromotion({ id: member.id, name: member.name, incarnation: member.incarnation!, revision: member.revision! }); }}>
                                      Make member
                                    </DropdownMenu.Item>
                                  ) : (
                                    <DropdownMenu.Item className="menu-item" disabled={setMemberRole.isPending}
                                      onSelect={() => setMemberRole.mutate({
                                        userId: member.id,
                                        role: member.role === 'admin' ? 'member' : 'admin',
                                      })}>
                                      {member.role === 'admin' ? 'Remove administrator' : 'Make administrator'}
                                    </DropdownMenu.Item>
                                  )}
                                  {/* The server refuses removing yourself; leaving is its own control. */}
                                  {!self && (
                                    <DropdownMenu.Item className="menu-item menu-item-danger" disabled={suspendMember.isPending}
                                      onSelect={() => { suspendMember.reset(); setSuspension({ id: member.id, name: member.name, guest: isGuest }); }}>
                                      Suspend
                                    </DropdownMenu.Item>
                                  )}
                                </DropdownMenu.Content>
                              </DropdownMenu.Portal>
                            </DropdownMenu.Root>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
                {setMemberRole.error && <ErrorNotice occurrence={setMemberRole.error}>{setMemberRole.error.message}</ErrorNotice>}

                <Modal open={suspension !== null} onOpenChange={(open) => { if (!open && !suspendMember.isPending) setSuspension(null); }}
                  title={`Suspend ${suspension?.name ?? 'this person'}?`}
                  // An organization invitation brings a member back. A guest
                  // arrives through sharing instead, so the copy promises
                  // nothing about their return.
                  description={`They lose access to this organization right away. Their conversations and contributions stay.${suspension?.guest ? '' : ' You can invite them back later.'}`}
                  footer={<>
                    <Button disabled={suspendMember.isPending} onClick={() => setSuspension(null)}>Cancel</Button>
                    <Button className="button-danger" disabled={suspendMember.isPending} onClick={() => { if (suspension) suspendMember.mutate(suspension.id); }}>Suspend</Button>
                  </>}>
                  {suspendMember.error && <ErrorNotice occurrence={suspendMember.error}>{suspendMember.error.message}</ErrorNotice>}
                </Modal>

                <Modal open={promotion !== null} onOpenChange={(open) => { if (!open) setPromotion(null); }} title="Make guest a member"
                  description={`${promotion?.name ?? 'This guest'} will gain normal organization membership. Existing conversations and contributions stay with their account.`}>
                  {promoteGuest.error && <ErrorNotice occurrence={promoteGuest.error}>{promoteGuest.error.message}</ErrorNotice>}
                  <Button disabled={promoteGuest.isPending} onClick={() => setPromotion(null)}>Cancel</Button>
                  <Button disabled={promoteGuest.isPending} onClick={() => { if (promotion) promoteGuest.mutate(promotion); }}>Make member</Button>
                </Modal>

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
                          <option value="admin">Administrator</option>
                        </select>
                      </label>
                      <Button className="button-primary" disabled={!email.trim() || createInvitation.isPending} type="submit">
                        {createInvitation.isPending ? <LoaderCircle aria-hidden="true" className="spin" size={15} /> : <MailPlus aria-hidden="true" size={15} />}
                        <SettingLabel setting={settings.inviteSend} />
                      </Button>
                    </form>
                    {createInvitation.error && <ErrorNotice occurrence={createInvitation.error}>{createInvitation.error.message}</ErrorNotice>}
                    {createdUrl && (
                      <div className="invite-link-result" role="status">
                        <div>
                          <strong>{createdDelivery === 'sent' ? 'Invitation emailed' : 'Invite link ready'}</strong>
                          <small>{createdDelivery === 'sent' ? 'It expires in seven days. You can also copy the one-time link.' : 'Email delivery is disabled outside production. Copy the one-time link to test the flow.'}</small>
                        </div>
                        <CopyButton label="Copy invite link" size={15} value={createdUrl} />
                      </div>
                    )}
                    {revokeInvitation.error && <ErrorNotice occurrence={revokeInvitation.error}>{revokeInvitation.error.message}</ErrorNotice>}
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

            {activeSection === 'internet-access' && (
              <section aria-labelledby="settings-title" className="settings-pane">
                <div className="settings-pane-heading">
                  <h2><SettingLabel setting={settings.terminal} /></h2>
                  <p>{settings.terminal.description}</p>
                </div>
                {terminalSettings.isLoading ? (
                  <div className="settings-loading"><LoaderCircle aria-hidden="true" className="spin" size={15} /> Loading Terminal policy…</div>
                ) : terminalSettings.error ? (
                  <ErrorNotice occurrence={terminalSettings.error}>{terminalSettings.error.message}</ErrorNotice>
                ) : terminalSettings.data && (
                  <div className="terminal-network-card settings-list-card">
                    {terminalSettings.data.availability !== 'supported' && (
                      <div className="terminal-network-notice" role="status">
                        <ShieldCheck aria-hidden="true" size={17} />
                        <span><strong>Terminal unavailable</strong><small>{terminalSettings.data.availability === 'emergency_disabled' ? 'Temporarily disabled by the regional safety switch.' : 'Cloud computer not enabled.'}</small></span>
                      </div>
                    )}
                    <fieldset className="terminal-network-modes" disabled={!isAdmin || terminalSettings.data.availability !== 'supported' || saveTerminalPolicy.isPending}>
                      <legend>Outbound access</legend>
                      <label>
                        <input checked={terminalMode === 'trusted_only'} name="terminal-network-mode" onChange={() => { terminalPolicyDirty.current = true; setTerminalMode('trusted_only'); }} type="radio" />
                        <span><strong><SettingLabel setting={settings.trustedNetwork} /></strong><small>{settings.trustedNetwork.description}</small></span>
                      </label>
                      <label>
                        <input checked={terminalMode === 'full_internet'} name="terminal-network-mode" onChange={() => { terminalPolicyDirty.current = true; setTerminalMode('full_internet'); }} type="radio" />
                        <span><strong><SettingLabel setting={settings.fullNetwork} /></strong><small>{settings.fullNetwork.description}</small></span>
                      </label>
                    </fieldset>
                    {terminalMode === 'full_internet' && searchTarget?.definition.id === 'terminalDomains' && (
                      <div className="terminal-network-domains">
                        <SettingCopy setting={settings.terminalDomains}
                          description="Organization-approved domains apply only to Trusted only mode." />
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
                            onChange={(event) => { terminalPolicyDirty.current = true; setTerminalDomains(event.target.value); }}
                            placeholder="packages.example.com&#10;*.downloads.example.com"
                            rows={3}
                            value={terminalDomains}
                          />
                          <small>{terminalDraftRemainingSlots === null
                            ? 'Save the change to verify remaining organization-domain capacity.'
                            : `${terminalDraftRemainingSlots ?? 0} organization domain slots remain.`} Enter domains only—no schemes, ports, paths, IPs, or CIDR blocks.</small>
                        </label>
                      </div>
                    )}
                    <div className="terminal-network-actions">
                      <span><Badge>{terminalSettings.data.verificationState}</Badge> Revision {terminalSettings.data.revision}</span>
                      <Button
                        disabled={!isAdmin || !terminalPolicyChanged || terminalSettings.data.availability !== 'supported' || saveTerminalPolicy.isPending}
                        onClick={() => { saveTerminalPolicy.reset(); setTerminalConfirmOpen(true); }}
                      >
                        Save network change
                      </Button>
                    </div>
                    {saveTerminalPolicy.error && <ErrorNotice occurrence={saveTerminalPolicy.error}>{saveTerminalPolicy.error.message}</ErrorNotice>}
                    <Modal
                      footer={(
                        <>
                          <Button disabled={saveTerminalPolicy.isPending} onClick={() => setTerminalConfirmOpen(false)}>Cancel</Button>
                          <Button className="button-primary" disabled={saveTerminalPolicy.isPending} onClick={() => saveTerminalPolicy.mutate()}>
                            {saveTerminalPolicy.isPending && <LoaderCircle aria-hidden="true" className="spin" size={14} />}
                            Continue
                          </Button>
                        </>
                      )}
                      onOpenChange={(open) => { if (!open && !saveTerminalPolicy.isPending) setTerminalConfirmOpen(false); }}
                      open={terminalConfirmOpen}
                      title="Change network access?"
                    >
                      <p className="modal-copy">
                        Cloud computers running now may be interrupted.
                      </p>
                    </Modal>
                  </div>
                )}
              </section>
            )}

            {activeSection === 'connections' && (
              <section aria-labelledby="settings-title" className="settings-pane settings-connections-pane">
                <div className="settings-pane-heading">
                  <h2><SettingLabel setting={settings.connections} /></h2>
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
                      title: 'Organization connections',
                      items: workspaceConnections,
                      emptyTitle: 'No organization connections yet',
                      emptyDescription: 'Connect a connector below to make its tools available across this organization.',
                    },
                  ] as const).map((group) => (
                    <section className="settings-connection-group" key={group.id}>
                      <div className="settings-connection-group-heading">
                        <h3 id={group.id}>{group.title}</h3>
                      </div>
                      <div className="settings-list-card settings-connection-table-frame">
                        <table aria-labelledby={group.id} className="settings-connection-table">
                          <thead>
                            <tr>
                              <th scope="col">Connection</th>
                              <th scope="col">Status</th>
                              <th className="settings-connection-tools" scope="col">Tools</th>
                              <th scope="col"><span className="sr-only">Open</span></th>
                            </tr>
                          </thead>
                          <tbody>
                            {group.items.map((connection) => (
                              // The row is the way to a connection's page, where its
                              // actions live. The name is the one focusable control;
                              // the rest of the row forwards a click to it.
                              <tr className="settings-connection-row" key={connection.id} onClick={() => {
                                setSearchTarget(null);
                                openConnectionPage(connection.id);
                                setActiveSection('connection');
                              }}>
                                <td>
                                  <button className="settings-connection-name" type="button">
                                    <span className={`connection-provider-dot ${connection.status}`} aria-hidden="true" />
                                    <InstalledConnectionMark connection={connection} />
                                    <span className="settings-connection-copy"><strong>{connection.displayName}</strong></span>
                                  </button>
                                </td>
                                <td><Badge>{connectionStatusLabel(connection)}</Badge></td>
                                {/* From the list itself: a row with no count reads as a dash,
                                    never 0, and its label says why. */}
                                {connection.toolCount === undefined ? (
                                  <td
                                    aria-label={missingToolCountLabel(connection)}
                                    className="settings-connection-tools"
                                    title={missingToolCountLabel(connection)}
                                  >—</td>
                                ) : (
                                  <td className="settings-connection-tools">{connection.toolCount}</td>
                                )}
                                <td><ChevronRight aria-hidden="true" className="settings-connection-chevron" size={15} /></td>
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
                  </div>
                  <p className="settings-section-copy">Personal connections are available only to you and act with your provider identity. Organization connections expose granted capabilities to every member; an Organization’s Sidekicks use only the connections explicitly bound to them.</p>
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
                      // Ashby's personal sign-in has a prerequisite the OAuth redirect cannot
                      // report: an org that has not opted into Ashby MCP fails provider-side with
                      // nothing naming the cause. The card is one sentence, so the prerequisite
                      // rides the button's own tooltip rather than a second paragraph.
                      const personalConnectPrerequisite = provider.provider === 'ashby'
                        ? "Personal sign-in requires your organization's Ashby MCP opt-in and an eligible account."
                        : undefined;
                      // A browser tab starts every connection but those marked desktop only.
                      const startsHere = connectorStartsHere(session, provider.provider);
                      const personalConnectDisabled = !startsHere || !providerAvailable || personalConnectionStateUnavailable || connectProvider.isPending || Boolean(pendingConnectorOAuth) || hasActivePersonalConnection;
                      const personalConnectTitle = !startsHere
                        ? MAC_APP_CONNECT_NOTE
                        : hasActivePersonalConnection
                        ? `A ${provider.name} personal connection is already installed. Manage it above.`
                        : !providerAvailable && !connectorCatalog.isLoading
                          ? `${provider.name} is not configured in this Rally region.`
                        : personalConnectionStateUnavailable && connections.isLoading
                          ? 'Checking installed personal connections…'
                          : personalConnectionStateUnavailable && connections.isError
                            ? 'Installed personal connections could not be loaded.'
                            : undefined;
                      const workspaceConnectDisabled = !startsHere || !providerAvailable || connections.isLoading || connections.isError || connectProvider.isPending || createGranolaWorkspaceConnection.isPending || Boolean(pendingConnectorOAuth) || hasActiveWorkspaceConnection;
                      const workspaceConnectTitle = !startsHere
                        ? MAC_APP_CONNECT_NOTE
                        : hasActiveWorkspaceConnection
                        ? `A ${provider.name} organization connection is already installed. Manage it above.`
                        : !providerAvailable && !connectorCatalog.isLoading
                          ? `${provider.name} is not configured in this Rally region.`
                        : connections.isLoading
                          ? 'Checking installed organization connections…'
                          : connections.isError
                            ? 'Installed organization connections could not be loaded.'
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
                          {!startsHere && (
                            <p className="settings-oauth-status">{MAC_APP_DOWNLOADABLE ? <a href={MAC_APP_DOWNLOAD_URL}>{MAC_APP_CONNECT_NOTE}</a> : MAC_APP_CONNECT_NOTE}</p>
                          )}
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
                                  tooltip={`Only you can use this connection; it acts with your provider identity.${provider.provider === 'canva' ? ` ${CANVA_CONNECTION_DISCLOSURE}` : ''}${personalConnectPrerequisite ? ` ${personalConnectPrerequisite}` : ''}${personalConnectTitle ? ` ${personalConnectTitle}` : ''}`}
                                >{awaitingProvider ? <><LoaderCircle aria-hidden="true" className="spin" size={13} /> Waiting…</> : PERSONAL_CONNECT_LABEL}</ConnectorButton>
                              )}
                            {provider.scopes.includes('workspace' as never) && isAdmin && (
                              <ConnectorButton
                                disabled={workspaceConnectDisabled}
                                label={'Connect for organization'}
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
                                    setWebhookDisplayName('Organization inbound webhook');
                                    setWebhookEventTypes('');
                                    setWebhookIdempotencyKey(crypto.randomUUID());
                                    setWebhookSecretResult(null);
                                    setWebhookRotationTarget(null);
                                    return;
                                  }
                                  connectProvider.mutate({ provider: provider.provider, scope: 'workspace', capabilities: providerCapabilitiesForScope(provider, 'workspace') });
                                }}
                                tooltip={`Everyone in this organization can use this connection; it acts for the organization.${workspaceConnectTitle ? ` ${workspaceConnectTitle}` : ''}`}
                              >
                                {'Connect for organization'}
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

            {activeSection === 'connection' && pageConnection && (
              <section aria-labelledby="settings-title" className="settings-pane settings-connection-page">
                <div className="settings-list-card settings-connection-overview">
                  <div className="settings-preference-row">
                    <span className="settings-row-copy">
                      <strong>Status</strong>
                      <small>{connectionStatusDescription(pageConnection)}</small>
                    </span>
                    <Badge>{connectionStatusLabel(pageConnection)}</Badge>
                  </div>
                  <div className="settings-preference-row">
                    <span className="settings-row-copy">
                      <strong>Access</strong>
                      <small>
                        {pageConnection.scope === 'you'
                          ? 'Available only to you, acting with your provider identity.'
                          : 'Its granted capabilities are available to every member of this organization.'}
                        {pageConnection.ownerName ? ` Connected by ${pageConnection.ownerName}.` : ''}
                      </small>
                    </span>
                    <Badge>{pageConnection.scope === 'you' ? 'Personal' : 'Organization'}</Badge>
                  </div>
                  <div className="settings-preference-row">
                    <span className="settings-row-copy">
                      <strong>Tools</strong>
                      <small>{pageConnection.toolCount === undefined
                        ? missingToolCountLabel(pageConnection)
                        : `${pageConnection.toolCount} ${pageConnection.toolCount === 1 ? 'tool' : 'tools'} available to Rally through this connection.`}</small>
                    </span>
                    {renderConnectionActions(pageConnection)}
                  </div>
                </div>
                {githubSettingsConnectionId && (
                  <>
                    <div className="settings-pane-heading settings-connection-facet-heading">
                      <h2><SettingLabel setting={settings.githubAccess} instanceId={githubSettingsConnectionId} /></h2>
                      <p>Choose which GitHub repositories Rally may use and whether it may change the remote repository.</p>
                    </div>
                    {githubRepositorySettings.isLoading ? (
                      <div className="settings-loading"><LoaderCircle aria-hidden="true" className="spin" size={15} /> Loading GitHub repositories…</div>
                    ) : githubSettings ? (
                      <>
                        {!canEditGitHubSettings && (
                          <p className="settings-section-copy">Organization repository access is read-only here. Ask an organization administrator to change it.</p>
                        )}
                        <div className="settings-list-card settings-github-policy">
                          <label className="settings-preference-row">
                            <SettingCopy setting={settings.githubAvailability} instanceId={githubSettingsConnectionId} />
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
                              <SettingCopy setting={settings.githubRemote} instanceId={githubSettingsConnectionId}
                                description="A default applies only to All repositories. Configure individual access under Repositories below." />
                            </div>
                          )}
                          {githubSettings.mode === 'all_repositories' && (
                            <label className="settings-preference-row">
                              <SettingCopy setting={settings.githubRemote} instanceId={githubSettingsConnectionId} />
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
                            <strong><SettingLabel setting={settings.githubRepositories} instanceId={githubSettingsConnectionId} /></strong>
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
                  <ErrorNotice occurrence={githubRepositorySettings.error}>{githubRepositorySettings.error?.message ?? updateGitHubRepositorySettings.error?.message}</ErrorNotice>
                )}
                  </>
                )}
                {customMcpSettingsConnectionId && (
                  <>
                    <div className="settings-pane-heading settings-connection-facet-heading">
                      <h2><SettingLabel setting={settings.mcpTools} instanceId={customMcpSettingsConnectionId} /></h2>
                      <p>What this MCP server currently offers, and how much of it Rally may use.</p>
                    </div>
                    {customMcpSettings.isLoading ? (
                      <div className="settings-loading"><LoaderCircle aria-hidden="true" className="spin" size={15} /> Reading this server’s tools…</div>
                    ) : customMcpSettings.data ? (
                      <>
                        <div className="settings-list-card">
                          <div className="settings-preference-row">
                            <span className="settings-row-copy">
                              <strong><SettingLabel setting={settings.mcpServer} instanceId={customMcpSettingsConnectionId} /></strong>
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
                                onClick={() => setReconnectTarget(pageConnection)}
                              >
                                <RefreshCcw aria-hidden="true" size={14} />
                                Authorize again
                              </Button>
                            )}
                          </div>
                          <label className="settings-preference-row">
                            <SettingCopy setting={settings.mcpPolicy} instanceId={customMcpSettingsConnectionId} description={<> {customMcpSettings.data.toolPolicyEditable
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
                            <strong><SettingLabel setting={settings.mcpCatalog} instanceId={customMcpSettingsConnectionId} /></strong>
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
                  <ErrorNotice occurrence={customMcpSettings.error}>{customMcpSettings.error?.message ?? updateCustomMcpToolPolicy.error?.message}</ErrorNotice>
                )}
                  </>
                )}
              </section>
            )}

            {activeSection === 'application' && !browserHost && (
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
                  <ErrorNotice>{applicationSettingsLoadError ?? updateLockdownMode.error?.message}</ErrorNotice>
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
                {updateProductAnalytics.error && <ErrorNotice occurrence={updateProductAnalytics.error}>{updateProductAnalytics.error.message}</ErrorNotice>}
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
                    {updateMenuBarEnabled.error && <ErrorNotice occurrence={updateMenuBarEnabled.error}>{updateMenuBarEnabled.error.message}</ErrorNotice>}
                    {/* The write succeeded and the item still is not there —
                      * creating one can fail, and without this the switch reads
                      * on beside an empty menu bar with nothing said about it. */}
                    {applicationSettings?.menuBarEnabled
                      && applicationSettings.menuBarAvailable
                      && !applicationSettings.menuBarPresent
                      && !updateMenuBarEnabled.isPending
                      && (
                        <ErrorNotice>
                          Rally could not add itself to the menu bar. Turn this off and on to try again, or restart Rally.
                        </ErrorNotice>
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
                    {updateReleaseChannel.error && <ErrorNotice occurrence={updateReleaseChannel.error}>{updateReleaseChannel.error.message}</ErrorNotice>}
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
                    {updateLaunchAtLogin.error && <ErrorNotice occurrence={updateLaunchAtLogin.error}>{updateLaunchAtLogin.error.message}</ErrorNotice>}
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
                    {updateDebugEnabled.error && <ErrorNotice occurrence={updateDebugEnabled.error}>{updateDebugEnabled.error.message}</ErrorNotice>}
                  </>
                )}
                <div className="settings-pane-heading settings-pane-heading-spaced"><h2><SettingLabel setting={settings.about} /></h2><p>Which release of Rally this Mac is running.</p></div>
                <AboutRally version={runtime?.appVersion ?? 'Unknown'} versionLabel={<SettingLabel setting={settings.version} />} />
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
            <ErrorNotice occurrence={createWebhookConnection.error}>{createWebhookConnection.error?.message ?? rotateWebhookSecret.error?.message}</ErrorNotice>
          )}
        </Modal>
        <Modal
          description={customMcpModalScope === 'workspace'
            ? 'Everyone in this organization will be able to use this server’s tools, acting through the one authorization set up here.'
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
                  ? 'You authorize once, in your browser. The organization shares the resulting token, so everybody reaches the server as the account you sign in with.'
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
          {connectCustomMcp.error && <ErrorNotice occurrence={connectCustomMcp.error}>{connectCustomMcp.error.message}</ErrorNotice>}
        </Modal>
        {api && ashbyWorkspaceOpen && <AshbyWorkspaceSetup api={api} attemptId={ashbySetupKey} onSuccess={() => setAshbySetupKey(crypto.randomUUID())} onClose={() => setAshbyWorkspaceOpen(false)} onRecovered={setInstallationTarget} />}
        {api && installationTarget && <ConnectorInstallationDetails api={api} connectionId={installationTarget} connectionEnabled={connections.data?.some((connection) => connection.id === installationTarget && connection.status !== 'disabled') ?? false} onClose={() => setInstallationTarget(null)} />}
        <Modal
          description="An organization-wide Granola connection requires a Granola Workspace API key. Personal Granola connections use browser sign-in and do not need a key."
          footer={(
            <>
              <Button onClick={() => setGranolaWorkspaceModalOpen(false)}>Cancel</Button>
              <Button
                className="button-primary"
                disabled={!connectorApiKeyAcceptable('granola', granolaWorkspaceApiKey) || createGranolaWorkspaceConnection.isPending || granolaRecovery.isPending || granolaRecovery.isError}
                onClick={() => createGranolaWorkspaceConnection.mutate()}
              >
                {createGranolaWorkspaceConnection.isPending ? <LoaderCircle aria-hidden="true" className="spin" size={14} /> : <LockKeyhole aria-hidden="true" size={14} />}
                Connect for organization
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
          {createGranolaWorkspaceConnection.error && <ErrorNotice occurrence={createGranolaWorkspaceConnection.error}>{createGranolaWorkspaceConnection.error.message}</ErrorNotice>}
          {granolaRecovery.isPending && <p role="status">Checking for an existing organization installation…</p>}
          {granolaRecovery.error && <><ErrorNotice>Existing installations could not be checked. Check again before retrying setup.</ErrorNotice><Button disabled={granolaRecovery.isPending} onClick={() => granolaRecovery.mutate()}>Find existing installation</Button></>}
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
                {leavingClosesWorkspace ? 'Leave and close' : 'Leave organization'}
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
          {departWorkspace.error && <ErrorNotice occurrence={departWorkspace.error}>{departWorkspace.error.message}</ErrorNotice>}
        </Modal>
        <Modal
          description={disconnectTarget?.scope === 'workspace'
            ? 'This removes the connection and its tools from everyone in this organization.'
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
          {disconnectConnection.error && <ErrorNotice occurrence={disconnectConnection.error}>{disconnectConnection.error.message}</ErrorNotice>}
        </Modal>
      </div>
    </div>
  );
}
