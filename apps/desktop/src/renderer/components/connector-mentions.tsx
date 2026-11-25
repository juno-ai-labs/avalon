import { startConnectorAuthorization } from '../lib/start-connector-authorization';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  ConnectorProductCatalog,
  ConnectorOAuthProviderSchema,
  connectorProductAllowsSeveralAccounts,
  connectorProductsForConnection,
  connectorConnectionCardInputFromToolEvent,
  connectorResourceAuthorizationRequestFromToolEvent,
  type ConnectorConnectionCardInput,
  type ConnectorResourceAuthorizationRequest,
} from '@rally/contracts';
import { Check, AlertTriangle, LoaderCircle, Minus, Plug, Plus } from 'lucide-react';
import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { useUpdateRally } from './update-rally-action';
import { useOptionalCollaborationSession, type ConnectorSetupCapability } from '../lib/collaboration-session';
import { useOptionalWorkspaceSocket } from '../lib/workspace-socket';
import { useViewerIsWorkspaceAdmin } from '../lib/use-workspace';
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
  const update = useUpdateRally();
  return (
    <article aria-label="Connector update required" className="connector-connection-card">
      <div className="connector-connection-card-header">
        <span aria-hidden="true" className="provider-icon"><Plug size={24} /></span>
        <div className="connector-connection-card-body">
          <strong>Connector not recognized</strong>
          <p>{update.desktop ? 'Update Rally to connect this account.' : 'Reload Rally to connect this account.'}</p>
        </div>
        <Button className="connector-connection-card-action button-primary" disabled={update.disabled} onClick={update.run}>
          {update.label}
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
  const [productId] = connectorProductsForConnection({ connectorType: request.provider, capabilities: [request.capability] });
  const providerMark = productId ? ConnectorProductCatalog[productId].iconName : null;
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
export function ConnectorConnectionCard({ disabled = false, latchedConnected = false, onConnected, onNewlyConnected, request }: {
  /** Holds the action back, as while another card's sign-in is pending: only one attempt is tracked at a time. */
  disabled?: boolean;
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
  // A host that cannot connect accounts (the lite browser) draws nothing and asks the server nothing.
  const collaboration = useOptionalCollaborationSession();
  const provider = connectorConnectionCardProvider(request);
  if (!provider || !collaboration?.connectorSetup) return null;
  return (
    <ResolvedConnectorConnectionCard
      disabled={disabled}
      latchedConnected={latchedConnected}
      onConnected={onConnected}
      onNewlyConnected={onNewlyConnected}
      provider={provider}
      request={request}
    />
  );
}

/**
 * One connection's state and its connect or reconnect action, for whoever
 * draws the control: the connection card below, and a card that makes the
 * connection one step of something else (a Sidekick source request's
 * "Connect Gmail and approve"). The OAuth attempt, the reconnect of an
 * existing account and the choice between two accounts live here once.
 */
export interface ConnectorConnectionAction {
  provider: OAuthConnectorProviderCatalogEntry;
  adminRequired: boolean;
  checkingAvailability: boolean;
  connected: boolean;
  status: ConnectorScopeStatus | undefined;
  accountOptions: readonly WorkstreamConnection[] | undefined;
  selectedAccountId: string;
  selectAccount: (id: string) => void;
  accountRequired: boolean;
  error: string | undefined;
  /** Starts the sign-in; resolves with its attempt id once the browser is opened, rejects if it could not start. */
  start: () => Promise<string>;
  /**
   * The connected accounts, when the product lets a person hold several: the
   * card lists them, each with its own Reconnect, and offers another.
   * Undefined for a product with one account per person.
   */
  accounts: readonly WorkstreamConnection[] | undefined;
  /** Reconnects that account, or signs in a new one when `null`. Resolves and rejects as `start` does. */
  startAccount: (account: string | null) => Promise<string>;
  /** Which account the pending sign-in is for: its id, `null` for a new one, `undefined` when nothing waits or it is not known. */
  pendingAccount: string | null | undefined;
  pending: boolean;
  /** The OAuth attempt this card is waiting on, while it waits: its outcome can be read back by id. */
  attemptId: string | null;
  reconnect: boolean;
  unavailable: boolean;
}

/**
 * The connection action for a card's request. Mount it only where this
 * client can make that connection: the caller resolves the provider
 * (`connectorConnectionCardProvider`) and checks `connectorSetup` first, as
 * `ConnectorConnectionCard` does.
 */
export function useConnectorConnectionAction(
  request: ConnectorConnectionCardInput,
  provider: OAuthConnectorProviderCatalogEntry,
  { latchedConnected = false, onConnected, onNewlyConnected }: {
    latchedConnected?: boolean;
    onConnected?: ((selectionKey: string) => void) | undefined;
    onNewlyConnected?: (() => void) | undefined;
  } = {},
): ConnectorConnectionAction {
  const collaboration = useOptionalCollaborationSession();
  const api = collaboration?.api;
  const session = collaboration?.session ?? null;
  const setup: Partial<ConnectorSetupCapability> = collaboration?.connectorSetup ?? {};
  const pendingConnectorOAuth = setup.pendingConnectorOAuth ?? null;
  const setPendingConnectorOAuth = setup.setPendingConnectorOAuth ?? (() => undefined);
  const openExternal = setup.openExternal ?? (async () => undefined);
  // The collaboration session, not `useAppSession`: this card is shared with the
  // lite browser, which mounts no `AppSessionProvider`. What matters for the
  // gate below is that the role comes from the *served* workspace rather than
  // the one stamped on the session — see `use-workspace.ts`.
  const viewerIsAdmin = useViewerIsWorkspaceAdmin(collaboration);
  const connections = useConnectorConnections();

  const scope = request.scope === 'personal' ? 'you' : 'workspace';
  const scopeState = connections === undefined
    ? undefined
    : connectorScopeStates(provider.provider, connections, request.connectorId)
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
  const severalAccounts = connectorProductAllowsSeveralAccounts(request.connectorId);
  // No target is the single-account card's one button: reconnect the account
  // it has (or the one chosen), else connect. `account` names a row to
  // reconnect, and `null` signs in another account beside those connected.
  const connect = useMutation({
    mutationFn: async (target?: { account: string | null }) => {
      if (!api || !session?.workspace) throw new Error('Rally is not ready to connect this account.');
      if (!target && accountRequired) throw new Error('Choose an account to reconnect.');
      const chosen = !target ? reconnect
        : target.account === null ? undefined
          : matchingConnections.find((connection) => connection.id === target.account);
      if (target?.account && !chosen) throw new Error('That account is no longer connected. Refresh and try again.');
      if (chosen) {
        const authorization = await api.reconnectConnection(
          chosen.id,
          provider.provider === 'granola' ? undefined : provider.provider,
          scope,
          chosen.capabilities?.length ?? capabilities.length,
        );
        const attempt = await api.getConnectorOAuthAttempt(authorization.attemptId);
        await openExternal(authorization.url);
        return { authorization, provider: attempt.provider, account: chosen.id };
      }
      const authorization = await startConnectorAuthorization(api, provider.provider, scope, capabilities);
      return { authorization, provider: provider.provider, account: null };
    },
    onSuccess: ({ authorization, provider: oauthProvider, account }) => {
      if (!session?.workspace) return;
      setPendingConnectorOAuth({
        attemptId: authorization.attemptId,
        connectionId: account,
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
  const pendingAccount = connect.isPending
    ? connect.variables ? connect.variables.account : reconnect?.id ?? null
    : awaiting ? pendingConnectorOAuth?.connectionId : undefined;
  // Read from the workspace query rather than the desktop session: a role can
  // change while somebody is signed in now, and the session's copy only moves
  // when its access token rotates. Somebody promoted so that they could connect
  // a workspace account was still told they could not, for the rest of the
  // token window — in the one flow this gate exists for. See `use-workspace.ts`.
  const adminRequired = request.scope === 'workspace' && !viewerIsAdmin;
  const providerAvailable = availability.data?.includes(provider.provider) ?? false;
  return {
    provider,
    adminRequired,
    checkingAvailability: availability.isLoading,
    connected,
    status: reconnect?.status ?? scopeState?.status,
    accountOptions: matchingConnections.length > 1 ? matchingConnections : undefined,
    selectedAccountId: reconnect?.id ?? '',
    selectAccount: setSelectedConnectionId,
    accountRequired,
    error: connect.error?.message,
    start: async () => (await connect.mutateAsync()).authorization.attemptId,
    accounts: severalAccounts ? matchingConnections : undefined,
    startAccount: async (account) => (await connect.mutateAsync({ account })).authorization.attemptId,
    pendingAccount,
    pending,
    attemptId: awaiting && pendingConnectorOAuth ? pendingConnectorOAuth.attemptId : null,
    reconnect: matchingConnections.length > 0,
    unavailable: !api || connections === undefined || availability.isError || !providerAvailable,
  };
}

function ResolvedConnectorConnectionCard({ disabled, latchedConnected, onConnected, onNewlyConnected, provider, request }: {
  disabled: boolean;
  latchedConnected: boolean;
  onConnected?: ((selectionKey: string) => void) | undefined;
  onNewlyConnected?: (() => void) | undefined;
  provider: OAuthConnectorProviderCatalogEntry;
  request: ConnectorConnectionCardInput;
}): React.JSX.Element {
  const action = useConnectorConnectionAction(request, provider, { latchedConnected, onConnected, onNewlyConnected });
  return (
    <ConnectorConnectionCardView
      adminRequired={action.adminRequired}
      checkingAvailability={action.checkingAvailability}
      connected={action.connected}
      disabled={disabled}
      status={action.status}
      accountOptions={action.accountOptions}
      selectedAccountId={action.selectedAccountId}
      onSelectAccount={action.selectAccount}
      accountRequired={action.accountRequired}
      accounts={action.accounts}
      onConnectAccount={(account) => { void action.startAccount(account).catch(() => undefined); }}
      pendingAccount={action.pendingAccount}
      error={action.error}
      onConnect={() => { void action.start().catch(() => undefined); }}
      pending={action.pending}
      provider={action.provider}
      request={request}
      reconnect={action.reconnect}
      unavailable={action.unavailable}
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
  accounts,
  onConnectAccount,
  pendingAccount,
  checkingAvailability,
  connected,
  disabled = false,
  error,
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
  /** Connected accounts of a product a person may hold several of; with any, the card lists them. */
  accounts?: readonly Pick<WorkstreamConnection, 'id' | 'displayName' | 'status'>[];
  onConnectAccount?: (account: string | null) => void;
  /** Which row waits on a sign-in: an account id, or `null` for the new one. */
  pendingAccount?: string | null | undefined;
  checkingAvailability?: boolean;
  connected: boolean;
  disabled?: boolean;
  status?: ConnectorScopeStatus;
  error?: string;
  onConnect: () => void;
  pending: boolean;
  provider: OAuthConnectorProviderCatalogEntry;
  reconnect: boolean;
  request: ConnectorConnectionCardInput;
  unavailable?: boolean;
}): React.JSX.Element {
  // The card already names the provider, so the button says only what it does;
  // its accessible name keeps the provider so two cards' buttons stay distinct.
  const actionLabel = reconnect || connected ? 'Reconnect' : 'Connect';
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

  const adminTitle = adminRequired ? 'Only an organization owner or admin can connect an organization account.' : undefined;
  if (accounts && accounts.length > 0) {
    const blocked = disabled || adminRequired || unavailable || pending;
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
            <small>{request.scope === 'personal' ? 'Personal connection' : 'Organization connection'}</small>
          </div>
        </div>
        <ul className="connector-connection-card-accounts" aria-label={`${provider.name} accounts`}>
          {accounts.map((account) => {
            const label = connectionAccountLabel(account.displayName);
            const waiting = pending && pendingAccount === account.id;
            return (
              <li key={account.id} className="connector-connection-card-account-row">
                <span className="connector-connection-card-account-name">{label}</span>
                <span className="connector-connection-card-account-controls">
                <span className="connector-connection-card-status" data-status={account.status} role="status">
                  <StatusGlyph status={account.status} />
                  {account.status === 'reconnect_required' ? 'Reconnect required' : connectorStatusLabel(account.status)}
                </span>
                <Button
                  className="connector-connection-card-account-action"
                  disabled={blocked}
                  onClick={() => onConnectAccount?.(account.id)}
                  aria-label={waiting ? undefined : `Reconnect ${label}`}
                  title={adminTitle}
                >
                  {waiting ? <LoaderCircle aria-hidden="true" className="spin" size={14} /> : null}
                  {waiting ? 'Waiting…' : 'Reconnect'}
                </Button>
                </span>
              </li>
            );
          })}
        </ul>
        <Button
          className="connector-connection-card-add"
          disabled={blocked}
          onClick={() => onConnectAccount?.(null)}
          aria-label={pending && pendingAccount === null ? undefined : `Add another ${provider.name} account`}
          title={adminTitle}
        >
          {pending && pendingAccount === null ? <LoaderCircle aria-hidden="true" className="spin" size={14} /> : <Plus aria-hidden="true" size={14} />}
          {pending && pendingAccount === null ? 'Waiting…' : 'Add another account'}
        </Button>
        {error ? <ErrorNotice>{error}</ErrorNotice> : null}
      </article>
    );
  }

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
          <Button
            className="connector-connection-card-action button-primary"
            disabled={disabled || adminRequired || accountRequired || unavailable || pending}
            onClick={onConnect}
            aria-label={buttonLabel === 'Connect' ? `Connect ${provider.name}` : undefined}
            title={adminTitle}
          >
            {pending ? <LoaderCircle aria-hidden="true" className="spin" size={14} /> : null}
            {buttonLabel}
          </Button>
        </div>
      </div>
      {error ? <ErrorNotice>{error}</ErrorNotice> : null}
    </article>
  );
}

/**
 * The account half of a connection's name (`Google Mail + Calendar · a@b.com`),
 * or the whole name when it has none. The format is the server's
 * (`connectorConnectionName`, used by `googleConnectionDisplayName`); a
 * connection carries no separate account field.
 */
function connectionAccountLabel(displayName: string): string {
  const separator = displayName.indexOf(' · ');
  return separator === -1 ? displayName : displayName.slice(separator + 3);
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
        presentation.productId,
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
    : connectorScopeStates(connectorType, connections, presentation.productId);
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
