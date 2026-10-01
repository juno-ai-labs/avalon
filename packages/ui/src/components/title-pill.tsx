import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { IconChevronDown, IconX } from '@tabler/icons-react';

import { IconButton } from './primitives';
import clsx from 'clsx';
import type { ReactNode } from 'react';

/**
 * One level of a conversation's title: a Channel, or a Breakout inside it.
 *
 * `menu` is the popover the pill opens. `onSelect`, when given, makes the
 * pill's title a link back to that level and moves the menu to its chevron,
 * which is what an ancestor pill wants: its title returns to it and its
 * chevron still offers its menu.
 */
export interface TitlePillLevel {
  key: string;
  icon: ReactNode;
  title: ReactNode;
  /** The accessible name of the menu trigger, e.g. `Channel menu: Launch`. */
  label: string;
  meta?: ReactNode;
  menu?: ReactNode;
  onSelect?: () => void;
  /**
   * A control that replaces the icon, such as the appearance picker. It sits
   * beside the menu trigger rather than inside it, since a button cannot hold
   * another.
   */
  iconAction?: ReactNode;
}

export function TitlePill({ level, variant = 'current' }: {
  level: TitlePillLevel;
  variant?: 'current' | 'ancestor';
}): React.JSX.Element {
  const body = <>
    <span className="title-pill-icon">{level.icon}</span>
    <span className="title-pill-title">{level.title}</span>
    {level.meta ? <span className="title-pill-meta">{level.meta}</span> : null}
  </>;
  const chevron = <IconChevronDown aria-hidden="true" className="title-pill-chevron" size={13} stroke={2} />;
  const menu = level.menu ? <DropdownMenu.Portal>
    <DropdownMenu.Content align={variant === 'ancestor' ? 'start' : 'center'} className="menu-content title-pill-menu" collisionPadding={12} sideOffset={8}>
      {level.menu}
    </DropdownMenu.Content>
  </DropdownMenu.Portal> : null;

  if (level.iconAction && !level.onSelect) {
    return <span className={clsx('title-pill is-split', `is-${variant}`)}>
      <span className="title-pill-icon-action">{level.iconAction}</span>
      {menu
        ? <DropdownMenu.Root modal={false}>
          <DropdownMenu.Trigger aria-label={level.label} className="title-pill-menu-trigger has-title">
            <span className="title-pill-title">{level.title}</span>
            {level.meta ? <span className="title-pill-meta">{level.meta}</span> : null}
            {chevron}
          </DropdownMenu.Trigger>
          {menu}
        </DropdownMenu.Root>
        : <span className="title-pill-title">{level.title}</span>}
    </span>;
  }
  if (level.onSelect) {
    return <span className={clsx('title-pill is-split', `is-${variant}`)}>
      <button className="title-pill-select" onClick={level.onSelect} type="button">{body}</button>
      {menu && <DropdownMenu.Root modal={false}>
        <DropdownMenu.Trigger aria-label={level.label} className="title-pill-menu-trigger">{chevron}</DropdownMenu.Trigger>
        {menu}
      </DropdownMenu.Root>}
    </span>;
  }
  if (!menu) return <span className={clsx('title-pill', `is-${variant}`)}>{body}</span>;
  return <DropdownMenu.Root modal={false}>
    <DropdownMenu.Trigger aria-label={level.label} className={clsx('title-pill', `is-${variant}`)}>
      {body}{chevron}
    </DropdownMenu.Trigger>
    {menu}
  </DropdownMenu.Root>;
}

/**
 * A conversation pane's header: its own pill centered, any ancestors stacked
 * at the left in nesting order, and the pane's trailing controls at the right.
 * The centre column stays centred however many ancestors there are.
 */
export function TitlePillHeader({ ancestors = [], className, current, trailing }: {
  ancestors?: readonly TitlePillLevel[];
  className?: string;
  current: TitlePillLevel;
  trailing?: ReactNode;
}): React.JSX.Element {
  return <header className={clsx('title-pill-header window-drag', className)}>
    <div className="title-pill-ancestors">
      {ancestors.map((level) => <span className="title-pill-ancestor window-no-drag" key={level.key}>
        <TitlePill level={level} variant="ancestor" />
      </span>)}
    </div>
    <div className="title-pill-current window-no-drag"><TitlePill level={current} /></div>
    <div className="title-pill-trailing">{trailing ? <span className="window-no-drag">{trailing}</span> : null}</div>
  </header>;
}

/** The identity row at the top of a title menu: what this is and where it lives. */
export function TitleMenuHeader({ action, eyebrow, icon, title }: {
  action?: ReactNode; eyebrow: ReactNode; icon: ReactNode; title: ReactNode;
}): React.JSX.Element {
  return <div className="title-menu-header">
    <span className="title-menu-header-icon">{icon}</span>
    <span className="title-menu-header-copy">
      <span className="title-menu-eyebrow">{eyebrow}</span>
      <span className="title-menu-title">{title}</span>
    </span>
    {action}
  </div>;
}

/** A plain-text action at the right of a title menu row, e.g. Open space. */
export function TitleMenuLink({ children, onSelect }: { children: ReactNode; onSelect: () => void }): React.JSX.Element {
  return <DropdownMenu.Item className="title-menu-link" onSelect={onSelect}>{children}</DropdownMenu.Item>;
}

export function TitleMenuItem({ children, danger = false, disabled, icon, onSelect }: {
  children: ReactNode; danger?: boolean; disabled?: boolean; icon: ReactNode; onSelect: () => void;
}): React.JSX.Element {
  return <DropdownMenu.Item className={clsx('menu-item title-menu-item', danger && 'menu-item-danger')} disabled={disabled} onSelect={onSelect}>
    {icon}{children}
  </DropdownMenu.Item>;
}

export function TitleMenuSeparator(): React.JSX.Element {
  return <DropdownMenu.Separator className="menu-separator" />;
}

/** The round control that closes a pane, at the right of its header. */
export function TitlePillClose({ label, onClose }: { label: string; onClose: () => void }): React.JSX.Element {
  return <IconButton className="title-pill-close" label={label} onClick={onClose}>
    <IconX aria-hidden="true" size={16} stroke={1.9} />
  </IconButton>;
}
