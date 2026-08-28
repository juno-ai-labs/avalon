import { useParams } from 'react-router-dom';
import { useSocketOwnedList } from '../components/app-shell';
import { OpeningState } from '../components/primitives';
import type { AutomationSummary, Workspace } from '../lib/types';
import { AutomationOverviewScreen } from './automation-overview';
import { NewAutomationScreen } from './new-automation';

/**
 * One stable route host for both the unpersisted builder and durable
 * automations. The workspace socket owns the list used for lifecycle
 * dispatch; changing `new` to a durable draft ID therefore does not
 * remount the wizard.
 *
 * The list is read through the shell's own helper rather than a second
 * copy of it: two declarations of the same unfetchable query drift, and
 * the reasoning for why it cannot be fetched is written down once.
 */
export function AutomationScreen({ workspace }: { workspace: Workspace }): React.JSX.Element {
  const { id = 'new' } = useParams();
  const automations = useSocketOwnedList<AutomationSummary>(['automations']);

  if (id === 'new') return <NewAutomationScreen workspace={workspace} />;
  const automation = automations.data?.find((item) => item.id === id);
  if (automation?.status === 'draft') return <NewAutomationScreen workspace={workspace} />;
  if (automations.data === undefined) return <OpeningState label="Opening automation…" />;
  return <AutomationOverviewScreen />;
}
