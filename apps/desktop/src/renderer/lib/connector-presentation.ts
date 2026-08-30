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
}

const CATALOG: Readonly<Record<string, { readonly name: string; readonly description: string; readonly mark: PluginBrandMark | null }>> = {
  google: {
    name: 'Google Mail + Calendar',
    description: 'Search Gmail, create drafts, send mail, and work with calendar events.',
    mark: 'google',
  },
  google_drive: {
    name: 'Google Drive + Docs + Sheets',
    description: 'Read Drive files and work with Google Docs and Sheets content.',
    mark: 'google-drive',
  },
  github: {
    name: 'GitHub',
    description: 'Repositories, issues, pull requests, checks, and development events.',
    mark: 'github',
  },
  granola: {
    name: 'Granola',
    description: 'Personal meeting context through Granola MCP, or workspace notes and transcripts through an admin API key.',
    mark: 'granola',
  },
  linear: {
    name: 'Linear',
    description: 'Connect personally to act as you, or install Rally for shared workspace access and real-time activity.',
    mark: 'linear',
  },
  slack: {
    name: 'Slack',
    description: 'Messages, files, people, canvases, conversations, and the Rally workspace Agent.',
    mark: 'slack',
  },
  notion: {
    name: 'Notion',
    description: 'Your Notion through its live MCP tools, or selected pages and change notifications shared with your Rally workspace.',
    mark: 'notion',
  },
  x: {
    name: 'Public X via TwitterAPI.io',
    description: 'Read-only public X timelines, threads, replies, and Lists using a Rally-managed third-party API key.',
    mark: 'x',
  },
  generic_webhook: {
    name: 'Inbound webhook',
    description: 'Receive signed activity from systems that do not have a native Rally connector.',
    mark: null,
  },
};

export type ConnectorScopeStatus = 'healthy' | 'reconnect_required' | 'disabled' | 'missing';

export interface ConnectorScopeState {
  readonly scope: 'you' | 'workspace';
  readonly status: ConnectorScopeStatus;
  readonly connection?: WorkstreamConnection;
}

export function connectorPresentation(
  connectorType: string,
  displayName?: string,
): ConnectorPresentation {
  const entry = CATALOG[connectorType];
  return {
    name: displayName?.replace(/^@/u, '') || entry?.name || connectorType,
    description: entry?.description ?? 'Workspace connector.',
    mark: entry?.mark ?? connectorBrandMark(connectorType, displayName),
  };
}

/** Personal and workspace rows for one connector type, always both. */
export function connectorScopeStates(
  connectorType: string,
  connections: readonly WorkstreamConnection[],
): readonly [ConnectorScopeState, ConnectorScopeState] {
  const matching = connections.filter((connection) => connection.connectorType === connectorType);
  const personal = matching.find((connection) => connection.scope === 'you');
  const workspace = matching.find((connection) => connection.scope === 'workspace');
  return [
    {
      scope: 'you',
      status: personal?.status ?? 'missing',
      ...(personal ? { connection: personal } : {}),
    },
    {
      scope: 'workspace',
      status: workspace?.status ?? 'missing',
      ...(workspace ? { connection: workspace } : {}),
    },
  ];
}

/**
 * One status for an inline chip: healthy if either scope is healthy, otherwise
 * the worse of the two that exist, otherwise missing.
 */
export function connectorAggregateStatus(
  states: readonly ConnectorScopeState[],
): ConnectorScopeStatus {
  if (states.some((state) => state.status === 'healthy')) return 'healthy';
  if (states.some((state) => state.status === 'reconnect_required')) return 'reconnect_required';
  if (states.some((state) => state.status === 'disabled')) return 'disabled';
  return 'missing';
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

/**
 * Connector type from an embed href (`connector://google`) or a tokened mention
 * (`connector://tok:google`). Embeds do not carry a render token.
 */
export function connectorTypeFromHref(href: string | undefined): string | undefined {
  if (href === undefined) return undefined;
  const tokened = href.match(/^connector:(?:\/\/)?[0-9a-z]+:(.+)$/iu);
  if (tokened) {
    try {
      return decodeURIComponent(tokened[1] ?? '');
    } catch {
      return undefined;
    }
  }
  const bare = href.match(/^connector:(?:\/\/)?([A-Za-z0-9_-]+)$/iu);
  return bare?.[1]?.toLowerCase();
}
