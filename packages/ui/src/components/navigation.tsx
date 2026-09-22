import type { ComponentProps, ReactNode } from 'react';
import clsx from 'clsx';
import { WorkstreamGlyph } from './workstream-glyph';
import { TitleSkeleton } from './primitives';
import type { WorkstreamAppearance } from '@rally/contracts';
export function NavigationFrame({ className, ...props }: ComponentProps<'aside'>): React.JSX.Element {
  return <aside aria-label="Rally navigation" className={clsx('sidebar', className)} {...props} />;
}

/** Shared visual content for a Space or Channel navigation row. */
export function SidebarNavigationRowContent({ icon, title, description, marks, titlePrefix, activity, naming }: {
  icon: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  marks?: ReactNode;
  titlePrefix?: ReactNode;
  activity?: ReactNode;
  naming?: boolean;
}): React.JSX.Element {
  return <>
    <span className="sidebar-row-icon">{icon}{marks}</span>
    <span className="sidebar-row-main">
      <span className="sidebar-row-title"><span className="sidebar-row-title-copy">
        {titlePrefix}{naming ? <TitleSkeleton /> : title}
      </span></span>
      {description === undefined ? activity : <span className="sidebar-row-hint">{description}</span>}
    </span>
  </>;
}

export function NavigationRowContent({ id, title, appearance, naming, marks, titlePrefix, activity, description }: {
  id: string; title: string; appearance?: WorkstreamAppearance; naming?: boolean;
  marks?: ReactNode; titlePrefix?: ReactNode; activity?: ReactNode; description?: ReactNode;
}): React.JSX.Element {
  return <SidebarNavigationRowContent
    activity={activity}
    description={description}
    icon={<WorkstreamGlyph appearance={appearance} id={id} size={36} />}
    marks={marks}
    naming={naming}
    title={title}
    titlePrefix={titlePrefix}
  />;
}
