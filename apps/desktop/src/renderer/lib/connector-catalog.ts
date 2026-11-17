import { ConnectorProductCatalog, GOOGLE_MAIL_CALENDAR_CAPABILITIES } from '@rally/contracts';
import { SLACK_PERSONAL_CAPABILITIES } from './slack-personal-capabilities';
const linearNativeAgentEnabled = import.meta.env.VITE_LINEAR_NATIVE_AGENT_ENABLED === 'true';
import { Webhook } from 'lucide-react';
export const CANVA_CONNECTION_DISCLOSURE = 'Connecting lets Rally read and change your Canva designs, folders, assets and brand kit. Canva receives a brief description of each requested operation. Watches are off until you enable them.';
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
    mark: product.iconName as Exclude<Product<Id>['iconName'], null>,
    scopes: product.scopes.map((scope): DesktopScope => (scope === 'personal' ? 'you' : 'workspace')) as readonly DesktopScope[],
    ...('desktopOnly' in product ? { desktopOnly: true as const } : {}),
  };
}

function withoutMark<Entry extends { mark: unknown }>(entry: Entry): Omit<Entry, 'mark'> {
  const copy: Partial<Entry> = { ...entry };
  delete copy.mark;
  return copy as Omit<Entry, 'mark'>;
}

export const connectorProviders = [
  { ...fromCatalog('google-mail-calendar'), capabilities: [...GOOGLE_MAIL_CALENDAR_CAPABILITIES] },
  {
    ...fromCatalog('google-drive'),
    capabilities: ['drive.read', 'docs.read', 'docs.write', 'sheets.read', 'sheets.write'],
  },
  {
    ...fromCatalog('github'),
    capabilities: ['github.metadata.read', 'github.contents.read', 'github.issues.read', 'github.issues.write', 'github.pull_requests.read', 'github.pull_requests.write', 'github.actions.read', 'github.checks.read'],
  },
  { ...fromCatalog('apollo'), capabilities: ['apollo.personal.mcp'] },
  { ...fromCatalog('ashby'), personalCapabilities: ['ashby.personal.mcp'], capabilities: ['ashby.workspace.events'] },
  { ...fromCatalog('canva'), capabilities: ['canva.personal.mcp'] },
  { ...fromCatalog('fireflies'), capabilities: ['fireflies.personal.read'] },
  { ...fromCatalog('granola'), personalCapabilities: ['granola.personal.read'], capabilities: ['granola.workspace.read'] },
  {
    ...fromCatalog('linear'),
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
  { ...fromCatalog('slack'), personalCapabilities: SLACK_PERSONAL_CAPABILITIES, capabilities: ['slack.agent', 'slack.notifications.write'] },
  {
    ...fromCatalog('notion'),
    personalCapabilities: ['notion.personal.mcp'],
    capabilities: ['notion.read', 'notion.insert', 'notion.update', 'notion.comment.read', 'notion.comment.insert'],
  },
  { ...fromCatalog('custom-mcp'), capabilities: [] },
  // The catalog gives a webhook no mark; Settings draws a generic glyph.
  withoutMark({ ...fromCatalog('generic-webhook'), icon: Webhook, capabilities: [] }),
  { ...fromCatalog('x'), capabilities: ['x.read'] },
] as const;

export type ConnectorProviderCatalogEntry = (typeof connectorProviders)[number];

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

/** Whether connecting `connectorType` needs the Mac app; a browser tab cannot start or refresh it. */
export function isDesktopOnlyConnector(connectorType: string): boolean {
  return connectorProviders.some((provider) => provider.provider === connectorType && 'desktopOnly' in provider);
}
