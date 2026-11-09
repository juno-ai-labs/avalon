import { useActivityList } from '../components/activity-sidebar-section';
import { PaneState, PaneStateLayout } from '../components/pane-state';
import { PushedListPending } from '../components/pushed-list-pending';
import { useDocumentTitle } from '../lib/document-title';

export function ActivityHomeScreen(): React.JSX.Element {
  const activity = useActivityList();
  useDocumentTitle('Activity');
  if (activity === undefined) {
    return <PaneStateLayout><PushedListPending label="Loading Activity…" noun="Activity" /></PaneStateLayout>;
  }
  return activity.items.length === 0
    ? <PaneState description="Mentions, replies, Canvas updates and Sidekick run notifications will appear here." title="No activity yet" />
    : <PaneState description="Open an item in Activity to see its details." title="Select an activity item" />;
}
