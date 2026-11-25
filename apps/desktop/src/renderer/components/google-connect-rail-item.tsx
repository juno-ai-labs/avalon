import { connectorScopeStates } from '../lib/connector-presentation';
import { useQuery } from '@tanstack/react-query';
import { IconPlus } from '@tabler/icons-react';
import type { ConnectorConnectionCardInput } from '@rally/contracts';
import { useOptionalCollaborationSession, useShellCapabilities } from '../lib/collaboration-session';
import type { OAuthConnectorProviderCatalogEntry } from '../lib/connector-catalog';
import type { PluginBrandMark } from '../lib/plugin-marks';
import { ConnectorConnectionsProvider, connectorConnectionCardProvider, useConnectorConnectionAction } from './connector-mentions';
import { ConnectorMark } from './primitives';
import { RailItem } from './rail-item';
import { RollingSlot, useRollingCycle } from './rolling-cycle';

type GoogleProduct = 'google-mail-calendar' | 'google-drive';

/** What each tile rolls through, mark and name together, and what it says it does. */
const TILES: Record<GoogleProduct, { marks: readonly { mark: PluginBrandMark; name: string }[]; action: string; tooltip: string }> = {
  'google-mail-calendar': {
    marks: [{ mark: 'gmail', name: 'Gmail' }, { mark: 'google-calendar', name: 'Calendar' }],
    action: 'Connect Gmail',
    tooltip: 'Connect Gmail and Calendar',
  },
  'google-drive': {
    marks: [{ mark: 'google-drive', name: 'Drive' }, { mark: 'google-sheets', name: 'Sheets' }, { mark: 'google-docs', name: 'Docs' }],
    action: 'Connect Google Drive',
    tooltip: 'Connect Drive, Docs and Sheets',
  },
};

/**
 * The rail's Google quick action: Gmail until the person has a Gmail
 * connection, then Drive until they have a Drive one, then nothing. A
 * connection counts whatever its health; a broken one is the card's to repair.
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
  const connected = (product: GoogleProduct): boolean => connectorScopeStates('google', connections.data, product)[0]
    .connections.some((connection) => connection.status !== 'disabled');
  const product: GoogleProduct | null = !connected('google-mail-calendar') ? 'google-mail-calendar'
    : !connected('google-drive') ? 'google-drive' : null;
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
  const cycle = useRollingCycle(tile.marks.length);
  return <RailItem
    aria-busy={action.pending || undefined}
    aria-label={tile.action}
    badge={<span aria-hidden="true" className="navigation-rail-connect-plus"><IconPlus size={9} stroke={3} /></span>}
    className="navigation-rail-google"
    disabled={action.pending || action.unavailable}
    icon={<RollingSlot className="navigation-rail-google-mark" cycle={cycle} items={tile.marks.map(({ mark }) => <ConnectorMark key={mark} mark={mark} />)} />}
    label={<RollingSlot cycle={cycle} items={tile.marks.map(({ name }) => name)} />}
    onClick={() => { void action.startAccount(null).catch(() => undefined); }}
    title={tile.tooltip}
  />;
}
