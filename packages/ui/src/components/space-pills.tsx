import { IconPlus } from '@tabler/icons-react';
import clsx from 'clsx';
import type { ComponentPropsWithRef, ReactNode } from 'react';

/**
 * The row of Space pills at the top of the sidebar.
 *
 * The leading slot (New space) stays put while the pills scroll sideways under
 * it, so the one creation control is never scrolled out of reach. Hosts own
 * what a pill does; this owns only the shape.
 */
export function SpacePillStrip({ children, className, leading, ...props }: ComponentPropsWithRef<'div'> & {
  leading?: ReactNode;
}): React.JSX.Element {
  return <div className={clsx('space-pill-strip window-no-drag', className)} {...props}>
    {leading}
    <div aria-label="Spaces" className="space-pill-strip-scroll" role="group">{children}</div>
  </div>;
}

/** One Space filter. Selected reads as filled ink; the others are outlined. */
export function SpacePill({ className, selected, ...props }: ComponentPropsWithRef<'button'> & {
  selected: boolean;
}): React.JSX.Element {
  return <button
    aria-pressed={selected}
    className={clsx('space-pill', selected && 'is-selected', className)}
    type="button"
    {...props}
  />;
}

/** The round New space control that leads the strip. The host supplies its tip. */
export function SpacePillAddButton({ className, label = 'New space', ...props }: ComponentPropsWithRef<'button'> & {
  label?: string;
}): React.JSX.Element {
  return <button aria-label={label} className={clsx('space-pill-add', className)} type="button" {...props}>
    <IconPlus aria-hidden="true" size={15} stroke={1.8} />
  </button>;
}

/**
 * The round icon buttons beside the window controls. A host passes only the
 * actions it has; an empty row still holds the titlebar's height and drag area.
 */
export function SidebarTopActions({ children, className, ...props }: ComponentPropsWithRef<'div'>): React.JSX.Element {
  return <div className={clsx('sidebar-top-bar window-drag', className)} {...props}>
    <div className="sidebar-top-actions window-no-drag">{children}</div>
  </div>;
}
