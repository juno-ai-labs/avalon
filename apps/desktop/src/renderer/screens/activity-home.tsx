import { ShapeOutline } from '@rally/ui/components/identity-tile';
import { TitlePillLeading, TitlePillNavigation } from '@rally/ui/components/title-pill';

import { useActivityList } from '../components/activity-sidebar-section';
import { PushedListPending } from '../components/pushed-list-pending';
import { useDocumentTitle } from '../lib/document-title';

export function ActivityHomeScreen(): React.JSX.Element {
  const activity = useActivityList();
  useDocumentTitle('Activity');
  const empty = activity?.items.length === 0;

  return <div className="pane-state">
    <header className="pane-state-header window-drag">
      <TitlePillLeading />
      <TitlePillNavigation />
    </header>
    <div className="pane-state-body activity-home-body">
      {activity === undefined ? <PushedListPending label="Loading Activity…" noun="Activity" /> :
        <section className="activity-home-message">
          <span className="activity-home-mark"><ShapeOutline shape="triangle" size={30} strokeWidth={1.5} /></span>
          <h1>{empty ? 'No activity yet' : 'Select an activity item'}</h1>
          <p>{empty
            ? 'Mentions, replies, Canvas updates and Sidekick run notifications will appear in Activity.'
            : 'Open an item in Activity to see its details.'}</p>
        </section>}
    </div>
  </div>;
}
