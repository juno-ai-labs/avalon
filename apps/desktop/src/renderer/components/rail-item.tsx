import clsx from 'clsx';
import type { ComponentProps, ReactNode } from 'react';

/**
 * One tile of the navigation rail: a 34px box holding a 22px shape, its label
 * under it. Every rail entry is one of these, the account menu's trigger
 * included, so they share size, hover and the active tint. Extra props reach
 * the button, so a Radix trigger can wrap it with `asChild`; its open state
 * takes the active tint.
 */
export function RailItem({ active = false, badge, className, icon, label, ...props }:
  ComponentProps<'button'> & { active?: boolean; badge?: ReactNode; icon: ReactNode; label: string }): React.JSX.Element {
  return <button className={clsx('navigation-rail-button window-no-drag', active && 'is-active', className)} type="button" {...props}>
    <span className="navigation-rail-icon">
      {icon}
      {badge}
    </span>
    <span className="navigation-rail-label">{label}</span>
  </button>;
}
