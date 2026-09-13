import type { WorkstreamConnection } from './types';
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

const GOOGLE_MAIL: CatalogEntry & { readonly capabilityPrefixes: readonly string[] } = {
  name: 'Google Mail + Calendar',
  description: 'Search Gmail, create drafts, send mail, and work with calendar events.',
  capabilityPrefixes: ['gmail.', 'calendar.'],
};

const GOOGLE_FILES: CatalogEntry & { readonly capabilityPrefixes: readonly string[] } = {
  name: 'Google Drive + Docs + Sheets',
  description: 'Read Drive files and work with Google Docs and Sheets content.',
  capabilityPrefixes: ['drive.', 'docs.', 'sheets.'],
};

const CATALOG: Readonly<Record<string, CatalogEntry>> = {
  custom_mcp: {
    name: 'Custom MCP server',
    description: 'Tools served live by a Model Context Protocol server you point Rally at.',
  },
  github: {
    name: 'GitHub',
    description: 'Repositories, issues, pull requests, checks, and development events.',
  },
  fireflies: {
    name: 'Fireflies',
    description: "Your own Fireflies meetings through its live tools, or the team's transcripts and summaries through an admin API key.",
  },
  granola: {
    name: 'Granola',
    description: 'Personal meeting context through Granola MCP, or workspace notes and transcripts through an admin API key.',
  },
  linear: {
    name: 'Linear',
    description: 'Connect personally to act as you, or install Rally for shared workspace access and real-time activity.',
  },
  slack: {
    name: 'Slack',
    description: 'Messages, files, people, canvases, conversations, and the Rally workspace Agent.',
  },
  notion: {
    name: 'Notion',
    description: 'Your Notion through its live MCP tools, or selected pages and change notifications shared with your Rally workspace.',
  },
  x: {
    name: 'Public X via TwitterAPI.io',
    description: 'Read-only public X timelines, threads, replies, and Lists using a Rally-managed third-party API key.',
  },
  generic_webhook: {
    name: 'Inbound webhook',
    description: 'Receive signed activity from systems that do not have a native Rally connector.',
  },
};

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
    description: entry?.description ?? 'Workspace connector.',
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
  return scope === 'you' ? 'Personal' : 'Workspace';
}
