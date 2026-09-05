import type { DesktopSettingsSection } from '../../common/settings';
import { appearanceModeDescriptions } from '../../common/themes';
import { applicationIconChoices } from '../../common/application-icons';
import { DAY_PRESETS, WEEKDAYS } from './choices';

export type SettingsAvailability = 'admin' | 'developer' | 'menuBar' | 'login';
export interface SettingDefinition {
  readonly id: string;
  readonly section: DesktopSettingsSection;
  readonly label: string;
  readonly description: string;
  readonly kind: 'toggle' | 'select' | 'action' | 'information' | 'collection' | 'custom';
  readonly availability?: SettingsAvailability;
  readonly options?: readonly string[];
  readonly aliases?: readonly string[];
  /** Setup fields reveal their entry point; search never starts authorization. */
  readonly entryPoint?: string;
}
export function defineSetting<const T extends SettingDefinition>(definition: T): T {
  return definition;
}
export const settings = {
  mcpServer: defineSetting({ id: 'mcpServer', section: 'custom-mcp', label: 'Server authorization', kind: 'information', description: 'Inspect the connected server URL and authentication method.', options: ['Authorize again', 'OAuth', 'Request headers'] }),
  inviteEmail: defineSetting({ id: 'inviteEmail', section: 'workspace', label: "Email address", kind: 'custom', description: "Invite a teammate by email.", availability: 'admin' }),
  inviteRole: defineSetting({ id: 'inviteRole', section: 'workspace', label: "Role", kind: 'select', description: "Choose the invited teammate’s workspace role.", availability: 'admin' }),
  inviteSend: defineSetting({ id: 'inviteSend', section: 'workspace', label: "Send invitation", kind: 'action', description: "Send the invitation after entering an email address.", availability: 'admin' }),
  digestSave: defineSetting({ id: 'digestSave', section: 'digest', label: "Save digest", kind: 'action', description: "Save your digest schedule and delivery preferences." }),
  mcpName: defineSetting({ id: 'mcpName', section: 'connections', label: "Name", kind: 'custom', description: "How this connection is listed in Rally. The server is never asked what it is called.", entryPoint: 'provider:custom-mcp' }),
  mcpUrl: defineSetting({ id: 'mcpUrl', section: 'connections', label: "Server URL", kind: 'custom', description: "The Streamable HTTP endpoint, over HTTPS. Rally checks it responds before saving anything.", entryPoint: 'provider:custom-mcp' }),
  mcpAuth: defineSetting({ id: 'mcpAuth', section: 'connections', label: "Authorization", kind: 'custom', description: "Configure OAuth authorization or encrypted request headers for an MCP server.", entryPoint: 'provider:custom-mcp', options: ['Sign in through the server (OAuth)', 'Send request headers I provide'] }),
  mcpHeaders: defineSetting({ id: 'mcpHeaders', section: 'connections', label: "Header name", kind: 'custom', description: "Configure request header names and secret values.", entryPoint: 'provider:custom-mcp' }),
  mcpHeaderValue: defineSetting({ id: 'mcpHeaderValue', section: 'connections', label: "Header value", kind: 'custom', description: "Secret request header value. Values are never indexed.", entryPoint: 'provider:custom-mcp' }),
  webhookName: defineSetting({ id: 'webhookName', section: 'connections', label: "Name", kind: 'custom', description: "Name this inbound webhook.", entryPoint: 'provider:generic-webhook' }),
  webhookEvents: defineSetting({ id: 'webhookEvents', section: 'connections', label: "Allowed event types", kind: 'custom', description: "Separate names with commas or spaces. Leave empty to accept any valid event type.", entryPoint: 'provider:generic-webhook' }),
  webhookEndpoint: defineSetting({ id: 'webhookEndpoint', section: 'connections', label: "Endpoint", kind: 'information', description: "Copy the webhook endpoint after creation.", entryPoint: 'provider:generic-webhook' }),
  webhookSecret: defineSetting({ id: 'webhookSecret', section: 'connections', label: "Signing secret", kind: 'information', description: "Copy the webhook signing secret after creation. Secret values are never indexed.", entryPoint: 'provider:generic-webhook' }),
  granolaKey: defineSetting({ id: 'granolaKey', section: 'connections', label: "Workspace API key", kind: 'custom', description: "Connect Granola workspace notes and transcripts.", availability: 'admin', entryPoint: 'provider:granola' }),
  profile: defineSetting({ id: 'profile', section: 'account', label: "Profile", kind: 'information', description: "Your Rally identity and access in this workspace.", options: ['Name', 'Email', 'Role'] }),
  personalTimezone: defineSetting({ id: 'personalTimezone', section: 'account', label: "Default timezone", kind: 'select', description: "Used for your personal automations when no timezone is specified.", aliases: ['time zone'] }),
  signOut: defineSetting({ id: 'signOut', section: 'account', label: "Sign out of Rally", kind: 'action', description: "Remove the local session from this Mac." }),
  workspaceRegion: defineSetting({ id: 'workspaceRegion', section: 'workspace', label: "Data region", kind: 'information', description: "All workspace data, sessions, and requests remain pinned to this regional service." }),
  workspaceIdentity: defineSetting({ id: 'workspaceIdentity', section: 'workspace', label: "Workspace", kind: 'information', description: "The shared Rally workspace active in this desktop app." }),
  workspaceTimezone: defineSetting({ id: 'workspaceTimezone', section: 'workspace', label: "Default timezone", kind: 'select', description: "Used when a workspace automation does not specify a timezone.", aliases: ['time zone'] }),
  terminal: defineSetting({ id: 'terminal', section: 'workspace', label: "Terminal network access", kind: 'custom', description: "Choose where code running in Daytona may connect. Rally-managed platform access is applied automatically.", options: ['Review network change', 'Confirm network change', 'Download workspace domains'] }),
  trustedNetwork: defineSetting({ id: 'trustedNetwork', section: 'workspace', label: "Trusted only", kind: 'custom', description: "Rally-managed platform access plus domains your workspace approves." }),
  fullNetwork: defineSetting({ id: 'fullNetwork', section: 'workspace', label: "Full internet", kind: 'custom', description: "Allow arbitrary public destinations. Private network access remains blocked by Daytona." }),
  terminalDomains: defineSetting({ id: 'terminalDomains', section: 'workspace', label: "Workspace-approved domains", kind: 'custom', description: "Additional Terminal domains" }),
  members: defineSetting({ id: 'members', section: 'workspace', label: "Members", kind: 'collection', description: "People with access to this workspace." }),
  invitations: defineSetting({ id: 'invitations', section: 'workspace', label: "Invitations", kind: 'custom', description: "Invite teammates by email. Links expire after seven days.", availability: 'admin', options: ['Revoke invitation', 'Copy invitation link'] }),
  workspaceAccess: defineSetting({ id: 'workspaceAccess', section: 'workspace', label: "Workspace access", kind: 'action', description: "Leaving removes this workspace from your Rally account on every device." }),
  connections: defineSetting({ id: 'connections', section: 'connections', label: "Your connections", kind: 'collection', description: "Credentials currently available to you or this workspace." }),
  githubAccess: defineSetting({ id: 'githubAccess', section: 'github', label: "Repository access", kind: 'custom', description: "Configure GitHub repository permissions." }),
  githubAvailability: defineSetting({ id: 'githubAvailability', section: 'github', label: "Repository availability", kind: 'select', description: "All repositories follows the GitHub App installation. Selected repositories exposes only the entries you add below.", options: ['All repositories', 'Selected repositories'] }),
  githubRemote: defineSetting({ id: 'githubRemote', section: 'github', label: "Default remote access", kind: 'select', description: "Read-only still allows Rally to edit and commit locally. It blocks push, pull requests, issues, reviews, and other remote mutations.", options: ['Read-only remote', 'Full remote access'] }),
  githubRepositories: defineSetting({ id: 'githubRepositories', section: 'github', label: "Repositories", kind: 'collection', description: "Search repositories and configure individual remote access." }),
  mcpTools: defineSetting({ id: 'mcpTools', section: 'custom-mcp', label: "MCP tools", kind: 'custom', description: "Configure a connected MCP server." }),
  mcpPolicy: defineSetting({ id: 'mcpPolicy', section: 'custom-mcp', label: "Tools Rally may use", kind: 'select', description: "Choose which tools the server may expose.", options: ['All tools', 'Read-only tools'] }),
  mcpCatalog: defineSetting({ id: 'mcpCatalog', section: 'custom-mcp', label: "Tools", kind: 'collection', description: "Inspect tool names and descriptions." }),
  lockdown: defineSetting({ id: 'lockdown', section: 'application', label: "Lockdown mode", kind: 'toggle', description: "Protect the saved session with this Mac’s keystore instead of Rally’s shared encryption key." }),
  analytics: defineSetting({ id: 'analytics', section: 'application', label: "Product analytics", kind: 'toggle', description: "Share semantic product usage, sanitized errors and breadcrumbs, and native crash reports. Global telemetry can include your verified name and email so Rally can contact you; EU telemetry stays in Rally’s EU platform. Essential content-free reliability signals continue when this is off." }),
  appearance: defineSetting({ id: 'appearance', section: 'application', label: "Appearance", kind: 'select', description: "Follow this Mac or keep Rally light or dark.", options: appearanceModeDescriptions.map((option) => option.label), aliases: ['theme'] }),
  menuBar: defineSetting({ id: 'menuBar', section: 'application', label: "Show Rally in the menu bar", kind: 'toggle', description: "Keep the Rally mark in the menu bar for a new meeting or note, a new automation, what Rally suggests next, and your recent work streams.", availability: 'menuBar' }),
  appIcon: defineSetting({ id: 'appIcon', section: 'application', label: "App icon", kind: 'custom', description: "Choose how Rally appears in the Dock, Finder, Launchpad, and Spotlight.", options: applicationIconChoices.map((option) => option.label) }),
  login: defineSetting({ id: 'login', section: 'application', label: "Open Rally at login", kind: 'toggle', description: "Start Rally when you log in. With Rally in the menu bar it starts there quietly, with no window; without it, a window opens as usual.", availability: 'login' }),
  debug: defineSetting({ id: 'debug', section: 'application', label: "Debug enabled", kind: 'toggle', description: "Show debugging actions such as copying a work stream or automation identifier from its right-click menu, and the rows describing how a work stream is wired in its Details.", availability: 'developer' }),
  telemetry: defineSetting({ id: 'telemetry', section: 'application', label: "Telemetry inspector", kind: 'information', description: "Recent contract decisions only. Values and identifiers are always redacted.", availability: 'developer' }),
  about: defineSetting({ id: 'about', section: 'application', label: "About", kind: 'information', description: "Build and service details for this Rally installation." }),
  version: defineSetting({ id: 'version', section: 'application', label: "Version", kind: 'information', description: "" }),
  build: defineSetting({ id: 'build', section: 'application', label: "Build", kind: 'information', description: "" }),
  platform: defineSetting({ id: 'platform', section: 'application', label: "Platform", kind: 'information', description: "" }),
  api: defineSetting({ id: 'api', section: 'application', label: "Regional API", kind: 'information', description: "" }),
  realtime: defineSetting({ id: 'realtime', section: 'application', label: "Realtime", kind: 'information', description: "Automatic reconnect · hibernating socket" }),
  digestEnabled: defineSetting({ id: 'digestEnabled', section: 'digest', label: "Send me a digest", kind: 'toggle', description: "Rally writes it at the times you choose and sends it where you choose." }),
  digestDays: defineSetting({ id: 'digestDays', section: 'digest', label: "Days", kind: 'custom', description: "Choose the days of the week.", options: [...DAY_PRESETS.map((choice) => choice.label), ...WEEKDAYS.map((choice) => choice.name)] }),
  digestTimes: defineSetting({ id: 'digestTimes', section: 'digest', label: "Times", kind: 'custom', description: "Add or remove delivery times for your digest." }),
  digestDelivery: defineSetting({ id: 'digestDelivery', section: 'digest', label: "Deliver to", kind: 'collection', description: "Choose email or a connected messaging service." }),
  digestEmail: defineSetting({ id: 'digestEmail', section: 'digest', label: "Email", kind: 'toggle', description: "Sent to your Rally account address." }),
} satisfies Record<string, SettingDefinition>;

export interface SettingsSearchContext {
  readonly sections: ReadonlySet<DesktopSettingsSection>;
  readonly admin: boolean;
  readonly developer: boolean;
  readonly menuBar: boolean;
  readonly login: boolean;
}
export function isSettingAvailable(setting: SettingDefinition, context: SettingsSearchContext): boolean {
  return context.sections.has(setting.section)
    && (!setting.availability || context[setting.availability]);
}
export interface SettingSearchResult {
  readonly key: string;
  readonly definition: SettingDefinition;
  readonly instanceId?: string;
  readonly instanceLabel?: string;
}
/** Providers use already-authorized metadata, never fetch or read form values. */
export interface SettingsProvider {
  readonly id: string;
  readonly entries: readonly SettingSearchResult[];
}
export function collectSettings(providers: readonly SettingsProvider[], context: SettingsSearchContext): SettingSearchResult[] {
  const keys = new Set<string>();
  return providers.flatMap((provider) => provider.entries).filter((entry) => {
    if (keys.has(entry.key)) throw new Error(`Duplicate setting search key: ${entry.key}`);
    keys.add(entry.key);
    return isSettingAvailable(entry.definition, context);
  });
}
const normalize = (text: string): string => text.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase().trim();
export function searchSettings(entries: readonly SettingSearchResult[], query: string): SettingSearchResult[] {
  const needle = normalize(query);
  if (!needle) return [];
  const words = needle.split(/\s+/);
  return entries.map((entry, index) => {
    const { definition } = entry;
    const label = normalize(definition.label);
    const text = normalize([definition.label, definition.description, definition.section,
      ...(definition.options ?? []), ...(definition.aliases ?? []), entry.instanceLabel ?? ''].join(' '));
    const score = label === needle ? 4 : label.startsWith(needle) ? 3 : label.includes(needle) ? 2 : 1;
    return { entry, index, score, matches: words.every((word) => text.includes(word)) };
  }).filter((match) => match.matches)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((match) => match.entry);
}
export const coreSettingsProvider: SettingsProvider = {
  id: 'core',
  entries: Object.values(settings).map((definition) => ({ key: definition.id, definition })),
};
