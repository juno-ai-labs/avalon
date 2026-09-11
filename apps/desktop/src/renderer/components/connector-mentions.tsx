import { useMutation } from '@tanstack/react-query';
import {
  ConnectorConnectionCardCatalog,
  connectorConnectionCardInputFromToolEvent,
  type ConnectorConnectionCardInput,
} from '@rally/contracts';
import { Check, AlertTriangle, LoaderCircle, Minus } from 'lucide-react';
import { createContext, useContext, useEffect, useState } from 'react';
import { useAppSession } from '../lib/app-session';
import {
  connectorProviderById,
  isOAuthConnectorProvider,
  type OAuthConnectorProviderCatalogEntry,
} from '../lib/connector-catalog';
import {
  connectorAggregateStatus,
  connectorPresentation,
  connectorScopeLabel,
  connectorScopeStates,
  connectorStatusLabel,
  type ConnectorScopeStatus,
} from '../lib/connector-presentation';
import type { PluginBrandMark } from '../lib/plugin-marks';
import type { WorkstreamConnection } from '../lib/types';
import { desktopBridge } from '../lib/platform';
import { Button, ConnectorMark, InlineError } from './primitives';

const ConnectorConnectionsContext = createContext<readonly WorkstreamConnection[] | undefined>([]);

export function ConnectorConnectionsProvider({
  children,
  connections,
}: {
  children: React.ReactNode;
  connections: readonly WorkstreamConnection[] | undefined;
}): React.JSX.Element {
  return (
    <ConnectorConnectionsContext.Provider value={connections}>
      {children}
    </ConnectorConnectionsContext.Provider>
  );
}

export function useConnectorConnections(): readonly WorkstreamConnection[] | undefined {
  return useContext(ConnectorConnectionsContext);
}

/** Same mark chip as Settings → Connections provider cards (`.provider-icon`). */
export function ConnectorProviderIcon({
  className,
  mark,
}: {
  className?: string;
  mark: PluginBrandMark;
}): React.JSX.Element {
  return (
    <span aria-hidden="true" className={className ? `provider-icon ${className}` : 'provider-icon'}>
      <ConnectorMark mark={mark} />
    </span>
  );
}

/** A validated connector-card request carried by a durable core tool row. */
export function connectorConnectionCardInput(message: {
  toolEvent?: { name: string; input?: unknown; output?: unknown; summary?: string; status?: string };
}): ConnectorConnectionCardInput | null {
  return connectorConnectionCardInputFromToolEvent(message.toolEvent);
}

/**
 * Main-feed connector authorization card, shaped from Grok Bot's bundled
 * connector-card primitive while keeping Rally's own tokens and trusted
 * connector catalog.
 */
export function ConnectorConnectionCard({ request }: {
  request: ConnectorConnectionCardInput;
}): React.JSX.Element | null {
  const provider = connectorProviderById(request.connectorId);
  if (!provider || !isOAuthConnectorProvider(provider)) return null;
  const scope = request.scope === 'personal' ? 'you' : 'workspace';
  if (!(provider.scopes as readonly string[]).includes(scope)) return null;
  return <ResolvedConnectorConnectionCard provider={provider} request={request} />;
}

function ResolvedConnectorConnectionCard({ provider, request }: {
  provider: OAuthConnectorProviderCatalogEntry;
  request: ConnectorConnectionCardInput;
}): React.JSX.Element | null {
  const { api, pendingConnectorOAuth, session, setPendingConnectorOAuth } = useAppSession();
  const connections = useConnectorConnections();

  const scope = request.scope === 'personal' ? 'you' : 'workspace';
  const catalog = ConnectorConnectionCardCatalog[request.connectorId];
  const scopeState = connections === undefined
    ? undefined
    : connectorScopeStates(provider.provider, connections, catalog.capabilityPrefixes)
        .find((candidate) => candidate.scope === scope);
  const reconnect = scopeState?.connections.find((connection) => connection.status === 'reconnect_required');
  const selectionKey = `${request.connectorId}:${request.scope}`;
  const liveConnected = scopeState?.status === 'healthy';
  const [connectedSelection, setConnectedSelection] = useState<string | null>(null);
  const connected = liveConnected || connectedSelection === selectionKey;
  // The workspace socket's `connector_connections` topic refreshes the shared
  // query feeding this context after OAuth commits. Keep believing that live
  // state until it first reports success; a later provider revocation is both
  // unlikely while this historical card remains visible and better handled by
  // a fresh agent state check than by turning an old success back into a CTA.
  useEffect(() => {
    if (liveConnected) setConnectedSelection(selectionKey);
  }, [liveConnected, selectionKey]);
  const awaiting = pendingConnectorOAuth?.provider === provider.provider;
  const capabilities = scope === 'you' && 'personalCapabilities' in provider
    ? [...provider.personalCapabilities]
    : [...provider.capabilities];
  const connect = useMutation({
    mutationFn: async () => {
      if (!api || !session?.workspace) throw new Error('Rally is not ready to connect this account.');
      if (reconnect) {
        const authorization = await api.reconnectConnection(
          reconnect.id,
          provider.provider === 'granola' ? undefined : provider.provider,
          scope,
          reconnect.capabilities?.length ?? capabilities.length,
        );
        const attempt = await api.getConnectorOAuthAttempt(authorization.attemptId);
        await desktopBridge().openExternal(authorization.url);
        return { authorization, provider: attempt.provider };
      }
      const authorization = await api.startProviderConnection(provider.provider, scope, capabilities);
      await desktopBridge().openExternal(authorization.url);
      return { authorization, provider: provider.provider };
    },
    onSuccess: ({ authorization, provider: oauthProvider }) => {
      if (!session?.workspace) return;
      setPendingConnectorOAuth({
        attemptId: authorization.attemptId,
        provider: oauthProvider,
        region: session.workspace.region,
        workspaceId: session.workspace.id,
      });
    },
  });
  const pending = connect.isPending || awaiting;
  return (
    <ConnectorConnectionCardView
      connected={connected}
      error={connect.error?.message}
      onConnect={() => connect.mutate()}
      pending={pending}
      provider={provider}
      request={request}
      reconnect={Boolean(reconnect)}
      unavailable={!api || connections === undefined}
    />
  );
}

/** The card's pure visual primitive; connection authority stays in the wrapper. */
export function ConnectorConnectionCardView({
  connected,
  error,
  onConnect,
  pending,
  provider,
  reconnect,
  request,
  unavailable = false,
}: {
  connected: boolean;
  error?: string;
  onConnect: () => void;
  pending: boolean;
  provider: OAuthConnectorProviderCatalogEntry;
  reconnect: boolean;
  request: ConnectorConnectionCardInput;
  unavailable?: boolean;
}): React.JSX.Element {
  const actionLabel = reconnect ? 'Reconnect' : `Connect ${provider.name}`;

  return (
    <article className="connector-connection-card" data-connector-id={request.connectorId}>
      <div className="connector-connection-card-header">
        {'mark' in provider ? <ConnectorProviderIcon mark={provider.mark} /> : null}
        <div className="connector-connection-card-body">
          <strong>{provider.name}</strong>
          <p>{provider.description}</p>
          <small>{request.scope === 'personal' ? 'Personal connection' : 'Workspace connection'}</small>
        </div>
        {connected ? (
          <span className="connector-connection-card-status"><Check aria-hidden="true" size={14} /> Connected</span>
        ) : (
          <Button
            className="connector-connection-card-action button-primary"
            disabled={unavailable || pending}
            onClick={onConnect}
          >
            {pending ? <LoaderCircle aria-hidden="true" className="spin" size={14} /> : null}
            {pending ? 'Waiting…' : actionLabel}
          </Button>
        )}
      </div>
      {error ? <InlineError>{error}</InlineError> : null}
    </article>
  );
}

function StatusGlyph({ status }: { status: ConnectorScopeStatus }): React.JSX.Element {
  if (status === 'healthy') return <Check aria-hidden="true" size={12} strokeWidth={2.5} />;
  if (status === 'reconnect_required') return <AlertTriangle aria-hidden="true" size={12} strokeWidth={2.5} />;
  return <Minus aria-hidden="true" size={12} strokeWidth={2.5} />;
}

/**
 * Inline connector mention: brand mark, name, and one aggregate connection status.
 */
export function ConnectorMentionChip({
  connectorType,
  label,
}: {
  connectorType: string;
  label: string;
}): React.JSX.Element {
  const connections = useConnectorConnections();
  const presentation = connectorPresentation(connectorType, label);
  const status = connections === undefined
    ? undefined
    : connectorAggregateStatus(connectorScopeStates(
        connectorType,
        connections,
        presentation.capabilityPrefixes,
      ));
  const displayLabel = label.replace(/^@/u, '');
  return (
    <span
      className="mention-chip mention-chip-connector"
      {...(status ? { 'data-connector-status': status } : {})}
      data-connector-type={connectorType}
    >
      {presentation.mark ? (
        <ConnectorProviderIcon className="mention-chip-connector-icon" mark={presentation.mark} />
      ) : null}
      <span className="mention-chip-label">{displayLabel}</span>
      {status ? (
        <span className={`mention-chip-status mention-chip-status-${status}`}>
          <StatusGlyph status={status} />
          <span>{connectorStatusLabel(status)}</span>
        </span>
      ) : null}
    </span>
  );
}

/**
 * Block connector announcement — horizontal card taking colour/radius cues from
 * `.citation-card`, content shaped like the settings provider row: mark, name,
 * description, and personal + workspace connection state.
 */
export function ConnectorEmbedCard({
  connectorType,
  label,
}: {
  connectorType: string;
  label?: string;
}): React.JSX.Element {
  const connections = useConnectorConnections();
  const presentation = connectorPresentation(connectorType, label);
  const scopes = connections === undefined
    ? undefined
    : connectorScopeStates(connectorType, connections, presentation.capabilityPrefixes);
  const title = label?.replace(/^@/u, '') || presentation.name;
  const capabilityCount = (scopes ?? [])
    .flatMap((scope) => scope.capabilities)
    .filter((value, index, all) => all.indexOf(value) === index)
    .length;

  return (
    <article
      className="citation-connector-card"
      data-connector-type={connectorType}
    >
      {presentation.mark ? <ConnectorProviderIcon mark={presentation.mark} /> : null}
      <div className="citation-connector-card-body">
        <strong className="citation-connector-card-title">{title}</strong>
        <p className="citation-connector-card-description">{presentation.description}</p>
        {scopes ? (
          <p className="citation-connector-card-meta">
            {capabilityCount > 0
              ? `${capabilityCount} ${capabilityCount === 1 ? 'capability' : 'capabilities'}`
              : 'No capabilities on a connected account yet'}
          </p>
        ) : null}
      </div>
      {scopes ? (
        <ul className="citation-connector-card-scopes">
          {scopes.map((scope) => (
            <li
              className={`citation-connector-status citation-connector-status-${scope.status}`}
              key={scope.scope}
            >
              <StatusGlyph status={scope.status} />
              <span>
                {connectorScopeLabel(scope.scope)}
                {' · '}
                {connectorStatusLabel(scope.status)}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </article>
  );
}
