import {
  AtSign,
  CalendarDays,
  FileText,
  GitBranch,
  HardDrive,
  MessageSquare,
  Webhook,
  Workflow,
  type LucideIcon,
} from 'lucide-react';
import {
  CONNECTOR_OFFERINGS,
  connectionMatchesOffering as connectionMatchesOfferingIdentity,
  connectorOffering,
  connectorOfferingCapabilities,
  type ConnectorOffering,
  type ConnectorOfferingIcon,
  type ConnectorOfferingId,
} from '@avalon/contracts';
import type { ConnectorOAuthProvider } from '@avalon/contracts';
import type { Scope, WorkstreamConnection } from './types';

export type { ConnectorOffering, ConnectorOfferingId };
export { CONNECTOR_OFFERINGS, connectorOffering };

const iconByKey: Record<ConnectorOfferingIcon, LucideIcon> = {
  'at-sign': AtSign,
  calendar: CalendarDays,
  'file-text': FileText,
  'git-branch': GitBranch,
  'hard-drive': HardDrive,
  'message-square': MessageSquare,
  webhook: Webhook,
  workflow: Workflow,
};

export function connectorOfferingIcon(offering: ConnectorOffering): LucideIcon {
  return iconByKey[offering.icon];
}

/**
 * Linear's native-agent grant, appended here rather than declared in the shared
 * registry.
 *
 * It is gated by a build flag the desktop client owns, and asking for it is a
 * decision about what this build may do — a registry that always listed it
 * would widen every workspace's Linear authorization the moment some other
 * surface imported it. Kept in one function so the Settings pane and a
 * connector card in a transcript ask for exactly the same scopes; two copies of
 * this rule would differ silently, and the difference is only visible much
 * later as a tool that is not authorized.
 */
const linearNativeAgentEnabled = import.meta.env.VITE_LINEAR_NATIVE_AGENT_ENABLED === 'true';

export function offeringCapabilities(offering: ConnectorOffering, scope: Scope): string[] {
  const declared = connectorOfferingCapabilities(offering, scope === 'you' ? 'personal' : 'workspace');
  return offering.id === 'linear' && scope === 'workspace' && linearNativeAgentEnabled
    ? [...declared, 'linear.agent']
    : [...declared];
}

/** The offering's scopes in the renderer's vocabulary, in the order to offer them. */
export function offeringScopes(offering: ConnectorOffering): Scope[] {
  return offering.scopes.map((scope) => (scope === 'personal' ? 'you' : 'workspace'));
}

export function offeringSupportsOAuth(offering: ConnectorOffering, scope: Scope): boolean {
  return offering.oauthScopes.includes(scope === 'you' ? 'personal' : 'workspace');
}

/**
 * The OAuth provider to start for this offering, or `undefined` when connecting
 * it is not an authorization redirect at all — an inbound webhook mints a
 * signing secret, a workspace Granola connection needs an admin API key, and X
 * is created outright. Those are handed to Settings rather than half-started.
 */
export function offeringOAuthProvider(offering: ConnectorOffering): ConnectorOAuthProvider | undefined {
  return offering.oauthScopes.length > 0
    ? offering.connectorType as ConnectorOAuthProvider
    : undefined;
}

/**
 * What a connector card says about an offering right now.
 *
 * `connected` and `needs_attention` are about a credential that exists;
 * `disconnected` covers both never-connected and disabled, because a disabled
 * connection offers the reader the same next step as no connection at all.
 */
export type ConnectorCardState = 'connected' | 'needs_attention' | 'disconnected' | 'unknown';

/**
 * Whether a connection is one of this offering's, in the renderer's vocabulary.
 *
 * The rule itself is `connectionMatchesOffering` in `@avalon/contracts`, shared
 * with the API so a card and the agent cannot disagree about what is connected.
 * This adapts the two things that are local: the client says `you` where the
 * wire says `personal`, and a connection carries its granted capabilities under
 * a different field name.
 *
 * Note it compares against the registry's declared capabilities, not
 * `offeringCapabilities` — the Linear native-agent grant this build may *ask*
 * for is a decision about this build, while recognizing a connection somebody
 * already has must not depend on a flag that was off when they made it.
 */
export function connectionMatchesOffering(
  connection: WorkstreamConnection,
  offering: ConnectorOffering,
  scope?: Scope,
): boolean {
  return connectionMatchesOfferingIdentity(
    {
      connectorType: connection.connectorType,
      scope: connection.scope === 'you' ? 'personal' : 'workspace',
      grantedCapabilities: connection.capabilities ?? [],
    },
    offering,
    scope === undefined ? undefined : scope === 'you' ? 'personal' : 'workspace',
  );
}

export interface ConnectorCardStatus {
  state: ConnectorCardState;
  /** The matched connection, when there is one to reconnect or name. */
  connection?: WorkstreamConnection;
}

/**
 * Resolve a card's state from the connections that exist at this moment.
 *
 * Never read from the message the card came from: that row is durable and its
 * offer may be a year old, so a state stored beside it would be a confident
 * lie. This is the only place the state is decided.
 */
export function connectorCardStatus(
  offering: ConnectorOffering,
  scope: Scope | undefined,
  connections: WorkstreamConnection[] | undefined,
): ConnectorCardStatus {
  if (connections === undefined) return { state: 'unknown' };
  const matches = connections.filter((connection) => connectionMatchesOffering(connection, offering, scope));
  const healthy = matches.find((connection) => connection.status === 'healthy');
  if (healthy) return { state: 'connected', connection: healthy };
  const reconnect = matches.find((connection) => connection.status === 'reconnect_required');
  if (reconnect) return { state: 'needs_attention', connection: reconnect };
  return { state: 'disconnected' };
}
