import type { WorkstreamConnection } from '../lib/types';
import { defineSetting } from './registry';

export function digestDeliverySetting(connection: WorkstreamConnection) {
  if (!connection.userDelivery) throw new Error('A digest destination must offer user delivery');
  return defineSetting({
    id: 'digest-delivery:' + connection.id,
    section: 'digest',
    kind: 'toggle',
    label: connection.userDelivery.label + ' · ' + connection.displayName,
    description: connection.userDelivery.description,
  });
}
