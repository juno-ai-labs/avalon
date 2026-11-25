import { connectorScopeStates } from '../lib/connector-presentation';
import { useQuery } from '@tanstack/react-query';
import type { ConnectorConnectionCardInput } from '@rally/contracts';
import type { ReactNode } from 'react';
import { useOptionalCollaborationSession, useShellCapabilities } from '../lib/collaboration-session';
import type { OAuthConnectorProviderCatalogEntry } from '../lib/connector-catalog';
import { ConnectorConnectionsProvider, connectorConnectionCardProvider, useConnectorConnectionAction } from './connector-mentions';

export type GoogleConnectProduct = 'google-mail-calendar' | 'google-drive';

/** What a surface needs to offer one Google product: which, whether it can be pressed now, and how. */
export interface GoogleConnectOfferState {
  product: GoogleConnectProduct;
  /** Held: a sign-in is pending (this one or another), or the connector is unavailable here. */
  busy: boolean;
  /** This product's own sign-in is pending. */
  pending: boolean;
  error: string | undefined;
  /** Starts the Google sign-in for another account of this product. */
  start: () => void;
}

/**
 * Which Google product to offer: Gmail until the person has a Gmail
 * connection, then Drive until they have a Drive one, then nothing. Any
 * connection counts: a broken one is the card's to repair, and a disconnected
 * one was the person's decision (`docs/connectors.md`, stored status), which
 * an offer does not argue with. Offered only where this host can connect
 * accounts, to members, once the connections and the region's connector
 * catalog have loaded (so it never flashes in for someone already connected).
 *
 * The rail tile (desktop and browser) and the Expo app's sidebar row both
 * draw from this, through `children`, which is called only while there is an
 * offer.
 */
export function GoogleConnectOffer({ children }: { children: (offer: GoogleConnectOfferState) => ReactNode }): React.JSX.Element | null {
  const collaboration = useOptionalCollaborationSession();
  const { guest } = useShellCapabilities();
  const api = collaboration?.api;
  const enabled = Boolean(api && collaboration?.connectorSetup && !guest);
  // The keys the connection cards and Settings read, so the entries are shared.
  const connections = useQuery({ queryKey: ['connections'], queryFn: ({ signal }) => api!.getConnections(signal), enabled });
  const catalog = useQuery({ queryKey: ['connector-catalog'], queryFn: ({ signal }) => api!.getAvailableConnectorTypes(signal), enabled, staleTime: 30_000 });
  if (!enabled || !connections.data || !catalog.data?.includes('google')) return null;
  const connected = (product: GoogleConnectProduct): boolean => connectorScopeStates('google', connections.data, product)[0].connections.length > 0;
  // An offer whose sign-in is still pending stays until that attempt settles,
  // so a connection landing does not unmount the hook that clears the shared slot.
  const pending = collaboration?.connectorSetup?.pendingConnectorOAuth;
  const pendingProduct = pending?.source === 'conversation' && pending.connectionId === null
    && (pending.connectorId === 'google-mail-calendar' || pending.connectorId === 'google-drive') ? pending.connectorId : null;
  const product: GoogleConnectProduct | null = pendingProduct ?? (!connected('google-mail-calendar') ? 'google-mail-calendar'
    : !connected('google-drive') ? 'google-drive' : null);
  if (!product) return null;
  const request: ConnectorConnectionCardInput = { connectorId: product, scope: 'personal' };
  const provider = connectorConnectionCardProvider(request);
  if (!provider) return null;
  return <ConnectorConnectionsProvider connections={connections.data}>
    <OfferAction key={product} product={product} provider={provider} request={request}>{children}</OfferAction>
  </ConnectorConnectionsProvider>;
}

function OfferAction({ children, product, provider, request }: {
  children: (offer: GoogleConnectOfferState) => ReactNode;
  product: GoogleConnectProduct;
  provider: OAuthConnectorProviderCatalogEntry;
  request: ConnectorConnectionCardInput;
}): React.JSX.Element {
  const action = useConnectorConnectionAction(request, provider);
  // One sign-in is tracked at a time, so any pending one holds the offer, as it does Settings and the cards.
  const otherPending = Boolean(useOptionalCollaborationSession()?.connectorSetup?.pendingConnectorOAuth) && !action.pending;
  return <>{children({
    product,
    busy: action.pending || otherPending || action.unavailable,
    pending: action.pending,
    error: action.error,
    start: () => { void action.startAccount(null).catch(() => undefined); },
  })}</>;
}
