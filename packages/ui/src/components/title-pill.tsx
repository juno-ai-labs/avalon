import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { IconChevronDown, IconChevronRight, IconCornerDownRight, IconSearch, IconX } from '@tabler/icons-react';

import { IconButton } from './primitives';
import clsx from 'clsx';
import { isComposingKeyEvent } from '../lib/ime';
import { createContext, useCallback, useContext, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';

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

/** Every control a level offers, in reading order: items, inputs and buttons alike. */
const TITLE_MENU_CONTROLS = [
  '[role="menuitem"]:not([data-disabled])',
  '[role="menuitemcheckbox"]:not([data-disabled])',
  'input:not([disabled])',
  'button:not([disabled])',
].join(', ');

/**
 * Where focus lands after a move between levels. Entering one, its search when
 * it has one, else its first item; returning to the root, the row that led to
 * the level just left. Selecting that row unmounted it, so without this focus
 * falls to the page and the menu stops answering the keyboard.
 */
function focusAfterMove(view: HTMLElement, left: string | null): void {
  const target = (left && view.querySelector<HTMLElement>(`[data-title-menu-level="${left}"]`))
    || view.querySelector<HTMLElement>('[data-title-menu-autofocus]')
    || view.querySelector<HTMLElement>(TITLE_MENU_CONTROLS);
  target?.focus({ preventScroll: true });
}

/**
 * The menu's frame, sized to whichever level is showing and travelling between
 * those sizes rather than cutting, so moving to People reads as the same popout
 * reshaping itself. The level's own rows enter on a short stagger, keyed by the
 * level so each move replays it.
 *
 * Tab moves through every control in the level, not only its items. The menu
 * takes Tab away from the page, and a level's search, its Add buttons and its
 * Sidekick rows are not items, so this is their only way in by keyboard.
 */
export function TitleMenuMorph({ children }: { children: ReactNode }): React.JSX.Element {
  const { view, direction } = useTitleMenuNav();
  const inner = useRef<HTMLDivElement>(null);
  const shownKey = useRef<string | null | undefined>(undefined);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  useLayoutEffect(() => {
    const element = inner.current;
    if (!element) return undefined;
    const key = view?.key ?? null;
    // Not on the menu's own opening: Radix places focus then.
    if (shownKey.current !== undefined && shownKey.current !== key) {
      focusAfterMove(element, key === null ? shownKey.current : null);
    }
    shownKey.current = key;
    const measure = (): void => setSize({ width: element.offsetWidth, height: element.offsetHeight });
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [view]);
  return <div className="title-menu-morph" style={size ? { height: size.height, width: size.width } : undefined}>
    <div
      className="title-menu-view"
      data-direction={direction}
      key={view?.key ?? 'root'}
      onKeyDown={(event) => {
        if (event.key !== 'Tab') return;
        const controls = [...event.currentTarget.querySelectorAll<HTMLElement>(TITLE_MENU_CONTROLS)];
        if (controls.length === 0) return;
        const at = controls.indexOf(document.activeElement as HTMLElement);
        const step = event.shiftKey ? -1 : 1;
        const next = controls[(at + step + controls.length) % controls.length] ?? controls[0]!;
        event.preventDefault();
        event.stopPropagation();
        next.focus({ preventScroll: true });
      }}
      ref={inner}
    >
      {children}
    </div>
  </div>;
}

/**
 * A level's search box. It keeps the letters typed (the menu's typeahead would
 * take them), lets Tab and Escape through to the menu, takes focus when its
 * level opens, and hands the down arrow to the first result.
 */
export function TitleMenuSearch({ className, label, onChange, onEnter, value }: {
  className?: string | undefined;
  label: string;
  onChange: (value: string) => void;
  /** Enter in the box; the menu stays open so it can be pressed again. */
  onEnter?: (() => void) | undefined;
  value: string;
}): React.JSX.Element {
  return <label className={clsx('title-menu-search', className)}>
    <IconSearch aria-hidden="true" size={15} stroke={1.8} />
    <input
      aria-label={label}
      data-title-menu-autofocus=""
      onChange={(event) => onChange(event.currentTarget.value)}
      onKeyDown={(event) => {
        if (event.key === 'Escape' || event.key === 'Tab') return;
        event.stopPropagation();
        // Enter that finishes an input method's composition is not a submit.
        if (event.key === 'Enter' && onEnter && !isComposingKeyEvent(event.nativeEvent)) {
          event.preventDefault();
          onEnter();
          return;
        }
        if (event.key !== 'ArrowDown') return;
        const view = event.currentTarget.closest('.title-menu-view');
        const first = view?.querySelector<HTMLElement>('[role="menuitem"]:not([data-disabled])');
        if (!first) return;
        event.preventDefault();
        first.focus({ preventScroll: true });
      }}
      placeholder={label}
      value={value}
    />
  </label>;
}

/**
 * Props for an item listed under a level's search: hovering it must not pull
 * focus out of the box mid-word, which is what a menu item does on hover.
 */
export const keepSearchFocus = {
  onPointerMove: (event: React.PointerEvent): void => {
    if (document.activeElement instanceof HTMLInputElement
      && event.currentTarget.closest('.title-menu-view')?.contains(document.activeElement)) event.preventDefault();
  },
};

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
        // A submenu inside a level (Icon and color, Add Sidekick) is portalled
        // but still bubbles here; its own ArrowLeft is not a step back.
        if (event.defaultPrevented || !event.currentTarget.contains(event.target as Node)) return;
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
    // The trigger spans the whole pill, under the icon action, so the menu
    // centres on the pill rather than on the part right of the icon. The body
    // keeps the title clear of the icon and carries the hover wash.
    return <span className={clsx('title-pill is-split has-icon-action', `is-${variant}`)}>
      <span className="title-pill-icon-action">{level.iconAction}</span>
      {menu
        ? <DropdownMenu.Root modal={false} onOpenChange={onOpenChange}>
          <DropdownMenu.Trigger aria-label={view ? `${level.label}, ${view.label}` : level.label} className="title-pill-menu-trigger has-title">
            <span className="title-pill-menu-trigger-body">
              {crumbTitle}
              {!view && level.meta ? <span className="title-pill-meta">{level.meta}</span> : null}
              {crumb}
              {chevron}
            </span>
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
      {ancestors.length === 2 ? <AncestorBridge /> : null}
    </div>
    <div className="title-pill-current window-no-drag"><TitlePill level={current} /></div>
    <div className="title-pill-trailing">{trailing ? <span className="window-no-drag">{trailing}</span> : null}</div>
  </header>;
}

/*
 * Two marks joined by a narrow neck, as two drops of water touch. The
 * stylesheet sizes each collapsed crumb to a BRIDGE_RADIUS circle and spaces
 * them BRIDGE_SPAN apart, so the outline is fixed and computed once.
 */
const BRIDGE_RADIUS = 18;
const BRIDGE_SPAN = 42;
const BRIDGE_NECK = 7;
/** Where the neck leaves each circle, measured from the line between centres. */
const BRIDGE_ANGLE = Math.PI / 4;

function bridgePath(): string {
  const r = BRIDGE_RADIUS;
  const left = r;
  const right = r + BRIDGE_SPAN;
  const dx = r * Math.cos(BRIDGE_ANGLE);
  const dy = r * Math.sin(BRIDGE_ANGLE);
  // A cubic's midpoint sits at (p0 + 3c0 + 3c1 + p1) / 8; solving for the
  // control length that lands it on the neck's half height.
  const reach = (dy - BRIDGE_NECK) / (0.75 * Math.cos(BRIDGE_ANGLE));
  const rx = reach * Math.sin(BRIDGE_ANGLE);
  const ry = reach * Math.cos(BRIDGE_ANGLE);
  const top = r - dy;
  const bottom = r + dy;
  const n = (value: number): string => value.toFixed(2);
  return [
    `M${n(left + dx)} ${n(top)}`,
    `C${n(left + dx + rx)} ${n(top + ry)} ${n(right - dx - rx)} ${n(top + ry)} ${n(right - dx)} ${n(top)}`,
    `A${r} ${r} 0 1 1 ${n(right - dx)} ${n(bottom)}`,
    `C${n(right - dx - rx)} ${n(bottom - ry)} ${n(left + dx + rx)} ${n(bottom - ry)} ${n(left + dx)} ${n(bottom)}`,
    `A${r} ${r} 0 1 1 ${n(left + dx)} ${n(top)}`,
    'Z',
  ].join(' ');
}

const BRIDGE_PATH = bridgePath();

/**
 * The glass a breakout's two collapsed crumbs sit on. Hidden until the pane is
 * narrow enough that both crumbs show only their marks.
 */
function AncestorBridge(): React.JSX.Element {
  const id = useId();
  const width = BRIDGE_SPAN + 2 * BRIDGE_RADIUS;
  const height = 2 * BRIDGE_RADIUS;
  return <svg
    aria-hidden="true"
    className="title-pill-bridge"
    height={height}
    viewBox={`-1 -1 ${width + 2} ${height + 2}`}
    width={width + 2}
  >
    <defs>
      <linearGradient id={`${id}-sheen`} x1="0" x2="0" y1="0" y2="1">
        <stop className="title-pill-bridge-sheen-from" offset="0" />
        <stop className="title-pill-bridge-sheen-to" offset="0.6" />
      </linearGradient>
      <linearGradient id={`${id}-rim`} x1="0" x2="0" y1="0" y2="1">
        <stop className="title-pill-bridge-rim-from" offset="0" />
        <stop className="title-pill-bridge-rim-to" offset="0.45" />
      </linearGradient>
      <clipPath id={`${id}-inside`}><path d={BRIDGE_PATH} /></clipPath>
    </defs>
    <path className="title-pill-bridge-body" d={BRIDGE_PATH} />
    <path d={BRIDGE_PATH} fill={`url(#${id}-sheen)`} />
    <path clipPath={`url(#${id}-inside)`} d={BRIDGE_PATH} fill="none" stroke={`url(#${id}-rim)`} strokeWidth="3" />
    <path className="title-pill-bridge-edge" d={BRIDGE_PATH} />
  </svg>;
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
