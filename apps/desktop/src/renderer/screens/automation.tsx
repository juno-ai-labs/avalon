import { Navigate, useParams } from 'react-router-dom';
import { useSocketOwnedList } from '../components/app-shell';
import { OpeningState } from '../components/primitives';
import type { AutomationSummary } from '../lib/types';
import { AutomationOverviewScreen } from './automation-overview';

/**
 * One route host for durable automations.
 *
 * The standalone builder that used to live behind `/automations/new` is gone.
 * An automation is drafted by asking for one in a work stream, where the agent
 * proposes it as a card in the feed the conversation happened in — so there is
 * no longer a surface here for something that does not exist yet, and the two
 * entries this screen used to choose between have become one.
 *
 * A draft still has a row in the sidebar, and opening it lands on the work
 * stream it was drafted in rather than on a builder.
 */
export function AutomationScreen(): React.JSX.Element {
  const { id } = useParams();
  const automations = useSocketOwnedList<AutomationSummary>(['automations']);

  // Nothing to build here any more; a person who followed an old link or a
  // stale bookmark starts a work stream, which is where drafting happens.
  if (id === undefined || id === 'new') return <Navigate replace to="/workstreams/new" />;
  if (automations.data === undefined) return <OpeningState label="Opening automation…" />;
  return <AutomationOverviewScreen />;
}
