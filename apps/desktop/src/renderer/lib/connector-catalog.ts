import { ConnectorConnectionCardCatalog, type OnboardingConnectorId } from '@rally/contracts';
import { SLACK_PERSONAL_CAPABILITIES } from './slack-personal-capabilities';
const linearNativeAgentEnabled = import.meta.env.VITE_LINEAR_NATIVE_AGENT_ENABLED === 'true';
import { ServerCog, Webhook } from 'lucide-react';
export const PERSONAL_CONNECT_LABEL = 'Connect for me';

export const connectorProviders = [
  {
    id: 'google-mail-calendar' as const,
    provider: ConnectorConnectionCardCatalog['google-mail-calendar'].providerType,
    name: 'Google Mail + Calendar',
    description: 'Gmail messages, drafts, sending, and calendar events.',
    mark: ConnectorConnectionCardCatalog['google-mail-calendar'].iconName,
    scopes: ['you'] as const,
    capabilities: ['gmail.read', 'gmail.draft', 'gmail.send', 'calendar.read', 'calendar.write'],
  },
  {
    id: 'google-drive-workspace' as const,
    provider: ConnectorConnectionCardCatalog['google-drive-workspace'].providerType,
    name: 'Google Drive + Docs + Sheets',
    description: 'Drive files, Google Docs, and Sheets content.',
    mark: ConnectorConnectionCardCatalog['google-drive-workspace'].iconName,
    scopes: ['you', 'workspace'] as const,
    capabilities: ['drive.read', 'docs.read', 'docs.write', 'sheets.read', 'sheets.write'],
  },
  {
    id: 'github' as const,
    provider: ConnectorConnectionCardCatalog.github.providerType,
    name: 'GitHub',
    description: 'Repositories, issues, pull requests, checks, and development events.',
    mark: ConnectorConnectionCardCatalog.github.iconName,
    scopes: ['you', 'workspace'] as const,
    capabilities: ['github.metadata.read', 'github.contents.read', 'github.issues.read', 'github.issues.write', 'github.pull_requests.read', 'github.pull_requests.write', 'github.actions.read', 'github.checks.read'],
  },
  {
    id: 'ashby' as const,
    provider: ConnectorConnectionCardCatalog.ashby.providerType,
    name: 'Ashby',
    description: 'Hiring, candidates, interviews, applicant tracking, and pipelines.',
    mark: ConnectorConnectionCardCatalog.ashby.iconName,
    scopes: ['you', 'workspace'] as const,
    personalCapabilities: ['ashby.personal.mcp'],
    capabilities: ['ashby.workspace.events'],
  },
  {
    id: 'fireflies' as const,
    provider: ConnectorConnectionCardCatalog.fireflies.providerType,
    name: 'Fireflies',
    description: 'Meeting transcripts, summaries, and the action items they name.',
    mark: ConnectorConnectionCardCatalog.fireflies.iconName,
    // Personal only. The workspace connection was one administrator's API key
    // that every member read through, so it handed the whole workspace every
    // meeting that key can see; the adapter still serves connections made
    // before that was withdrawn, and `connectableScopes` in
    // `packages/connectors/src/fireflies.ts` is the server saying the same.
    scopes: ['you'] as const,
    capabilities: ['fireflies.personal.read'],
  },
  {
    id: 'granola' as const,
    provider: ConnectorConnectionCardCatalog.granola.providerType,
    name: 'Granola',
    description: 'Meeting notes, transcripts, and the context they capture.',
    mark: ConnectorConnectionCardCatalog.granola.iconName,
    scopes: ['you', 'workspace'] as const,
    personalCapabilities: ['granola.personal.read'],
    capabilities: ['granola.workspace.read'],
  },
  {
    id: 'linear' as const,
    provider: ConnectorConnectionCardCatalog.linear.providerType,
    name: 'Linear',
    description: 'Issues, projects, cycles, comments, and team activity.',
    mark: ConnectorConnectionCardCatalog.linear.iconName,
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
    provider: ConnectorConnectionCardCatalog.slack.providerType,
    name: 'Slack',
    description: 'Search messages, files, people, canvases, and conversations.',
    mark: ConnectorConnectionCardCatalog.slack.iconName,
    scopes: ['you', 'workspace'] as const,
    personalCapabilities: SLACK_PERSONAL_CAPABILITIES,
    capabilities: ['slack.agent', 'slack.notifications.write'],
  },
  {
    id: 'notion' as const,
    provider: ConnectorConnectionCardCatalog.notion.providerType,
    name: 'Notion',
    description: 'Pages, databases, comments, and change notifications.',
    mark: ConnectorConnectionCardCatalog.notion.iconName,
    scopes: ['you', 'workspace'] as const,
    personalCapabilities: ['notion.personal.mcp'],
    capabilities: ['notion.read', 'notion.insert', 'notion.update', 'notion.comment.read', 'notion.comment.insert'],
  },
  {
    id: 'custom-mcp' as const,
    provider: 'custom_mcp' as const,
    name: 'Custom MCP server',
    description: 'Any Model Context Protocol server, connected by URL.',
    icon: ServerCog,
    scopes: ['you', 'workspace'] as const,
    capabilities: [],
  },
  {
    id: 'generic-webhook' as const,
    provider: 'generic_webhook' as const,
    name: 'Inbound webhook',
    description: 'Signed inbound activity from systems without a native connector.',
    icon: Webhook,
    scopes: ['you', 'workspace'] as const,
    capabilities: [],
  },
  {
    id: 'x' as const,
    provider: 'x' as const,
    name: 'Public X via TwitterAPI.io',
    description: 'Public X timelines, threads, replies, and Lists, read-only.',
    mark: 'x' as const,
    scopes: ['workspace'] as const,
    capabilities: ['x.read'],
  },
] as const;

export type ConnectorProviderCatalogEntry = (typeof connectorProviders)[number];

/**
 * Every tile the picker draws is a selection the journey schema accepts. A tile
 * it refuses fails this line at compile time, naming the id — see that schema for
 * why the check exists.
 */
type UnselectablePickerId = Exclude<ConnectorProviderCatalogEntry['id'], OnboardingConnectorId>;
const everyPickerIdIsSelectable: UnselectablePickerId extends never ? true : UnselectablePickerId = true;
void everyPickerIdIsSelectable;
export type OAuthConnectorProviderCatalogEntry = Exclude<
  ConnectorProviderCatalogEntry,
  { provider: 'custom_mcp' | 'generic_webhook' | 'x' }
>;

export function connectorProviderById(id: string) {
  return connectorProviders.find((provider) => provider.id === id);
}

export function isOAuthConnectorProvider(
  provider: ConnectorProviderCatalogEntry,
): provider is OAuthConnectorProviderCatalogEntry {
  return provider.provider !== 'custom_mcp'
    && provider.provider !== 'generic_webhook'
    && provider.provider !== 'x';
}
