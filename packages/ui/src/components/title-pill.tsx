import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { IconChevronDown, IconChevronRight, IconSearch, IconX } from '@tabler/icons-react';

import { Ellipsis, Menu } from 'lucide-react';

import { IconGroup, type IconGroupAction, type TooltipSide } from './icon-group';
import type { IdentityMark } from './identity-tile';
import { MarkBridge, type MarkBridgeItem } from './mark-bridge';
import { IconButton } from './primitives';
import clsx from 'clsx';
import { isComposingKeyEvent } from '../lib/ime';
import { usePhoneLayout } from '../lib/phone-layout';
import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';

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
 * The menu always opens below its pill, which sits at the top of its pane, so
 * above is never better. The bottom edge never counts as a collision, so Radix
 * never flips it up; the sides still shift it to fit a phone's width. Without
 * this, a phone with its keyboard up shrinks the visual viewport, the menu
 * flips above the pill, and nothing moves it back once the keyboard drops.
 */
const TITLE_MENU_COLLISION_PADDING = { top: 12, right: 12, bottom: -Infinity, left: 12 };

/** Takes focus out of the input, textarea or editable region that holds it, if any. */
function blurTextEntry(): void {
  const active = document.activeElement;
  if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement
    || (active instanceof HTMLElement && active.isContentEditable)) active.blur();
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
  menu?: ReactNode;
  onSelect?: () => void;
  /**
   * A control that replaces the icon, such as the appearance picker. It sits
   * beside the menu trigger rather than inside it, since a button cannot hold
   * another.
   */
  iconAction?: ReactNode;
  /**
   * The level as a mark, its name, and what selecting it does, for when its
   * crumb collapses onto a `MarkBridge`; selecting the mark is `onSelect`.
   * Ancestors fuse into a bridge only when every one of them has this.
   */
  bridge?: Omit<MarkBridgeItem, 'key' | 'onSelect'>;
}

export function TitlePill({ level, variant = 'current' }: {
  level: TitlePillLevel;
  variant?: 'current' | 'ancestor';
}): React.JSX.Element {
  const body = <>
    <span className="title-pill-icon">{level.icon}</span>
    <span className="title-pill-title">{level.title}</span>
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
  // A menu reopens at its root, wherever it was left. Opening it lets go of any
  // text entry, so a phone's keyboard drops rather than covering the menu.
  const onOpenChange = (open: boolean): void => {
    if (open) {
      blurTextEntry();
      return;
    }
    setDirection('in');
    setView(null);
  };
  const chevron = <IconChevronDown aria-hidden="true" className="title-pill-chevron" size={13} stroke={2} />;
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
      collisionPadding={TITLE_MENU_COLLISION_PADDING}
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
      {crumb}
      {chevron}
    </DropdownMenu.Trigger>
    {menu}
  </DropdownMenu.Root>;
}

/**
 * What a pane header carries at phone width, where it is the screen's only
 * header: the app's navigation and its app-wide actions. The app shell
 * provides it; without a provider, or wider than a phone, a header carries
 * only its own pane's controls.
 */
export interface PhoneHeader {
  /** Opens the navigation sheet. Drawn as a round button ahead of the header's crumbs. */
  openNavigation: () => void;
  /** Ahead of the pane's own actions in its "More" menu, e.g. Search. */
  actions: readonly IconGroupAction[];
}

export const PhoneHeaderContext = createContext<PhoneHeader | null>(null);

/**
 * The menu button a visible pane header draws, for whatever has to find it: the
 * stylesheet drops the sheet's own bar while one is on screen, and focus
 * returns to it when the sheet closes.
 */
export const PHONE_NAVIGATION_CONTROL = '.main-pane .has-phone-navigation:not([hidden] *) button';

const FOLDED_MARK: IdentityMark = {
  shape: 'circle',
  icon: Ellipsis,
  tint: 'var(--av-sys-color-surface-raised)',
  ink: 'var(--av-sys-color-text-default)',
};

/**
 * A phone's crumbs: past two, every crumb but the nearest folds into one
 * "…" mark that lists them, so the row stays two marks wide.
 */
function foldCrumbs(crumbs: MarkBridgeItem[]): MarkBridgeItem[] {
  if (crumbs.length <= 2) return crumbs;
  const nearest = crumbs.at(-1)!;
  return [{ key: 'folded', mark: FOLDED_MARK, name: 'Show path', menu: crumbs.slice(0, -1) }, nearest];
}

function usePhoneHeader(): { phone: boolean; header: PhoneHeader | null } {
  const phone = usePhoneLayout();
  const header = useContext(PhoneHeaderContext);
  return { phone, header: phone ? header : null };
}

/**
 * The phone header's menu button: a round control like the trailing ones,
 * apart from the crumbs' bridge, which holds only the path.
 */
function NavigationButton({ header }: { header: PhoneHeader }): React.JSX.Element {
  return <span className="title-pill-navigation has-phone-navigation window-no-drag">
    <TitlePillAction label="Open navigation" onClick={header.openNavigation}>
      <Menu aria-hidden="true" size={16} strokeWidth={1.9} />
    </TitlePillAction>
  </span>;
}

/**
 * The menu button alone, for a header drawn before its pane has loaded, so the
 * way to the navigation is there from the first frame.
 */
export function TitlePillNavigation(): React.JSX.Element | null {
  const { header } = usePhoneHeader();
  return header ? <NavigationButton header={header} /> : null;
}

/** Optional host-owned controls before the breadcrumb. */
export const TitlePillLeadingContext = createContext<ReactNode>(null);

/** Shared by loaded headers and their opening skeletons. */
export function TitlePillLeading(): React.JSX.Element | null {
  const leading = useContext(TitlePillLeadingContext);
  return leading ? <span className="title-pill-leading window-no-drag">{leading}</span> : null;
}

/**
 * A conversation pane's header: its own pill centered, any ancestors stacked
 * at the left in nesting order, and the pane's trailing controls at the right.
 * The centre column stays centred however many ancestors there are. At phone
 * width it also carries `PhoneHeader`: the menu button leads the ancestors,
 * and the app-wide actions lead the folded "More" menu.
 */
export function TitlePillHeader({ actions, ancestors = [], className, current, tooltipSide, trailing }: {
  /** Round buttons ahead of `trailing`, folded into a "More" dropdown at phone width. */
  actions?: readonly IconGroupAction[];
  ancestors?: readonly TitlePillLevel[];
  className?: string;
  current: TitlePillLevel;
  /** Where the group's labels open; pass the same to a `TitlePillClose` in `trailing`. */
  tooltipSide?: TooltipSide | undefined;
  trailing?: ReactNode;
}): React.JSX.Element {
  // Ancestors that all have marks are drawn as one bridge of them, at every
  // width; pills are the fallback while any lacks one.
  const bridge: MarkBridgeItem[] = [];
  for (const level of ancestors) {
    if (level.bridge) bridge.push({ key: level.key, ...level.bridge, onSelect: level.onSelect });
  }
  const bridged = ancestors.length > 0 && bridge.length === ancestors.length;
  const { phone, header: phoneHeader } = usePhoneHeader();
  const shownActions = phoneHeader ? [...phoneHeader.actions, ...actions ?? []] : actions;
  const headerRef = useRef<HTMLElement>(null);
  const currentRef = useRef<HTMLDivElement>(null);
  const trailingRef = useRef<HTMLDivElement>(null);
  const { crowded, shift } = useTrailingCrowded(headerRef, currentRef, trailingRef, shownActions?.filter((action) => !action.alwaysVisible).length ?? 0);
  return <header
    className={clsx('title-pill-header window-drag', crowded && 'is-crowded', className)}
    ref={headerRef}
    style={shift ? { '--title-pill-shift': `${shift}px` } as React.CSSProperties : undefined}
  >
    <div className="title-pill-ancestors">
      <TitlePillLeading />
      {phoneHeader ? <NavigationButton header={phoneHeader} /> : null}
      {bridged ? null : ancestors.map((level) => <span className="title-pill-ancestor window-no-drag" key={level.key}>
        <TitlePill level={level} variant="ancestor" />
      </span>)}
      {/* The nearest crumb keeps its name, which a bare mark does not say. A
          phone has no room for it and the stylesheet hides it there; the
          shape is measured from the name, so it closes back to a circle. */}
      {bridged ? <MarkBridge className="title-pill-bridge window-no-drag" items={phone ? foldCrumbs(bridge) : bridge} labelLast /> : null}
    </div>
    <div className="title-pill-current window-no-drag" ref={currentRef}><TitlePill level={current} /></div>
    <div className="title-pill-trailing" ref={trailingRef}>{trailing || shownActions?.length
      ? <IconGroup actions={shownActions} buttonClassName="title-pill-action" className="window-no-drag" folded={crowded} tooltipSide={tooltipSide}>{trailing}</IconGroup>
      : null}</div>
  </header>;
}

/**
 * Whether the header's trailing buttons, unfolded, would come closer to the
 * centred pill than the gap between the buttons themselves, and if so how far
 * left the pill moves to keep that gap from the folded row.
 *
 * Decided from the layout the header would have unfolded and centred, not
 * from where things sit now: folding narrows the row and crowding moves
 * the pill, and reading either back would undo the decision that caused it.
 */
function useTrailingCrowded(
  headerRef: RefObject<HTMLElement | null>,
  currentRef: RefObject<HTMLElement | null>,
  trailingRef: RefObject<HTMLElement | null>,
  actionCount: number,
): { crowded: boolean; shift: number } {
  const [state, setState] = useState({ crowded: false, shift: 0 });
  useLayoutEffect(() => {
    const header = headerRef.current;
    const current = currentRef.current;
    const trailing = trailingRef.current;
    if (!header || !current || !trailing || typeof ResizeObserver === 'undefined') return;
    const measure = (): void => {
      const group = trailing.querySelector<HTMLElement>('.icon-group');
      const pill = current.firstElementChild;
      if (!group || !(pill instanceof HTMLElement)) return;
      const gap = Number.parseFloat(getComputedStyle(group).columnGap) || 0;
      const style = getComputedStyle(header);
      const box = header.getBoundingClientRect();
      const left = box.left + (Number.parseFloat(style.paddingLeft) || 0);
      const right = box.right - (Number.parseFloat(style.paddingRight) || 0);
      // Folded by this hook or by the phone-width rule; either way the row is narrower.
      const actions = group.querySelector('.icon-group-actions');
      const folded = actions ? getComputedStyle(actions).display === 'none' : false;
      const more = group.querySelector<HTMLElement>('.icon-group-more');
      const button = more && more.offsetWidth ? more.offsetWidth : 0;
      const step = Math.max(0, actionCount - 1) * (button + gap);
      const rowWidth = group.offsetWidth + (folded ? step : 0);
      // The pill only ever moves, never shrinks, so its width is its own even
      // while crowded, and follows a title that gets shorter.
      const pillRight = (left + right) / 2 + pill.offsetWidth / 2;
      const crowded = right - rowWidth - pillRight < gap;
      // Folded, the row is one "More" button narrower by `step`; the pill moves
      // only as far as it takes to sit a gap from it.
      const foldedLeft = right - (rowWidth - step);
      const shift = crowded ? Math.max(0, Math.ceil(pillRight + gap - foldedLeft)) : 0;
      setState((was) => was.crowded === crowded && was.shift === shift ? was : { crowded, shift });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(header);
    observer.observe(current);
    observer.observe(trailing);
    return () => observer.disconnect();
  }, [actionCount, currentRef, headerRef, trailingRef]);
  return state;
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

/** A standard button at the right of a title menu header, e.g. Show in thread. */
export function TitleMenuButton({ children, onSelect }: { children: ReactNode; onSelect: () => void }): React.JSX.Element {
  return <DropdownMenu.Item className="button title-menu-button" onSelect={onSelect}>{children}</DropdownMenu.Item>;
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

/**
 * A round control at the right of a pane's header. Every icon in a header
 * wears the same raised circle as the pills beside it, so one header never
 * mixes bare glyphs with round ones.
 */
export function TitlePillAction({ children, label, onClick, tooltipSide }: {
  children: ReactNode; label: string; onClick: () => void; tooltipSide?: TooltipSide | undefined;
}): React.JSX.Element {
  return <IconButton className="title-pill-action" label={label} onClick={onClick} tooltipSide={tooltipSide}>{children}</IconButton>;
}

/** A row of square actions under the menu's header, the most used things done to it. */
export function ActionTiles({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="title-menu-tiles" role="group" aria-label="Actions">{children}</div>;
}

export function ActionTile({ icon, label, onSelect, disabled }: {
  icon: ReactNode; label: string; onSelect: (event: Event) => void; disabled?: boolean | undefined;
}): React.JSX.Element {
  return <DropdownMenu.Item className="title-menu-tile" disabled={disabled} onSelect={onSelect}>
    {icon}<span>{label}</span>
  </DropdownMenu.Item>;
}

/** A row that opens a level of the menu in place: People, Sidekicks, Breakouts. */
export function LevelRow({ icon, label, meta, view }: {
  icon: ReactNode; label: string; meta?: ReactNode; view: TitleMenuView;
}): React.JSX.Element {
  const nav = useTitleMenuNav();
  return <DropdownMenu.Item className="menu-item title-menu-level-row" data-title-menu-level={view.key} onSelect={(event) => { event.preventDefault(); nav.open(view); }}>
    {icon}
    <span className="title-menu-item-copy">{label}</span>
    {meta !== undefined && <span className="title-menu-level-meta">{meta}</span>}
    <IconChevronRight aria-hidden="true" className="title-menu-level-chevron" size={15} stroke={1.8} />
  </DropdownMenu.Item>;
}

/** Selecting a tile that leads to a level keeps the menu open and moves to it. */
export function openLevel(nav: ReturnType<typeof useTitleMenuNav>, view: TitleMenuView) {
  return (event: Event): void => { event.preventDefault(); nav.open(view); };
}

/** The round control that closes a pane, at the right of its header. */
export function TitlePillClose({ label, onClose, tooltipSide }: {
  label: string; onClose: () => void; tooltipSide?: TooltipSide | undefined;
}): React.JSX.Element {
  return <TitlePillAction label={label} onClick={onClose} tooltipSide={tooltipSide}>
    <IconX aria-hidden="true" size={16} stroke={1.9} />
  </TitlePillAction>;
}
