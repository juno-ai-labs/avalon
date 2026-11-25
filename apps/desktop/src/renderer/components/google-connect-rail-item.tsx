import { IconPlus } from '@tabler/icons-react';
import type { PluginBrandMark } from '../lib/plugin-marks';
import { GoogleConnectOffer, type GoogleConnectOfferState, type GoogleConnectProduct } from './google-connect-offer';
import { ConnectorMark, ErrorNotice, Tip } from './primitives';
import { RailItem } from './rail-item';
import { RollingSlot, useRollingCycle } from './rolling-cycle';

/**
 * The tooltip is also the tile's accessible name, so the name always contains
 * whichever product the visible label has rolled to.
 */
const TILES: Record<GoogleConnectProduct, { marks: readonly { mark: PluginBrandMark; name: string }[]; action: string }> = {
  'google-mail-calendar': {
    marks: [{ mark: 'gmail', name: 'Gmail' }, { mark: 'google-calendar', name: 'Calendar' }],
    action: 'Connect Gmail and Calendar',
  },
  'google-drive': {
    marks: [{ mark: 'google-drive', name: 'Drive' }, { mark: 'google-sheets', name: 'Sheets' }, { mark: 'google-docs', name: 'Docs' }],
    action: 'Connect Drive, Sheets and Docs',
  },
};

/** The rail's Google quick action, drawn from `GoogleConnectOffer`. */
export function GoogleConnectRailItem(): React.JSX.Element | null {
  return <GoogleConnectOffer>{(offer) => <GoogleConnectTile offer={offer} />}</GoogleConnectOffer>;
}

function GoogleConnectTile({ offer }: { offer: GoogleConnectOfferState }): React.JSX.Element {
  const tile = TILES[offer.product];
  const shown = tile.marks[useRollingCycle(tile.marks.length)]!;
  return <>{offer.error && <ErrorNotice title="Google could not be connected">{offer.error}</ErrorNotice>}
    <Tip describesTrigger={false} label={tile.action} side="right">
      <RailItem
        aria-busy={offer.pending || undefined}
        aria-label={tile.action}
        badge={<span aria-hidden="true" className="navigation-rail-connect-plus"><IconPlus size={9} stroke={3} /></span>}
        className="navigation-rail-google"
        disabled={offer.busy}
        icon={<RollingSlot className="navigation-rail-google-mark" valueKey={shown.mark}><ConnectorMark mark={shown.mark} /></RollingSlot>}
        label={<RollingSlot valueKey={shown.mark}>{shown.name}</RollingSlot>}
        onClick={offer.start}
      />
    </Tip>
  </>;
}
