import type { WorkstreamConnection } from './types';
import {
  ConnectorProductCatalog,
  ConnectorProductIds,
  connectorConnectionServesProduct,
  type ConnectorProductId,
} from '@rally/contracts';
import { connectorBrandMark, type PluginBrandMark } from './plugin-marks';

/**
 * How a connector presents in the transcript — name, blurb, and mark — keyed by
 * the type stored on a mention. Marks match the settings provider catalog
 * (`workspace-settings.tsx` `connectorProviders[].mark`) so the same connector
 * wears the same icon in the transcript and in Connections.
 */
export interface ConnectorPresentation {
  readonly name: string;
  readonly description: string;
  readonly mark: PluginBrandMark | null;
  /** The product this presents, when it is one; its connections are the ones that serve it. */
  readonly productId?: ConnectorProductId;
}

type CatalogEntry = { readonly name: string; readonly description: string };

/**
 * Where a mention's blurb deliberately differs from the product's sentence in
 * `ConnectorProductCatalog`, which Settings' card and the agent's list show.
 */
const MENTION_DESCRIPTIONS: Readonly<Record<string, string>> = {
  // The card explains how to add a server; a mention is about what the tools are.
  custom_mcp: 'Tools served live by a Model Context Protocol server you point Rally at.',
  // The card offers a connection to make, while a mention may be the workspace Agent itself.
  slack: 'Messages, files, people, canvases, conversations, and the Rally workspace Agent.',
};

/**
 * Every provider that is one product, keyed by the type stored on a mention.
 * Google is two products under one type, so it is presented by bundle below.
 */
const CATALOG: Readonly<Record<string, CatalogEntry & { readonly productId: ConnectorProductId }>> = Object.fromEntries(
  ConnectorProductIds
    .filter((id) => ConnectorProductCatalog[id].providerType !== 'google')
    .map((id) => {
      const product = ConnectorProductCatalog[id];
      return [product.providerType, {
        productId: id,
        name: product.name,
        description: MENTION_DESCRIPTIONS[product.providerType] ?? product.description,
      }];
    }),
);

export type ConnectorScopeStatus = 'healthy' | 'reconnect_required' | 'disabled' | 'missing';

export interface ConnectorScopeState {
  readonly scope: 'you' | 'workspace';
  readonly status: ConnectorScopeStatus;
  readonly connections: readonly WorkstreamConnection[];
  readonly capabilities: readonly string[];
}

function googlePresentation(displayName?: string): ConnectorPresentation {
  const renderedName = displayName?.replace(/^@/u, '');
  const normalizedName = renderedName?.toLowerCase() ?? '';
  // A mention's label is free text ("@Gmail", "@Google Drive"), with no
  // connection in hand to match grants against, so the words decide.
  const productId = /drive|docs|sheets/u.test(normalizedName)
    ? 'google-drive' as const
    : /gmail|mail|calendar/u.test(normalizedName)
      ? 'google-mail-calendar' as const
      : undefined;
  const product = productId ? ConnectorProductCatalog[productId] : undefined;
  return {
    name: renderedName || product?.name || 'Google Workspace',
    description: product?.description ?? 'Mail, calendar, Drive, Docs, and Sheets through connected Google accounts.',
    mark: connectorBrandMark('google', product?.name ?? renderedName),
    ...(productId ? { productId } : {}),
  };
}

export function connectorPresentation(
  connectorType: string,
  displayName?: string,
): ConnectorPresentation {
  if (connectorType === 'google') return googlePresentation(displayName);
  const entry = CATALOG[connectorType];
  const renderedName = displayName?.replace(/^@/u, '');
  return {
    name: renderedName || entry?.name || connectorType,
    description: entry?.description ?? 'Organization connector.',
    mark: connectorBrandMark(connectorType, renderedName),
    ...(entry ? { productId: entry.productId } : {}),
  };
}

function bestConnectorStatus(statuses: readonly ConnectorScopeStatus[]): ConnectorScopeStatus {
  if (statuses.includes('healthy')) return 'healthy';
  if (statuses.includes('reconnect_required')) return 'reconnect_required';
  if (statuses.includes('disabled')) return 'disabled';
  return 'missing';
}

/**
 * Personal and workspace rows for one connector presentation, always both.
 * With a product, only connections serving it count (the shared
 * `connectorConnectionServesProduct`); without one, every connection of the
 * type does. This fold stays the desktop's because it shows Disabled, which
 * the agent's product states do not.
 * Every applicable credential contributes: response order cannot change status
 * and capability unions remain stable across reconnects and account additions.
 */
export function connectorScopeStates(
  connectorType: string,
  connections: readonly WorkstreamConnection[],
  productId?: ConnectorProductId,
): readonly [ConnectorScopeState, ConnectorScopeState] {
  const matching = connections.filter((connection) =>
    connection.connectorType === connectorType &&
    (productId === undefined || connectorConnectionServesProduct(productId, {
      connectorType: connection.connectorType,
      capabilities: connection.capabilities ?? [],
    })));
  const state = (scope: 'you' | 'workspace'): ConnectorScopeState => {
    const scopeConnections = matching.filter((connection) => connection.scope === scope);
    const capabilities = [...new Set(scopeConnections.flatMap((connection) => connection.capabilities ?? []))]
      .sort();
    return {
      scope,
      status: bestConnectorStatus(scopeConnections.map((connection) => connection.status)),
      connections: scopeConnections,
      capabilities,
    };
  };
  return [state('you'), state('workspace')];
}

/**
 * One status for an inline chip: healthy if either scope is healthy, otherwise
 * the worse of the two that exist, otherwise missing.
 */
export function connectorAggregateStatus(
  states: readonly ConnectorScopeState[],
): ConnectorScopeStatus {
  return bestConnectorStatus(states.map((state) => state.status));
}

export function connectorStatusLabel(status: ConnectorScopeStatus): string {
  switch (status) {
    case 'healthy': return 'Connected';
    case 'reconnect_required': return 'Reconnect';
    case 'disabled': return 'Disabled';
    case 'missing': return 'Not connected';
  }
}

export function connectorScopeLabel(scope: 'you' | 'workspace'): string {
  return scope === 'you' ? 'Personal' : 'Organization';
}
