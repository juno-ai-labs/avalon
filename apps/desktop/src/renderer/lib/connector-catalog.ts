import { ConnectorProductCatalog, GOOGLE_DRIVE_CAPABILITIES, GOOGLE_MAIL_CALENDAR_CAPABILITIES } from '@rally/contracts';
import { SLACK_PERSONAL_CAPABILITIES } from './slack-personal-capabilities';
const linearNativeAgentEnabled = import.meta.env.VITE_LINEAR_NATIVE_AGENT_ENABLED === 'true';
export const PERSONAL_CONNECT_LABEL = 'Connect for me';

type ProductId = keyof typeof ConnectorProductCatalog;
type Product<Id extends ProductId> = (typeof ConnectorProductCatalog)[Id];
type DesktopScope = 'you' | 'workspace';

/**
 * A Settings card for one product: everything about the product itself comes
 * from `ConnectorProductCatalog` in `@rally/contracts`, so Settings, the
 * transcript and the agent's connector list cannot disagree on a name, a
 * sentence, a mark or a scope. What stays here is the desktop's own: the
 * grants it asks a provider for when a person connects.
 */
function fromCatalog<Id extends ProductId>(id: Id) {
  const product: Product<Id> = ConnectorProductCatalog[id];
  return {
    id,
    provider: product.providerType as Product<Id>['providerType'],
    name: product.name as Product<Id>['name'],
    description: product.description as Product<Id>['description'],
    scopes: product.scopes.map((scope): DesktopScope => (scope === 'personal' ? 'you' : 'workspace')) as readonly DesktopScope[],
  };
}

/** Products the catalog gives a mark. */
type MarkedProductId = { [Id in ProductId]: Product<Id>['iconName'] extends null ? never : Id }[ProductId];

/** The same card with the product's mark. */
function withMark<Id extends MarkedProductId>(id: Id) {
  return { ...fromCatalog(id), mark: ConnectorProductCatalog[id].iconName as Product<Id>['iconName'] };
}

export const connectorProviders = [
  { ...withMark('google-mail-calendar'), capabilities: [...GOOGLE_MAIL_CALENDAR_CAPABILITIES] },
  { ...withMark('google-drive'), capabilities: [...GOOGLE_DRIVE_CAPABILITIES] },
  {
    ...withMark('github'),
    capabilities: ['github.metadata.read', 'github.contents.read', 'github.issues.read', 'github.issues.write', 'github.pull_requests.read', 'github.pull_requests.write', 'github.actions.read', 'github.checks.read'],
  },
  { ...withMark('apollo'), capabilities: ['apollo.personal.mcp'] },
  { ...withMark('ashby'), personalCapabilities: ['ashby.personal.mcp'], capabilities: ['ashby.workspace.events'] },
  { ...withMark('fireflies'), capabilities: ['fireflies.personal.read'] },
  { ...withMark('granola'), personalCapabilities: ['granola.personal.read'], capabilities: ['granola.workspace.read'] },
  {
    ...withMark('linear'),
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
  { ...withMark('slack'), personalCapabilities: SLACK_PERSONAL_CAPABILITIES, capabilities: ['slack.agent', 'slack.notifications.write'] },
  {
    ...withMark('notion'),
    personalCapabilities: ['notion.personal.mcp'],
    capabilities: ['notion.read', 'notion.insert', 'notion.update', 'notion.comment.read', 'notion.comment.insert'],
  },
  { ...withMark('custom-mcp'), capabilities: [] },
  { ...withMark('x'), capabilities: ['x.read'] },
] as const;

export type ConnectorProviderCatalogEntry = (typeof connectorProviders)[number];

export type OAuthConnectorProviderCatalogEntry = Exclude<
  ConnectorProviderCatalogEntry,
  { provider: 'custom_mcp' | 'x' }
>;

export function connectorProviderById(id: string) {
  return connectorProviders.find((provider) => provider.id === id);
}

export function isOAuthConnectorProvider(
  provider: ConnectorProviderCatalogEntry,
): provider is OAuthConnectorProviderCatalogEntry {
  return provider.provider !== 'custom_mcp'
    && provider.provider !== 'x';
}
