import type { ComponentProps, ReactNode } from 'react';
import clsx from 'clsx';
import { WorkstreamGlyph } from './workstream-glyph';
import { TitleSkeleton } from './primitives';
import type { WorkstreamAppearance } from '@rally/contracts';
export function NavigationFrame({ className, ...props }: ComponentProps<'aside'>): React.JSX.Element {
  return <aside aria-label="Rally navigation" className={clsx('sidebar', className)} {...props} />;
}

/** Shared visual content for a Space or Channel navigation row. */
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

/**
 * A Channel's row in the single sidebar: the glyph, the title with its last
 * activity time beside it, the Space it lives in underneath, and one activity
 * dot at the row's leading edge. The host decides each value; an empty
 * `subtitle` leaves a one-line row rather than an empty second line.
 */
export function ChannelRowContent({ id, title, appearance, naming, marks, titlePrefix, time, subtitle, subtitleTrailing, marker }: {
  id: string; title: string; appearance?: WorkstreamAppearance; naming?: boolean;
  marks?: ReactNode; titlePrefix?: ReactNode;
  time?: ReactNode; subtitle?: ReactNode; marker?: ReactNode;
  /** A small mark on the second line, under the time, such as a scheduled run. */
  subtitleTrailing?: ReactNode;
}): React.JSX.Element {
  return <>
    {marker ? <span className="channel-row-marker">{marker}</span> : null}
    <span className="sidebar-row-icon">
      <WorkstreamGlyph appearance={appearance} id={id} size={40} />{marks}
    </span>
    <span className="sidebar-row-main channel-row-main">
      <span className="channel-row-heading">
        <span className="sidebar-row-title"><span className="sidebar-row-title-copy">
          {titlePrefix}{naming ? <TitleSkeleton /> : title}
        </span></span>
        {time ? <span className="channel-row-time">{time}</span> : null}
      </span>
      {subtitle || subtitleTrailing ? <span className="channel-row-second">
        <span className="sidebar-row-activity channel-row-subtitle">{subtitle}</span>
        {subtitleTrailing ? <span className="channel-row-second-trailing">{subtitleTrailing}</span> : null}
      </span> : null}
    </span>
  </>;
}

export function NavigationRowContent({ id, title, appearance, naming, marks, titlePrefix, activity }: {
  id: string; title: string; appearance?: WorkstreamAppearance; naming?: boolean;
  marks?: ReactNode; titlePrefix?: ReactNode; activity?: ReactNode;
}): React.JSX.Element {
  return <SidebarNavigationRowContent
    activity={activity}
    icon={<WorkstreamGlyph appearance={appearance} id={id} size={36} />}
    marks={marks}
    naming={naming}
    title={title}
    titlePrefix={titlePrefix}
  />;
}
