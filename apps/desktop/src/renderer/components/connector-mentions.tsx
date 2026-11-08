import { startConnectorAuthorization } from '../lib/start-connector-authorization';
import { MAC_APP_CONNECT_NOTE, MAC_APP_DOWNLOADABLE, MAC_APP_DOWNLOAD_URL, connectorStartsHere } from '../lib/browser-connectors';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  ConnectorConnectionCardCatalog,
  ConnectorOAuthProviderSchema,
  connectorConnectionCardInputFromToolEvent,
  connectorResourceAuthorizationRequestFromToolEvent,
  type ConnectorConnectionCardInput,
  type ConnectorResourceAuthorizationRequest,
} from '@rally/contracts';
import { Check, AlertTriangle, LoaderCircle, Minus, Plug } from 'lucide-react';
import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { desktopBridge, desktopServicesAvailable } from '../lib/platform';
import { useUpdateStatus } from '../lib/use-downloaded-update';
import { useOptionalCollaborationSession, type CollaborationSessionValue, type ConnectorSetupCapability } from '../lib/collaboration-session';
import { useOptionalWorkspaceSocket } from '../lib/workspace-socket';
import { useViewerIsWorkspaceAdmin } from '../lib/use-workspace';
import {
  CANVA_CONNECTION_DISCLOSURE,
  connectorProviderById,
  connectorProviders,
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
import { Button, ConnectorMark, ErrorNotice } from './primitives';

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

export function ConnectorConnectionUpdateCard(): React.JSX.Element | null {
  const collaboration = useOptionalCollaborationSession();
  if (!collaboration?.connectorSetup) return null;
  return <ResolvedConnectorConnectionUpdateCard />;
}

function ResolvedConnectorConnectionUpdateCard(): React.JSX.Element {
  const desktop = desktopServicesAvailable();
  const status = useUpdateStatus(desktop);
  const busy = status?.kind === 'checking' || status?.kind === 'downloading';
  const update = useMutation({
    mutationFn: async () => {
      if (!desktop) {
        globalThis.location.reload();
        return;
      }
      const bridge = desktopBridge();
      const current = await bridge.getUpdateStatus();
      if (current.kind === 'downloaded') {
        await bridge.installDownloadedUpdate();
      } else if (current.kind === 'idle') {
        await bridge.checkForUpdates();
      }
    },
  });
  return (
    <article aria-label="Connector update required" className="connector-connection-card">
      <div className="connector-connection-card-header">
        <span aria-hidden="true" className="provider-icon"><Plug size={24} /></span>
        <div className="connector-connection-card-body">
          <strong>Connector not recognized</strong>
          <p>{desktop ? 'Update Rally to connect this account.' : 'Reload Rally to connect this account.'}</p>
        </div>
        <Button className="connector-connection-card-action button-primary" disabled={update.isPending || busy} onClick={() => update.mutate()}>
          {status?.kind === 'checking' ? 'Checking…'
            : status?.kind === 'downloading' ? 'Downloading…'
              : status?.kind === 'downloaded' ? 'Restart to update'
                : desktop ? 'Update Rally' : 'Reload Rally'}
        </Button>
      </div>
      {update.error ? <ErrorNotice occurrence={update.error}>{update.error.message}</ErrorNotice> : null}
    </article>
  );
}

export function connectorResourceAuthorizationRequest(message: {
  toolEvent?: { output?: unknown; status?: string };
}): ConnectorResourceAuthorizationRequest | null {
  return connectorResourceAuthorizationRequestFromToolEvent(message.toolEvent);
}

export function ConnectorResourceAuthorizationCard({ request, latchedAuthorized = false, onAuthorized }: {
  request: ConnectorResourceAuthorizationRequest;
  latchedAuthorized?: boolean;
  onAuthorized?: (failedToolInvocationId: string) => void;
}): React.JSX.Element {
  const collaboration = useOptionalCollaborationSession();
  const setup = collaboration?.connectorSetup;
  const api = collaboration?.api;
  const session = collaboration?.session;
  const viewerIsAdmin = useViewerIsWorkspaceAdmin(collaboration);
  const connections = useConnectorConnections();
  const connection = connections?.find((candidate) => candidate.id === request.connectionId);
  const connectionUnavailable = connections !== undefined && !connection;
  const key = `${request.connectionId}:${request.resource.id}:${request.failedToolInvocationId}`;
  const attempt = setup?.resourceAuthorizationAttempts[key];
  const awaiting = Boolean(attempt);
  const status = attempt?.resourceAuthorizationStatus;
  const workspaceAdminRequired = connection?.scope === 'workspace' && !viewerIsAdmin;
  const personalOwnerRequired = connection?.scope === 'you' && connection.ownerUserId !== session?.user?.id;
  const mutation = useMutation({
    mutationFn: async () => {
      if (!api || !setup || !session?.workspace) throw new Error('Rally is not ready to authorize this resource.');
      const started = await api.startConnectorResourceAuthorization(request);
      setup.setResourceAuthorizationAttempt(key, {
        attemptId: started.attemptId,
        provider: ConnectorOAuthProviderSchema.parse(request.provider),
        region: session.workspace.region,
        workspaceId: session.workspace.id,
        source: 'resource',
        resourceAuthorizationKey: key,
        resourceAuthorizationStatus: started.status,
      });
      if (started.url) {
        try {
          await setup.openExternal(started.url);
        } catch (error) {
          setup.setResourceAuthorizationAttempt(key, {
            attemptId: started.attemptId,
            provider: ConnectorOAuthProviderSchema.parse(request.provider),
            region: session.workspace.region,
            workspaceId: session.workspace.id,
            source: 'resource',
            resourceAuthorizationKey: key,
            resourceAuthorizationStatus: 'failed',
          });
          throw error;
        }
      }
      return started;
    },
  });
  useEffect(() => {
    if (!awaiting || !api || !attempt || status !== 'pending') return;
    let cancelled = false;
    const reconcile = async (): Promise<void> => {
      try {
        const latest = await api.getConnectorOAuthAttempt(attempt.attemptId);
        if (cancelled || latest.status === 'pending') return;
        setup.setResourceAuthorizationAttempt(key, {
          ...attempt,
          resourceAuthorizationStatus: latest.status,
        });
      } catch {
        // Returning focus or the realtime authorization message reconciles it again.
      }
    };
    const onFocus = (): void => { void reconcile(); };
    void reconcile();
    window.addEventListener('focus', onFocus);
    return () => { cancelled = true; window.removeEventListener('focus', onFocus); };
  }, [api, attempt, awaiting, key, setup, status]);
  useEffect(() => {
    if (status === 'succeeded') onAuthorized?.(request.continuationId);
  }, [onAuthorized, request.continuationId, status]);
  const succeeded = latchedAuthorized || status === 'succeeded';
  const pending = mutation.isPending || status === 'pending';
  const providerName = request.provider === 'google'
    ? 'Google'
    : `${request.provider.charAt(0).toUpperCase()}${request.provider.slice(1)}`;
  const providerEntry = connectorProviders.find((entry) =>
    entry.provider === request.provider
    && (entry.capabilities as readonly string[]).includes(request.capability));
  const providerMark = providerEntry && 'mark' in providerEntry ? providerEntry.mark : null;
  const resourceNoun = request.resource.type === 'document'
    ? 'file'
    : request.resource.type.replaceAll('_', ' ');
  return (
    <article className="connector-connection-card connector-resource-authorization-card" aria-label={`${providerName} resource authorization`}>
      <div className="connector-connection-card-header">
        {providerMark ? <ConnectorProviderIcon mark={providerMark} /> : null}
        <div className="connector-connection-card-body">
          <strong>{providerName} needs you to allow Rally to edit this {resourceNoun}.</strong>
          <p>{request.resource.name}</p>
        </div>
        {succeeded ? (
          <span aria-live="polite" className="connector-connection-card-status" role="status"><Check aria-hidden="true" size={14} /> Authorized</span>
        ) : (
          <Button
            className="connector-connection-card-action button-primary"
            disabled={!api || !setup || pending || workspaceAdminRequired || personalOwnerRequired || connectionUnavailable}
            onClick={() => mutation.mutate()}
            title={workspaceAdminRequired ? 'Only an organization owner or admin can authorize an organization resource.'
              : personalOwnerRequired || connectionUnavailable ? 'Only the connection owner can authorize this resource.' : undefined}
          >
            {pending ? <LoaderCircle aria-hidden="true" className="spin" size={14} /> : null}
            {pending ? `Waiting for ${providerName}…` : !setup ? 'Open in desktop'
              : workspaceAdminRequired ? 'Admin required'
              : personalOwnerRequired || connectionUnavailable ? 'Owner required' : 'Allow editing'}
          </Button>
        )}
      </div>
      {!succeeded && status === 'denied' ? <ErrorNotice automatic={false} detailsLabel="Authorization details">Authorization was not granted. Try again when you’re ready.</ErrorNotice> : null}
      {!succeeded && status === 'failed' ? <ErrorNotice automatic={false} detailsLabel="Authorization details">Rally could not confirm the authorization. Try again.</ErrorNotice> : null}
      {!succeeded && !setup ? <p>Open this conversation in Rally desktop to authorize editing.</p> : null}
      {!succeeded && (personalOwnerRequired || connectionUnavailable) ? <p>Only the owner of this connection can authorize editing.</p> : null}
      {!succeeded && mutation.error && status !== 'failed' ? <ErrorNotice occurrence={mutation.error}>Rally could not start authorization. Try again.</ErrorNotice> : null}
    </article>
  );
}

export function connectorConnectionCardSelectionKey(request: ConnectorConnectionCardInput): string {
  return `${request.connectorId}:${request.scope}`;
}

export function connectorConnectionCardProvider(
  request: ConnectorConnectionCardInput,
): OAuthConnectorProviderCatalogEntry | null {
  const provider = connectorProviderById(request.connectorId);
  if (!provider || !isOAuthConnectorProvider(provider)) return null;
  const scope = request.scope === 'personal' ? 'you' : 'workspace';
  return (provider.scopes as readonly string[]).includes(scope) ? provider : null;
}

/**
 * Main-feed connector authorization card, shaped from Grok Bot's bundled
 * connector-card primitive while keeping Rally's own tokens and trusted
 * connector catalog.
 */
export function ConnectorConnectionCard({ latchedConnected = false, onConnected, onNewlyConnected, request }: {
  latchedConnected?: boolean;
  onConnected?: (selectionKey: string) => void;
  /**
   * Called once when the connection this card shows goes from not connected to
   * connected while the card is open, and never for one connected when it
   * opened: a question this card answers must not answer itself for a viewer
   * whose own connection was already there.
   */
  onNewlyConnected?: () => void;
  request: ConnectorConnectionCardInput;
}): React.JSX.Element | null {
  const collaboration = useOptionalCollaborationSession();
  const provider = connectorConnectionCardProvider(request);
  if (!provider || !collaboration?.connectorSetup) return null;
  return (
    <ResolvedConnectorConnectionCard
      latchedConnected={latchedConnected}
      onConnected={onConnected}
      onNewlyConnected={onNewlyConnected}
      provider={provider}
      request={request}
      collaboration={collaboration}
      setup={collaboration.connectorSetup}
    />
  );
}

function ResolvedConnectorConnectionCard({ latchedConnected, onConnected, onNewlyConnected, provider, request, collaboration, setup }: {
  latchedConnected: boolean;
  onConnected?: (selectionKey: string) => void;
  onNewlyConnected?: (() => void) | undefined;
  provider: OAuthConnectorProviderCatalogEntry;
  request: ConnectorConnectionCardInput;
  collaboration: CollaborationSessionValue;
  setup: ConnectorSetupCapability;
}): React.JSX.Element | null {
  const { api, session } = collaboration;
  const { pendingConnectorOAuth, setPendingConnectorOAuth, openExternal } = setup;
  // The collaboration session, not `useAppSession`: this card is shared with the
  // lite browser, which mounts no `AppSessionProvider`. What matters for the
  // gate below is that the role comes from the *served* workspace rather than
  // the one stamped on the session — see `use-workspace.ts`.
  const viewerIsAdmin = useViewerIsWorkspaceAdmin(collaboration);
  const connections = useConnectorConnections();

  const scope = request.scope === 'personal' ? 'you' : 'workspace';
  const catalog = ConnectorConnectionCardCatalog[request.connectorId];
  const scopeState = connections === undefined
    ? undefined
    : connectorScopeStates(provider.provider, connections, catalog.capabilityPrefixes)
        .find((candidate) => candidate.scope === scope);
  const [selectedConnectionId, setSelectedConnectionId] = useState('');
  const workspaceSocket = useOptionalWorkspaceSocket();
  const matchingConnections = scopeState?.connections ?? [];
  const reconnect = matchingConnections.length === 1 ? matchingConnections[0]
    : matchingConnections.find((connection) => connection.id === selectedConnectionId);
  const accountRequired = matchingConnections.length > 1 && !reconnect;
  const availability = useQuery({
    queryKey: ['connector-catalog'],
    queryFn: ({ signal }) => api!.getAvailableConnectorTypes(signal),
    enabled: Boolean(api),
    staleTime: 30_000,
  });
  const selectionKey = connectorConnectionCardSelectionKey(request);
  const liveConnected = scopeState?.status === 'healthy';
  const connected = connections === undefined ? latchedConnected : liveConnected;
  // A cached success can bridge loading/remounts, but current connection state
  // owns the status once available. Reauthorization remains an explicit action.
  useEffect(() => {
    if (liveConnected) onConnected?.(selectionKey);
  }, [liveConnected, onConnected, selectionKey]);
  // Seen not connected (with the list loaded) while this card is open.
  const sawMissing = useRef(false);
  useEffect(() => {
    if (connections === undefined) return;
    if (!liveConnected) {
      sawMissing.current = true;
      return;
    }
    if (!sawMissing.current) return;
    sawMissing.current = false;
    onNewlyConnected?.();
  }, [connections, liveConnected, onNewlyConnected]);
  const awaiting = pendingConnectorOAuth?.source === 'conversation'
    && pendingConnectorOAuth.provider === provider.provider
    && pendingConnectorOAuth.connectorId === request.connectorId
    && pendingConnectorOAuth.scope === request.scope
    && pendingConnectorOAuth.workspaceId === session?.workspace?.id
    && pendingConnectorOAuth.region === session?.workspace?.region;
  useEffect(() => {
    if (!awaiting || !api || !pendingConnectorOAuth) return;
    let cancelled = false;
    const reconcile = async (): Promise<void> => {
      try {
        const attempt = await api.getConnectorOAuthAttempt(pendingConnectorOAuth.attemptId);
        if (!cancelled && attempt.status !== 'pending') setPendingConnectorOAuth(null);
      } catch {
        // The callback or the next focus can still reconcile the same attempt.
      }
    };
    const onFocus = (): void => { void reconcile(); };
    void reconcile();
    window.addEventListener('focus', onFocus);
    return () => {
      cancelled = true;
      window.removeEventListener('focus', onFocus);
    };
  }, [api, awaiting, connections, pendingConnectorOAuth, setPendingConnectorOAuth, workspaceSocket?.state, workspaceSocket?.topicWaterlines.connector_oauth_attempts]);
  const capabilities = scope === 'you' && 'personalCapabilities' in provider
    ? [...provider.personalCapabilities]
    : [...provider.capabilities];
  const connect = useMutation({
    mutationFn: async () => {
      if (!api || !session?.workspace) throw new Error('Rally is not ready to connect this account.');
      if (accountRequired) throw new Error('Choose an account to reconnect.');
      if (reconnect && provider.provider !== 'canva') {
        const authorization = await api.reconnectConnection(
          reconnect.id,
          provider.provider === 'granola' ? undefined : provider.provider,
          scope,
          reconnect.capabilities?.length ?? capabilities.length,
        );
        const attempt = await api.getConnectorOAuthAttempt(authorization.attemptId);
        await openExternal(authorization.url);
        return { authorization, provider: attempt.provider };
      }
      const authorization = await startConnectorAuthorization(api, provider.provider, scope, capabilities);
      return { authorization, provider: provider.provider };
    },
    onSuccess: ({ authorization, provider: oauthProvider }) => {
      if (!session?.workspace) return;
      setPendingConnectorOAuth({
        attemptId: authorization.attemptId,
        connectorId: request.connectorId,
        provider: oauthProvider,
        region: session.workspace.region,
        scope: request.scope,
        source: 'conversation',
        workspaceId: session.workspace.id,
      });
    },
  });
  const pending = connect.isPending || awaiting;
  // Read from the workspace query rather than the desktop session: a role can
  // change while somebody is signed in now, and the session's copy only moves
  // when its access token rotates. Somebody promoted so that they could connect
  // a workspace account was still told they could not, for the rest of the
  // token window — in the one flow this gate exists for. See `use-workspace.ts`.
  const adminRequired = request.scope === 'workspace' && !viewerIsAdmin;
  const providerAvailable = availability.data?.includes(provider.provider) ?? false;
  return (
    <ConnectorConnectionCardView
      adminRequired={adminRequired}
      checkingAvailability={availability.isLoading}
      connected={connected}
      status={reconnect?.status ?? scopeState?.status}
      accountOptions={matchingConnections.length > 1 ? matchingConnections : undefined}
      selectedAccountId={reconnect?.id ?? ''}
      onSelectAccount={setSelectedConnectionId}
      accountRequired={accountRequired}
      error={connect.error?.message}
      macAppOnly={!connectorStartsHere(session, provider.provider)}
      onConnect={() => connect.mutate()}
      pending={pending}
      provider={provider}
      request={request}
      reconnect={matchingConnections.length > 0}
      unavailable={!api || connections === undefined || availability.isError || !providerAvailable}
    />
  );
}

/** The card's pure visual primitive; connection authority stays in the wrapper. */
export function ConnectorConnectionCardView({
  adminRequired,
  accountOptions,
  selectedAccountId,
  onSelectAccount,
  accountRequired,
  checkingAvailability,
  connected,
  error,
  macAppOnly = false,
  onConnect,
  pending,
  provider,
  reconnect,
  request,
  unavailable = false,
  status,
}: {
  adminRequired?: boolean;
  accountOptions?: readonly Pick<WorkstreamConnection, 'id' | 'displayName'>[];
  selectedAccountId?: string;
  onSelectAccount?: (id: string) => void;
  accountRequired?: boolean;
  checkingAvailability?: boolean;
  connected: boolean;
  status?: ConnectorScopeStatus;
  error?: string;
  /** This client cannot start this connection; point at the Mac app instead of a button. */
  macAppOnly?: boolean;
  onConnect: () => void;
  pending: boolean;
  provider: OAuthConnectorProviderCatalogEntry;
  reconnect: boolean;
  request: ConnectorConnectionCardInput;
  unavailable?: boolean;
}): React.JSX.Element {
  const actionLabel = reconnect || connected ? 'Reconnect' : `Connect ${provider.name}`;
  const displayStatus = status ?? (connected ? 'healthy' : undefined);
  const statusLabel = displayStatus === 'reconnect_required' ? 'Reconnect required'
    : displayStatus ? connectorStatusLabel(displayStatus) : checkingAvailability ? 'Checking…' : 'Unavailable';
  const buttonLabel = pending
    ? 'Waiting…'
    : adminRequired
      ? 'Admin required'
      : unavailable
        ? checkingAvailability ? 'Checking…' : 'Unavailable'
        : actionLabel;

  return (
    <article
      aria-label={`${provider.name} ${request.scope} connection`}
      className="connector-connection-card"
      data-connector-id={request.connectorId}
    >
      <div className="connector-connection-card-header">
        {'mark' in provider ? <ConnectorProviderIcon mark={provider.mark} /> : null}
        <div className="connector-connection-card-body">
          <strong>{provider.name}</strong>
          <p>{provider.description}</p>
          {provider.provider === 'canva' && <p>{CANVA_CONNECTION_DISCLOSURE}</p>}
          <small>{request.scope === 'personal' ? 'Personal connection' : 'Organization connection'}</small>
          {accountOptions ? (
            <label className="form-field connector-connection-card-account">
              <span>Account to reconnect</span>
              <select value={selectedAccountId} disabled={pending || adminRequired} onChange={(event) => onSelectAccount?.(event.currentTarget.value)}>
                <option value="">Choose an account</option>
                {accountOptions.map((connection) => <option key={connection.id} value={connection.id}>{connection.displayName}</option>)}
              </select>
            </label>
          ) : null}
        </div>
        <div className="connector-connection-card-controls">
          <span aria-live="polite" className="connector-connection-card-status" data-status={displayStatus ?? 'checking'} role="status">
            {displayStatus ? <StatusGlyph status={displayStatus} /> : checkingAvailability ? <LoaderCircle aria-hidden="true" className="spin" size={14} /> : <Minus aria-hidden="true" size={14} />}
            {statusLabel}
          </span>
          {macAppOnly ? (
            MAC_APP_DOWNLOADABLE
              ? <a className="connector-connection-card-status" href={MAC_APP_DOWNLOAD_URL}>{MAC_APP_CONNECT_NOTE}</a>
              : <span className="connector-connection-card-status">{MAC_APP_CONNECT_NOTE}</span>
          ) : (
            <Button
              className="connector-connection-card-action button-primary"
              disabled={adminRequired || accountRequired || unavailable || pending}
              onClick={onConnect}
              title={adminRequired ? 'Only an organization owner or admin can connect an organization account.' : undefined}
            >
              {pending ? <LoaderCircle aria-hidden="true" className="spin" size={14} /> : null}
              {buttonLabel}
            </Button>
          )}
        </div>
      </div>
      {error ? <ErrorNotice>{error}</ErrorNotice> : null}
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
