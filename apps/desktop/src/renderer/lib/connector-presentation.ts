import type { WorkstreamConnection } from './types';
import { ConnectorProductCatalog, ConnectorProductIds } from '@rally/contracts';
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
  /** Capability families a same-provider connection must carry for this label. */
  readonly capabilityPrefixes?: readonly string[];
}

type CatalogEntry = { readonly name: string; readonly description: string };
type GoogleBundle = CatalogEntry & { readonly capabilityPrefixes: readonly string[] };

function googleBundle(id: 'google-mail-calendar' | 'google-drive'): GoogleBundle {
  const { name, description, capabilityPrefixes } = ConnectorProductCatalog[id];
  return { name, description, capabilityPrefixes };
}

const GOOGLE_MAIL = googleBundle('google-mail-calendar');
const GOOGLE_FILES = googleBundle('google-drive');

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
const CATALOG: Readonly<Record<string, CatalogEntry>> = Object.fromEntries(ConnectorProductIds
  .map((id) => ConnectorProductCatalog[id])
  .filter((product) => product.providerType !== 'google')
  .map((product) => [product.providerType, {
    name: product.name,
    description: MENTION_DESCRIPTIONS[product.providerType] ?? product.description,
  }]));

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
  const bundle = /drive|docs|sheets/u.test(normalizedName)
    ? GOOGLE_FILES
    : /gmail|mail|calendar/u.test(normalizedName)
      ? GOOGLE_MAIL
      : undefined;
  const markName = bundle?.name ?? renderedName;
  return {
    name: renderedName || bundle?.name || 'Google Workspace',
    description: bundle?.description ?? 'Mail, calendar, Drive, Docs, and Sheets through connected Google accounts.',
    mark: connectorBrandMark('google', markName),
    ...(bundle ? { capabilityPrefixes: bundle.capabilityPrefixes } : {}),
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
  };
}

function bestConnectorStatus(statuses: readonly ConnectorScopeStatus[]): ConnectorScopeStatus {
  if (statuses.includes('healthy')) return 'healthy';
  if (statuses.includes('reconnect_required')) return 'reconnect_required';
  if (statuses.includes('disabled')) return 'disabled';
  return 'missing';
}

function connectionMatchesCapabilities(
  connection: WorkstreamConnection,
  capabilityPrefixes: readonly string[] | undefined,
): boolean {
  if (!capabilityPrefixes?.length) return true;
  return connection.capabilities?.some((capability) =>
    capabilityPrefixes.some((prefix) => capability.startsWith(prefix))) ?? false;
}

/**
 * Personal and workspace rows for one connector presentation, always both.
 * Every applicable credential contributes: response order cannot change status
 * and capability unions remain stable across reconnects and account additions.
 */
export function connectorScopeStates(
  connectorType: string,
  connections: readonly WorkstreamConnection[],
  capabilityPrefixes?: readonly string[],
): readonly [ConnectorScopeState, ConnectorScopeState] {
  const matching = connections.filter((connection) =>
    connection.connectorType === connectorType &&
    connectionMatchesCapabilities(connection, capabilityPrefixes));
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
