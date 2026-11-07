import type { DesktopSettingsSection } from '../../common/settings';
import { appearanceModeDescriptions } from '../../common/themes';
import { applicationIconChoices } from '../../common/application-icons';
import { githubAvailabilityLabels, githubRemoteLabels, mcpAuthLabels } from './choices';

export type SettingsAvailability = 'admin' | 'developer' | 'menuBar' | 'login' | 'releaseChannel' | 'browser';
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
  /**
   * Set on a setting that lives on one connection's page. It is indexed once per
   * connection whose `settingsKind` matches, never on its own.
   */
  readonly connectionKind?: 'github_repository_access' | 'custom_mcp_tools';
}
export function defineSetting<const T extends SettingDefinition>(definition: T): T {
  return definition;
}
export const settings = {
  mcpServer: defineSetting({ id: 'mcpServer', section: 'connection', connectionKind: 'custom_mcp_tools', label: 'Server authorization', kind: 'information', description: 'Inspect the connected server URL and authentication method.', options: ['Authorize again', 'OAuth', 'Request headers'] }),
  inviteEmail: defineSetting({ id: 'inviteEmail', section: 'members', label: "Email address", kind: 'custom', description: "Invite a teammate by email.", availability: 'admin' }),
  inviteRole: defineSetting({ id: 'inviteRole', section: 'members', label: "Role", kind: 'select', description: "Choose the invited teammate’s organization role.", availability: 'admin' }),
  inviteSend: defineSetting({ id: 'inviteSend', section: 'members', label: "Send invitation", kind: 'action', description: "Send the invitation after entering an email address.", availability: 'admin' }),
  mcpSetupPolicy: defineSetting({ id: 'mcpSetupPolicy', section: 'connections', label: 'Tools Rally may use', kind: 'select', description: 'Choose which tools the organization server may expose.', availability: 'admin', entryPoint: 'provider:custom-mcp', options: ['All tools', 'Read-only tools'] }),
  mcpName: defineSetting({ id: 'mcpName', section: 'connections', label: "Name", kind: 'custom', description: "How this connection is listed in Rally. The server is never asked what it is called.", entryPoint: 'provider:custom-mcp' }),
  mcpUrl: defineSetting({ id: 'mcpUrl', section: 'connections', label: "Server URL", kind: 'custom', description: "The Streamable HTTP endpoint, over HTTPS. Rally checks it responds before saving anything.", entryPoint: 'provider:custom-mcp' }),
  mcpAuth: defineSetting({ id: 'mcpAuth', section: 'connections', label: "Authorization", kind: 'custom', description: "Configure OAuth authorization or encrypted request headers for an MCP server.", entryPoint: 'provider:custom-mcp', options: Object.values(mcpAuthLabels) }),
  mcpHeaders: defineSetting({ id: 'mcpHeaders', section: 'connections', label: "Header name", kind: 'custom', description: "Configure request header names and secret values.", entryPoint: 'provider:custom-mcp' }),
  mcpHeaderValue: defineSetting({ id: 'mcpHeaderValue', section: 'connections', label: "Header value", kind: 'custom', description: "Secret request header value. Values are never indexed.", entryPoint: 'provider:custom-mcp' }),
  webhookName: defineSetting({ id: 'webhookName', section: 'connections', label: "Name", kind: 'custom', description: "Name this inbound webhook.", entryPoint: 'provider:generic-webhook' }),
  webhookEvents: defineSetting({ id: 'webhookEvents', section: 'connections', label: "Allowed event types", kind: 'custom', description: "Separate names with commas or spaces. Leave empty to accept any valid event type.", entryPoint: 'provider:generic-webhook' }),
  webhookEndpoint: defineSetting({ id: 'webhookEndpoint', section: 'connections', label: "Endpoint", kind: 'information', description: "Copy the webhook endpoint after creation.", entryPoint: 'provider:generic-webhook' }),
  webhookSecret: defineSetting({ id: 'webhookSecret', section: 'connections', label: "Signing secret", kind: 'information', description: "Copy the webhook signing secret after creation. Secret values are never indexed.", entryPoint: 'provider:generic-webhook' }),
  ashbyKey: defineSetting({ id: 'ashbyKey', section: 'connections', label: 'Ashby organization API key', kind: 'custom', description: 'Authorize shared recruiting webhook setup and recovery.', availability: 'admin', entryPoint: 'provider:ashby', aliases: ['workspace'] }),
  granolaKey: defineSetting({ id: 'granolaKey', section: 'connections', label: "Workspace API key", kind: 'custom', description: "Connect Granola workspace notes and transcripts.", availability: 'admin', entryPoint: 'provider:granola' }),
  profile: defineSetting({ id: 'profile', section: 'account', label: "Profile", kind: 'information', description: "Your Rally identity and access in this organization.", options: ['Name', 'Email', 'Role'] }),
  profileName: defineSetting({ id: 'profileName', section: 'account', label: 'Name', kind: 'custom', description: 'Your display name in Rally.', aliases: ['account name', 'display name'] }),
  profileInitials: defineSetting({ id: 'profileInitials', section: 'account', label: 'Avatar initials', kind: 'custom', description: 'The initials shown in your avatar.' }),
  profileColor: defineSetting({ id: 'profileColor', section: 'account', label: 'Color', kind: 'custom', description: 'Your avatar and personal accent color.', aliases: ['colour', 'avatar color'] }),
  personalTimezoneAutomatic: defineSetting({ id: 'personalTimezoneAutomatic', section: 'account', label: "Set timezone automatically", kind: 'toggle', description: "Follow the timezone of the device you are using.", aliases: ['time zone', 'automatic', 'device', 'travel'] }),
  personalTimezone: defineSetting({ id: 'personalTimezone', section: 'account', label: "Default timezone", kind: 'select', description: "Your digests run in this timezone, and new personal automations start in it.", aliases: ['time zone'] }),
  personalSystemPrompt: defineSetting({ id: 'personalSystemPrompt', section: 'account', label: "Personal system prompt", kind: 'custom', description: "Instructions Rally includes with your messages in this Organization. Hidden from the conversation display.", aliases: ['custom instructions', 'prompt'] }),
  showAgentWork: defineSetting({ id: 'showAgentWork', section: 'account', label: "Show agent work", kind: 'toggle', description: "Show the agent's thinking and its tool and plugin calls in conversations in this Organization. Requests that need you, like connecting an account, always show.", aliases: ['tool calls', 'plugin calls', 'thinking'] }),
  signOut: defineSetting({ id: 'signOut', section: 'account', label: "Sign out of Rally", kind: 'action', description: "Remove the local session from this device." }),
  workspaceIdentity: defineSetting({ id: 'workspaceIdentity', section: 'workspace', label: "Organization", kind: 'custom', description: "The shared Rally organization active in this desktop app. Administrators can double-click its name to rename it.", aliases: ["organization","workspace","rename","organization name"] }),
  workspaceTimezone: defineSetting({ id: 'workspaceTimezone', section: 'workspace', label: "Default timezone", kind: 'select', description: "Used when an organization automation does not specify a timezone.", aliases: ['time zone'] }),
  supportAccess: defineSetting({ id: 'supportAccess', section: 'workspace', label: "Allow Rally access", kind: 'action', description: "Let the Rally team sign in as people in this organization for seven days, to help set it up and fix problems.", aliases: ['support', 'impersonation', 'rally team'] }),
  terminal: defineSetting({ id: 'terminal', section: 'internet-access', label: "Terminal network access", kind: 'custom', description: "Choose what your cloud computers can connect to.", options: ['Save network change'], aliases: ['security', 'internet access'] }),
  trustedNetwork: defineSetting({ id: 'trustedNetwork', section: 'internet-access', label: "Trusted only", kind: 'custom', description: "Rally-managed platform access plus domains your organization approves." }),
  fullNetwork: defineSetting({ id: 'fullNetwork', section: 'internet-access', label: "Full internet", kind: 'custom', description: "Allow unrestricted access to the entire internet." }),
  terminalDomains: defineSetting({ id: 'terminalDomains', section: 'internet-access', label: "Organization-approved domains", kind: 'custom', description: "Additional Terminal domains", aliases: ["workspace"] }),
  plan: defineSetting({ id: 'plan', section: 'workspace', label: "Plan", kind: 'select', description: "Sets the weekly quota everyone in the organization shares. Only administrators can change it.", aliases: ['billing', 'upgrade', 'starter', 'growth'], entryPoint: 'usage' }),
  quota: defineSetting({ id: 'quota', section: 'workspace', label: "Weekly quota", kind: 'information', description: "How much of this week's shared quota is left.", aliases: ['limit', 'remaining'], entryPoint: 'usage' }),
  usage: defineSetting({ id: 'usage', section: 'workspace', label: "Usage", kind: 'information', description: "Your organization's plan and its shared weekly quota.", aliases: ['limit'] }),
  members: defineSetting({ id: 'members', section: 'members', label: "Members", kind: 'collection', description: "People with access to this organization.", aliases: ["roles"] }),
  invitations: defineSetting({ id: 'invitations', section: 'members', label: "Invitations", kind: 'custom', description: "Invite teammates by email. Links expire after seven days.", availability: 'admin', options: ['Revoke invitation', 'Copy invitation link'] }),
  workspaceAccess: defineSetting({ id: 'workspaceAccess', section: 'workspace', label: "Organization access", kind: 'action', description: "Leaving removes this organization from your Rally account on every device.", aliases: ["workspace"] }),
  connections: defineSetting({ id: 'connections', section: 'connections', label: "Your connections", kind: 'collection', description: "Credentials currently available to you or this organization.", aliases: ["integrations","connectors"] }),
  githubAccess: defineSetting({ id: 'githubAccess', section: 'connection', connectionKind: 'github_repository_access', label: "Repository access", kind: 'custom', description: "Configure GitHub repository permissions." }),
  githubAvailability: defineSetting({ id: 'githubAvailability', section: 'connection', connectionKind: 'github_repository_access', label: "Repository availability", kind: 'select', description: "All repositories follows the GitHub App installation. Selected repositories exposes only the entries you add below.", options: Object.values(githubAvailabilityLabels) }),
  githubRemote: defineSetting({ id: 'githubRemote', section: 'connection', connectionKind: 'github_repository_access', label: "Default remote access", kind: 'select', description: "Read-only still allows Rally to edit and commit locally. It blocks push, pull requests, issues, reviews, and other remote mutations.", options: Object.values(githubRemoteLabels) }),
  githubRepositories: defineSetting({ id: 'githubRepositories', section: 'connection', connectionKind: 'github_repository_access', label: "Repositories", kind: 'collection', description: "Search repositories and configure individual remote access." }),
  mcpTools: defineSetting({ id: 'mcpTools', section: 'connection', connectionKind: 'custom_mcp_tools', label: "MCP tools", kind: 'custom', description: "Configure a connected MCP server.", aliases: ["integrations"] }),
  mcpPolicy: defineSetting({ id: 'mcpPolicy', section: 'connection', connectionKind: 'custom_mcp_tools', label: "Tools Rally may use", kind: 'select', description: "Choose which tools the server may expose.", options: ['All tools', 'Read-only tools'] }),
  mcpCatalog: defineSetting({ id: 'mcpCatalog', section: 'connection', connectionKind: 'custom_mcp_tools', label: "Tools", kind: 'collection', description: "Inspect tool names and descriptions." }),
  lockdown: defineSetting({ id: 'lockdown', section: 'application', label: "Lockdown mode", kind: 'toggle', description: "Protect the saved session with this Mac’s keystore instead of Rally’s shared encryption key.", aliases: ["security","keychain","privacy"] }),
  analytics: defineSetting({ id: 'analytics', section: 'application', label: "Product analytics", kind: 'toggle', description: "Share semantic product usage, sanitized errors and breadcrumbs, and native crash reports. Telemetry can include your verified name and email so Rally can contact you. Essential content-free reliability signals continue when this is off.", aliases: ["privacy","diagnostics"] }),
  appearance: defineSetting({ id: 'appearance', section: 'application', label: "Appearance", kind: 'select', description: "Follow this device or keep Rally light or dark.", options: appearanceModeDescriptions.map((option) => option.label), aliases: ['theme'] }),
  // A browser has no Application section, so its appearance picker lives under
  // Account. Same control and copy; only the section search sends you to differs.
  accountAppearance: defineSetting({ id: 'accountAppearance', section: 'account', label: "Appearance", kind: 'select', description: "Follow this device or keep Rally light or dark.", options: appearanceModeDescriptions.map((option) => option.label), availability: 'browser', aliases: ['theme'] }),
  pushNotifications: defineSetting({ id: 'pushNotifications', section: 'notifications', label: "Show notifications", description: "Show notifications on this device, even when Rally is closed.", kind: 'toggle', aliases: ['push'] }),
  notifyMentions: defineSetting({ id: 'notifyMentions', section: 'notifications', label: "Mentions", description: "When someone mentions you.", kind: 'custom', aliases: ['push', 'email', 'slack', 'notify'] }),
  notifyAdded: defineSetting({ id: 'notifyAdded', section: 'notifications', label: "Added to a Canvas", description: "When someone adds you to a Canvas.", kind: 'custom', aliases: ['push', 'email', 'slack', 'notify', 'additions'] }),
  notifyArtifactUpdates: defineSetting({ id: 'notifyArtifactUpdates', section: 'notifications', label: "Pinned artifact updates", description: "When someone makes a new version of an artifact you pinned.", kind: 'custom', aliases: ['push', 'email', 'slack', 'notify', 'artifact', 'pin', 'version'] }),
  notifyNewMessages: defineSetting({ id: 'notifyNewMessages', section: 'notifications', label: "New messages", description: "When someone replies in a Canvas you take part in.", kind: 'custom', aliases: ['push', 'email', 'slack', 'notify', 'reply', 'message'] }),
  notifyRunFinished: defineSetting({ id: 'notifyRunFinished', section: 'notifications', label: "Rally finished", description: "When Rally finishes working in a Canvas you take part in.", kind: 'custom', aliases: ['push', 'email', 'slack', 'notify', 'run', 'done'] }),
  menuBar: defineSetting({ id: 'menuBar', section: 'application', label: "Show Rally in the menu bar", kind: 'toggle', description: "Keep the Rally mark in the menu bar with what needs your attention and your recent Canvases.", availability: 'menuBar', aliases: ["status item","meetings"] }),
  appIcon: defineSetting({ id: 'appIcon', section: 'application', label: "App icon", kind: 'custom', description: "Choose how Rally appears in the Dock, Finder, Launchpad, and Spotlight.", options: applicationIconChoices.map((option) => option.label) }),
  releaseChannel: defineSetting({ id: 'releaseChannel', section: 'application', label: "Update channel", kind: 'select', description: "Stable receives no more than one desktop release every 24 hours. Faster receives every desktop release.", options: ['Stable', 'Faster'], availability: 'releaseChannel', aliases: ['release pace', 'updates'] }),
  login: defineSetting({ id: 'login', section: 'application', label: "Open Rally at login", kind: 'toggle', description: "Start Rally when you log in. With Rally in the menu bar it starts there quietly, with no window; without it, a window opens as usual.", availability: 'login', aliases: ["startup"] }),
  debug: defineSetting({ id: 'debug', section: 'application', label: "Debug enabled", kind: 'toggle', description: "Show debugging actions such as copying a Canvas or Sidekick identifier from its right-click menu, and the rows describing how a conversation is wired in its Details.", availability: 'developer', aliases: ["developer","diagnostics"] }),
  about: defineSetting({ id: 'about', section: 'application', label: "About", kind: 'information', description: "Which release of Rally this Mac is running." }),
  version: defineSetting({ id: 'version', section: 'application', label: "Version", kind: 'information', description: "" }),
} satisfies Record<string, SettingDefinition>;

export interface SettingsSearchContext {
  readonly sections: ReadonlySet<DesktopSettingsSection>;
  readonly admin: boolean;
  readonly developer: boolean;
  readonly menuBar: boolean;
  readonly login: boolean;
  readonly releaseChannel: boolean;
  /** Settings is running as a route in a browser tab rather than the Mac app. */
  readonly browser: boolean;
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
    // Replayed provider metadata must not take down the settings window.
    if (keys.has(entry.key)) return false;
    keys.add(entry.key);
    return isSettingAvailable(entry.definition, context);
  });
}
const normalize = (text: string): string => text.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[’‘]/g, "'").toLowerCase().trim();
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
    .sort((a, b) => b.score - a.score
      || Number(a.entry.definition.kind === 'action') - Number(b.entry.definition.kind === 'action')
      || a.entry.definition.label.localeCompare(b.entry.definition.label)
      || a.index - b.index)
    .map((match) => match.entry);
}
export const coreSettingsProvider: SettingsProvider = {
  id: 'core',
  entries: Object.values(settings).map((definition) => ({ key: definition.id, definition })),
};
