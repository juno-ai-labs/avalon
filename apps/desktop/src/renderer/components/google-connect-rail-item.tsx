import { connectorScopeStates } from '../lib/connector-presentation';
import { useQuery } from '@tanstack/react-query';
import { IconPlus } from '@tabler/icons-react';
import type { ConnectorConnectionCardInput } from '@rally/contracts';
import { useOptionalCollaborationSession, useShellCapabilities } from '../lib/collaboration-session';
import type { OAuthConnectorProviderCatalogEntry } from '../lib/connector-catalog';
import type { PluginBrandMark } from '../lib/plugin-marks';
import { ConnectorConnectionsProvider, connectorConnectionCardProvider, useConnectorConnectionAction } from './connector-mentions';
import { ConnectorMark, ErrorNotice, Tip } from './primitives';
import { RailItem } from './rail-item';
import { RollingSlot, useRollingCycle } from './rolling-cycle';

type GoogleProduct = 'google-mail-calendar' | 'google-drive';

/** What each tile rolls through, mark and name together, and what it says it does. */
/**
 * The tooltip is also the tile's accessible name, so the name always contains
 * whichever product the visible label has rolled to.
 */
const TILES: Record<GoogleProduct, { marks: readonly { mark: PluginBrandMark; name: string }[]; action: string }> = {
  'google-mail-calendar': {
    marks: [{ mark: 'gmail', name: 'Gmail' }, { mark: 'google-calendar', name: 'Calendar' }],
    action: 'Connect Gmail and Calendar',
  },
  'google-drive': {
    marks: [{ mark: 'google-drive', name: 'Drive' }, { mark: 'google-sheets', name: 'Sheets' }, { mark: 'google-docs', name: 'Docs' }],
    action: 'Connect Drive, Sheets and Docs',
  },
};

/**
 * The rail's Google quick action: Gmail until the person has a Gmail
 * connection, then Drive until they have a Drive one, then nothing. Any
 * connection counts: a broken one is the card's to repair, and a disconnected
 * one was the person's decision (`docs/connectors.md`, stored status), which
 * the rail does not argue with.
 * Drawn only where this host can connect accounts, for members, once the
 * connections and the region's connector catalog have loaded (so it never
 * flashes in for someone already connected).
 */
export function GoogleConnectRailItem(): React.JSX.Element | null {
  const collaboration = useOptionalCollaborationSession();
  const { guest } = useShellCapabilities();
  const api = collaboration?.api;
  const enabled = Boolean(api && collaboration?.connectorSetup && !guest);
  // The keys the connection cards and Settings read, so the entries are shared.
  const connections = useQuery({ queryKey: ['connections'], queryFn: ({ signal }) => api!.getConnections(signal), enabled });
  const catalog = useQuery({ queryKey: ['connector-catalog'], queryFn: ({ signal }) => api!.getAvailableConnectorTypes(signal), enabled, staleTime: 30_000 });
  if (!enabled || !connections.data || !catalog.data?.includes('google')) return null;
  const connected = (product: GoogleProduct): boolean => connectorScopeStates('google', connections.data, product)[0].connections.length > 0;
  // A tile whose sign-in is still pending stays until that attempt settles, so
  // a connection landing does not unmount the hook that clears the shared slot.
  const pending = collaboration?.connectorSetup?.pendingConnectorOAuth;
  const pendingProduct = pending?.source === 'conversation' && pending.connectionId === null
    && (pending.connectorId === 'google-mail-calendar' || pending.connectorId === 'google-drive') ? pending.connectorId : null;
  const product: GoogleProduct | null = pendingProduct ?? (!connected('google-mail-calendar') ? 'google-mail-calendar'
    : !connected('google-drive') ? 'google-drive' : null);
  if (!product) return null;
  const request: ConnectorConnectionCardInput = { connectorId: product, scope: 'personal' };
  const provider = connectorConnectionCardProvider(request);
  if (!provider) return null;
  return <ConnectorConnectionsProvider connections={connections.data}>
    <GoogleConnectTile key={product} product={product} provider={provider} request={request} />
  </ConnectorConnectionsProvider>;
}

function GoogleConnectTile({ product, provider, request }: {
  product: GoogleProduct;
  provider: OAuthConnectorProviderCatalogEntry;
  request: ConnectorConnectionCardInput;
}): React.JSX.Element {
  const tile = TILES[product];
  const action = useConnectorConnectionAction(request, provider);
  // One sign-in is tracked at a time, so any pending one holds the tile, as it does Settings and the cards.
  const otherPending = Boolean(useOptionalCollaborationSession()?.connectorSetup?.pendingConnectorOAuth) && !action.pending;
  const shown = tile.marks[useRollingCycle(tile.marks.length)]!;
  return <>{action.error && <ErrorNotice title="Google could not be connected">{action.error}</ErrorNotice>}
    <Tip describesTrigger={false} label={tile.action} side="right">
      <RailItem
        aria-busy={action.pending || undefined}
        aria-label={tile.action}
        badge={<span aria-hidden="true" className="navigation-rail-connect-plus"><IconPlus size={9} stroke={3} /></span>}
        className="navigation-rail-google"
        disabled={action.pending || otherPending || action.unavailable}
        icon={<RollingSlot className="navigation-rail-google-mark" valueKey={shown.mark}><ConnectorMark mark={shown.mark} /></RollingSlot>}
        label={<RollingSlot valueKey={shown.mark}>{shown.name}</RollingSlot>}
        onClick={() => { void action.startAccount(null).catch(() => undefined); }}
      />
    </Tip>
  </>;
}
