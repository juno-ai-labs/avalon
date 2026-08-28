import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { OpeningState } from '../components/primitives';
import type { AutomationSummary, Workspace } from '../lib/types';
import { AutomationOverviewScreen } from './automation-overview';
import { NewAutomationScreen } from './new-automation';

/**
 * One stable route host for both the unpersisted builder and durable
 * automations. The workspace socket owns the list used for lifecycle dispatch;
 * changing `new` to a durable draft ID therefore does not remount the wizard.
 */
export function AutomationScreen({ workspace }: { workspace: Workspace }): React.JSX.Element {
  const { id = 'new' } = useParams();
  const automations = useQuery<AutomationSummary[]>({
    queryKey: ['automations'],
    queryFn: () => {
      throw new Error('automations are pushed by the workspace socket, never fetched');
    },
    enabled: false,
    staleTime: Number.POSITIVE_INFINITY,
  });

  if (id === 'new') return <NewAutomationScreen workspace={workspace} />;
  const automation = automations.data?.find((item) => item.id === id);
  if (automation?.status === 'draft') return <NewAutomationScreen workspace={workspace} />;
  if (automations.data === undefined) return <OpeningState label="Opening automation…" />;
  return <AutomationOverviewScreen />;
}
