import type { ReactNode } from 'react';
import { TitleSkeleton } from './primitives';
/** Shared visual content for a sidebar row: an icon, a title, and an optional line under it. */
export function SidebarNavigationRowContent({ icon, title, marks, titlePrefix, activity, naming }: {
  icon: ReactNode;
  title: ReactNode;
  marks?: ReactNode;
  titlePrefix?: ReactNode;
  activity?: ReactNode;
  naming?: boolean;
}): React.JSX.Element {
  const activityIsEmpty = activity === undefined || activity === null
    || typeof activity === 'boolean' || activity === '';
  return <>
    <span className="sidebar-row-icon">{icon}{marks}</span>
    <span className="sidebar-row-main">
      <span className="sidebar-row-title"><span className="sidebar-row-title-copy">
        {titlePrefix}{naming ? <TitleSkeleton /> : title}
      </span></span>
      {activityIsEmpty ? null : <span className="sidebar-row-activity">{activity}</span>}
    </span>
  </>;
}
