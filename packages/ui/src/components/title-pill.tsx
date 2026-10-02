import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { IconChevronDown, IconChevronRight, IconCornerDownRight, IconX } from '@tabler/icons-react';

import { IconButton } from './primitives';
import clsx from 'clsx';
import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';

/**
 * One level inside a title pill's menu, e.g. People. The pill names it as a
 * breadcrumb after the conversation's own title, and the menu draws it in
 * place of its root.
 */
export interface TitleMenuView { key: string; label: string }

interface TitleMenuNav {
  view: TitleMenuView | null;
  /** Which way the last move went, so a view enters from the side it came from. */
  direction: 'in' | 'out';
  open: (view: TitleMenuView) => void;
  back: () => void;
}

const TitleMenuNavContext = createContext<TitleMenuNav>({
  view: null,
  direction: 'in',
  open: () => undefined,
  back: () => undefined,
});

/** The menu's current level, and the way to move between levels. */
export function useTitleMenuNav(): TitleMenuNav {
  return useContext(TitleMenuNavContext);
}

/**
 * The menu's frame, sized to whichever level is showing and travelling between
 * those sizes rather than cutting, so moving to People reads as the same popout
 * reshaping itself. The level's own rows enter on a short stagger, keyed by the
 * level so each move replays it.
 */
export function TitleMenuMorph({ children }: { children: ReactNode }): React.JSX.Element {
  const { view, direction } = useTitleMenuNav();
  const inner = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  useLayoutEffect(() => {
    const element = inner.current;
    if (!element) return undefined;
    const measure = (): void => setSize({ width: element.offsetWidth, height: element.offsetHeight });
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [view]);
  return <div className="title-menu-morph" style={size ? { height: size.height, width: size.width } : undefined}>
    <div className="title-menu-view" data-direction={direction} key={view?.key ?? 'root'} ref={inner}>
      {children}
    </div>
  </div>;
}

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
  /**
   * Which way the chevron points. Down by default; right for a Channel whose
   * Breakout is open beside it, pointing at where the conversation went.
   */
  chevron?: 'down' | 'right';
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
  const [view, setView] = useState<TitleMenuView | null>(null);
  const [direction, setDirection] = useState<'in' | 'out'>('in');
  const back = useCallback(() => { setDirection('out'); setView(null); }, []);
  const nav = useMemo<TitleMenuNav>(() => ({
    view,
    direction,
    open: (next) => { setDirection('in'); setView(next); },
    back,
  }), [back, direction, view]);
  // A menu reopens at its root, wherever it was left.
  const onOpenChange = (open: boolean): void => { if (!open) { setDirection('in'); setView(null); } };
  const Chevron = level.chevron === 'right' ? IconChevronRight : IconChevronDown;
  const chevron = <Chevron aria-hidden="true" className="title-pill-chevron" size={13} stroke={2} />;
  /**
   * The title, and the level open below it. While a level is open the title is
   * the breadcrumb's first step and takes the menu back to its root: on
   * pointer-down, before the trigger would read the press as closing.
   */
  const crumbTitle = view
    ? <span
      className="title-pill-title is-crumb-root"
      onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); back(); }}
    >{level.title}</span>
    : <span className="title-pill-title">{level.title}</span>;
  const crumb = view ? <>
    <IconChevronRight aria-hidden="true" className="title-pill-crumb-separator" size={13} stroke={2} />
    <span className="title-pill-title title-pill-crumb" key={view.key}>{view.label}</span>
  </> : null;
  const menu = level.menu ? <DropdownMenu.Portal>
    <DropdownMenu.Content
      align={variant === 'ancestor' ? 'start' : 'center'}
      className="menu-content title-pill-menu"
      collisionPadding={12}
      // Escape and the left arrow step back a level before they close anything.
      onEscapeKeyDown={(event) => { if (view) { event.preventDefault(); back(); } }}
      onKeyDown={(event) => {
        if (!view || event.key !== 'ArrowLeft') return;
        if (event.target instanceof HTMLInputElement) return;
        event.preventDefault();
        back();
      }}
      sideOffset={8}
    >
      <TitleMenuNavContext.Provider value={nav}>
        <TitleMenuMorph>{level.menu}</TitleMenuMorph>
      </TitleMenuNavContext.Provider>
    </DropdownMenu.Content>
  </DropdownMenu.Portal> : null;

  if (level.iconAction && !level.onSelect) {
    return <span className={clsx('title-pill is-split', `is-${variant}`)}>
      <span className="title-pill-icon-action">{level.iconAction}</span>
      {menu
        ? <DropdownMenu.Root modal={false} onOpenChange={onOpenChange}>
          <DropdownMenu.Trigger aria-label={view ? `${level.label}, ${view.label}` : level.label} className="title-pill-menu-trigger has-title">
            {crumbTitle}
            {!view && level.meta ? <span className="title-pill-meta">{level.meta}</span> : null}
            {crumb}
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
      {menu && <DropdownMenu.Root modal={false} onOpenChange={onOpenChange}>
        <DropdownMenu.Trigger aria-label={level.label} className="title-pill-menu-trigger">{crumb}{chevron}</DropdownMenu.Trigger>
        {menu}
      </DropdownMenu.Root>}
    </span>;
  }
  if (!menu) return <span className={clsx('title-pill', `is-${variant}`)}>{body}</span>;
  return <DropdownMenu.Root modal={false} onOpenChange={onOpenChange}>
    <DropdownMenu.Trigger aria-label={view ? `${level.label}, ${view.label}` : level.label} className={clsx('title-pill', `is-${variant}`)}>
      <span className="title-pill-icon">{level.icon}</span>
      {crumbTitle}
      {!view && level.meta ? <span className="title-pill-meta">{level.meta}</span> : null}
      {crumb}
      {chevron}
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

/** A Breakout's mark in its title pill: the arrow its chips and rows wear. */
export function BreakoutPillIcon(): React.JSX.Element {
  return <IconCornerDownRight aria-hidden="true" className="title-pill-breakout-icon" size={15} stroke={1.9} />;
}
