import type { ComponentProps, ReactNode } from 'react';
import clsx from 'clsx';
import { WorkstreamGlyph } from './workstream-glyph';
import { TitleSkeleton } from './primitives';
import type { WorkstreamAppearance } from '@rally/contracts';
export function NavigationFrame({ className, ...props }: ComponentProps<'aside'>): React.JSX.Element {
  return <aside aria-label="Rally navigation" className={clsx('sidebar', className)} {...props} />;
}
export function NavigationRowContent({ id, title, appearance, naming, marks, titlePrefix, activity }: {
  id: string; title: string; appearance?: WorkstreamAppearance; naming?: boolean;
  marks?: ReactNode; titlePrefix?: ReactNode; activity?: ReactNode;
}): React.JSX.Element {
  return <><span className="sidebar-row-icon"><WorkstreamGlyph appearance={appearance} id={id} size={36} />{marks}</span>
    <span className="sidebar-row-main"><span className="sidebar-row-title"><span className="sidebar-row-title-copy">
      {titlePrefix}{naming ? <TitleSkeleton /> : title}</span></span>{activity}</span></>;
}
