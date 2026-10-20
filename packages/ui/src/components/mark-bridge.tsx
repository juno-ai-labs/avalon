import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import clsx from 'clsx';
import { useId, type ReactNode } from 'react';

import { ShapeOutline, type IdentityMark } from './identity-tile';
import { Tip } from './primitives';

/** One object on a bridge: its mark, what it is called, and where it goes. */
export interface MarkBridgeItem {
  key: string;
  mark: IdentityMark;
  /** The object's name: the tooltip's first line. */
  name: string;
  /** What selecting it does, such as `Open channel`: the tooltip's second line. */
  action?: string | undefined;
  /** Without it the mark is a picture, not a control. */
  onSelect?: (() => void) | undefined;
  /**
   * Objects this mark stands for, listed in a menu it opens instead of
   * `onSelect`: a bridge too long for its room folds its leading marks here.
   */
  menu?: readonly MarkBridgeItem[] | undefined;
  disabled?: boolean | undefined;
}

/*
 * Marks joined in a row by narrow necks, as drops of water touch. Each mark is
 * a RADIUS circle and the next sits SPAN along, so the outline depends only on
 * how many there are.
 */
const RADIUS = 18;
const SPAN = 42;
const NECK = 7;
/** Where a neck leaves its circle, measured from the line between centres. */
const ANGLE = Math.PI / 4;
/** How far either side of a mark's centre its own tint holds before blending. */
const HOLD = 9;
/** Stops in each blend; enough that straight runs between them read as one curve. */
const BLEND_STEPS = 8;

/** The width of `count` marks on a bridge. */
function markBridgeWidth(count: number): number {
  return (count - 1) * SPAN + 2 * RADIUS;
}

/**
 * The outline of `count` circles in a row, each joined to the next by a neck.
 */
function bridgePath(count: number): string {
  const r = RADIUS;
  const centre = (index: number): number => r + index * SPAN;
  const dx = r * Math.cos(ANGLE);
  const dy = r * Math.sin(ANGLE);
  // A cubic's midpoint sits at (p0 + 3c0 + 3c1 + p1) / 8; solving for the
  // control length that lands it on the neck's half height.
  const reach = (dy - NECK) / (0.75 * Math.cos(ANGLE));
  const rx = reach * Math.sin(ANGLE);
  const ry = reach * Math.cos(ANGLE);
  const top = r - dy;
  const bottom = r + dy;
  const n = (value: number): string => value.toFixed(2);
  const last = count - 1;
  const end = centre(last);
  if (last === 0) return `M${r} 0 L${n(end)} 0 A${r} ${r} 0 0 1 ${n(end)} ${2 * r} L${r} ${2 * r} A${r} ${r} 0 0 1 ${r} 0 Z`;
  // Clockwise from the first neck's top: along the top, round the last
  // circle, back along the bottom, round the first. Each inner circle shows
  // a short arc between its two necks.
  const path = [`M${n(centre(0) + dx)} ${n(top)}`];
  for (let index = 0; index < last; index += 1) {
    const from = centre(index) + dx;
    const to = centre(index + 1) - dx;
    path.push(`C${n(from + rx)} ${n(top + ry)} ${n(to - rx)} ${n(top + ry)} ${n(to)} ${n(top)}`);
    if (index + 1 < last) path.push(`A${r} ${r} 0 0 1 ${n(centre(index + 1) + dx)} ${n(top)}`);
  }
  // Round the last mark, then travel back along the bottom.
  path.push(
    `A${r} ${r} 0 0 1 ${n(centre(last))} 0`,
    `L${n(end)} 0`,
    `A${r} ${r} 0 0 1 ${n(end)} ${2 * r}`,
    `L${n(centre(last))} ${2 * r}`,
    `A${r} ${r} 0 0 1 ${n(centre(last) - dx)} ${n(bottom)}`,
  );
  for (let index = last; index > 0; index -= 1) {
    const from = centre(index) - dx;
    const to = centre(index - 1) + dx;
    path.push(`C${n(from - rx)} ${n(bottom - ry)} ${n(to + rx)} ${n(bottom - ry)} ${n(to)} ${n(bottom)}`);
    if (index - 1 > 0) path.push(`A${r} ${r} 0 0 1 ${n(centre(index - 1) - dx)} ${n(bottom)}`);
  }
  path.push(`A${r} ${r} 0 1 1 ${n(centre(0) + dx)} ${n(top)}`, 'Z');
  return path.join(' ');
}

/**
 * The fill: each mark's tint flat across its circle, blending into the next
 * across the neck. An SVG gradient interpolates in sRGB, which runs two hues
 * through a grey middle, so each blend is cut into stops that are themselves
 * mixed in OKLCH: lightness, chroma and hue each move evenly.
 */
function bridgeStops(tints: readonly string[]): { offset: number; color: string }[] {
  const width = markBridgeWidth(tints.length);
  const stops: { offset: number; color: string }[] = [];
  tints.forEach((tint, index) => {
    const centre = RADIUS + index * SPAN;
    stops.push({ offset: (centre - HOLD) / width, color: tint }, { offset: (centre + HOLD) / width, color: tint });
    const next = tints[index + 1];
    if (next === undefined || next === tint) return;
    const from = centre + HOLD;
    const run = SPAN - 2 * HOLD;
    for (let step = 1; step < BLEND_STEPS; step += 1) {
      const share = step / BLEND_STEPS;
      stops.push({ offset: (from + run * share) / width, color: `color-mix(in oklch, ${tint}, ${next} ${(share * 100).toFixed(1)}%)` });
    }
  });
  return stops;
}

/**
 * A row of marks fused into one glass shape: a circle per object in its tint,
 * each joined to the next by a narrow neck, the tints blending across it. Each
 * mark shows the object's outline (a Channel's squircle, a thread's circle)
 * and its symbol, in its ink, and is its own control with its own tooltip.
 *
 * It says nothing about what the objects are or where they go: a caller hands
 * it marks, names, and what selecting each does.
 *
 * `trailing` attaches a control that paints itself. One extra circle supplies
 * the connecting neck, fading beneath the control's left cap. Its width never
 * depends on the control's title, so the bridge needs no layout measurement.
 */
export function MarkBridge({ className, items, trailing }: {
  className?: string | undefined;
  items: readonly MarkBridgeItem[];
  trailing?: ReactNode;
}): React.JSX.Element | null {
  const id = useId();
  const count = items.length;
  if (count === 0 && !trailing) return null;
  const width = count > 0 ? markBridgeWidth(count) : 0;
  const glassCount = count + (trailing ? 1 : 0);
  const glassWidth = markBridgeWidth(glassCount);
  const path = bridgePath(glassCount);
  const tints = items.map((item) => item.mark.tint);
  if (trailing) tints.push('var(--av-sys-color-surface-raised)');
  const stops = bridgeStops(tints);
  const height = 2 * RADIUS;
  return <span className={clsx('mark-bridge', trailing && count > 0 && 'has-trailing', className)} style={{
    height,
    minWidth: trailing ? glassWidth : width,
    width: trailing ? undefined : width,
    columnGap: trailing && count > 0 ? SPAN - 2 * RADIUS : undefined,
  }}>
    {trailing && count > 0 ? <span aria-hidden="true" className="mark-bridge-spacer" style={{ width }} /> : null}
    {count > 0 ? <svg
      aria-hidden="true"
      className="mark-bridge-glass"
      height={height + 2}
      viewBox={`-1 -1 ${glassWidth + 2} ${height + 2}`}
      width={glassWidth + 2}
    >
      <defs>
        <linearGradient gradientUnits="userSpaceOnUse" id={`${id}-tint`} x1="0" x2={glassWidth} y1="0" y2="0">
          {stops.map((stop, index) => <stop key={index} offset={stop.offset} style={{ stopColor: stop.color }} />)}
        </linearGradient>
        {/* Ends above the symbols, so each one sits on its raw tint: the pair's
            contrast is measured against that colour alone. */}
        <linearGradient id={`${id}-sheen`} x1="0" x2="0" y1="0" y2="1">
          <stop className="mark-bridge-sheen-from" offset="0" />
          <stop className="mark-bridge-sheen-to" offset="0.32" />
        </linearGradient>
        <linearGradient id={`${id}-rim`} x1="0" x2="0" y1="0" y2="1">
          <stop className="mark-bridge-rim-from" offset="0" />
          <stop className="mark-bridge-rim-to" offset="0.45" />
        </linearGradient>
        <clipPath id={`${id}-inside`}><path d={path} /></clipPath>
        {/* Fade paths before the outer drop-shadow filter, so the crumbs keep
            their full shadow outside the SVG box. Color is irrelevant to alpha. */}
        <linearGradient gradientUnits="userSpaceOnUse" id={`${id}-fade`} x1={width} x2={width + SPAN - RADIUS} y1="0" y2="0">
          <stop offset="0" stopOpacity="1" />
          <stop offset="1" stopOpacity="0" />
        </linearGradient>
        <mask height={height + 2} id={`${id}-fade-mask`} maskUnits="userSpaceOnUse" style={{ maskType: 'alpha' }} width={glassWidth + 2} x="-1" y="-1">
          <rect fill={`url(#${id}-fade)`} height={height + 2} width={glassWidth + 2} x="-1" y="-1" />
        </mask>
      </defs>
      <g mask={trailing ? `url(#${id}-fade-mask)` : undefined}>
        <path d={path} fill={`url(#${id}-tint)`} />
        <path d={path} fill={`url(#${id}-sheen)`} />
        <path clipPath={`url(#${id}-inside)`} d={path} fill="none" stroke={`url(#${id}-rim)`} strokeWidth="3" />
        <path className="mark-bridge-edge" d={path} />
      </g>
    </svg> : null}
    {items.map((item, index) => {
      const Icon = item.mark.icon;
      const symbol = <>
        <ShapeOutline className="mark-bridge-outline" shape={item.mark.shape} size={2 * RADIUS} strokeWidth={1.1} />
        <Icon aria-hidden="true" className="mark-bridge-icon" size={14} strokeWidth={2} />
      </>;
      const style = { color: item.mark.ink, left: index * SPAN };
      const markClass = 'mark-bridge-mark';
      const accessibleName = item.action ? `${item.action}: ${item.name}` : item.name;
      const mark = item.menu
        ? <DropdownMenu.Trigger asChild>
          <button aria-label={accessibleName} className={markClass} style={style} type="button">{symbol}</button>
        </DropdownMenu.Trigger>
        : item.onSelect
          ? <button aria-label={accessibleName} className={markClass} disabled={item.disabled} onClick={item.onSelect} style={style} type="button">{symbol}</button>
          : <span aria-label={accessibleName} className={markClass} role="img" style={style}>{symbol}</span>;
      // Not hoverable: the next mark sits 6px away, and the pointer's path
      // into an open tip would keep it up over the mark being aimed at.
      const tipped = <Tip
        className="tooltip-hint"
        describesTrigger={false}
        disableHoverableContent
        key={item.key}
        label={<>
          <span>{item.name}</span>
          {item.action ? <small>{item.action}</small> : null}
        </>}
      >{mark}</Tip>;
      // The tip's trigger sits directly on the menu's, so both reach the button.
      return item.menu ? <MarkBridgeMenu items={item.menu} key={item.key}>{tipped}</MarkBridgeMenu> : tipped;
    })}
    {/* Keep the control at the same keyed position when ancestor marks arrive. */}
    {trailing ? <span className="mark-bridge-trailing" key="trailing">{trailing}</span> : null}
  </span>;
}

/**
 * The menu a mark opens, listing the objects it stands for, each with its own
 * mark. `children` holds the mark, its button inside a `DropdownMenu.Trigger`.
 */
function MarkBridgeMenu({ children, items }: {
  children: React.ReactNode;
  items: readonly MarkBridgeItem[];
}): React.JSX.Element {
  return <DropdownMenu.Root modal={false}>
    {children}
    <DropdownMenu.Portal>
      <DropdownMenu.Content align="start" className="menu-content mark-bridge-menu" collisionPadding={12} sideOffset={8}>
        {items.map((item) => {
          const Icon = item.mark.icon;
          return <DropdownMenu.Item
            className="menu-item"
            disabled={!item.onSelect}
            key={item.key}
            onSelect={() => item.onSelect?.()}
          >
            <Icon aria-hidden="true" size={16} strokeWidth={1.9} />
            {item.name}
          </DropdownMenu.Item>;
        })}
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  </DropdownMenu.Root>;
}
