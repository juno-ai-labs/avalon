import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import clsx from 'clsx';
import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

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
/** Room after a labelled mark's name, before the shape's rounded end. */
const LABEL_END = 12;

/** The width of `count` marks on a bridge. */
function markBridgeWidth(count: number): number {
  return (count - 1) * SPAN + 2 * RADIUS;
}

/**
 * The outline of `count` marks, stretching the last for its label. An optional
 * trailing control adds a neutral pill after it, through the same neck. Each
 * lobe has independent start/end centres so both pills keep round ends.
 */
function bridgePath(count: number, extra: number, trailingWidth = 0): string {
  const r = RADIUS;
  const lobes = Array.from({ length: count }, (_, index) => ({
    start: r + index * SPAN,
    end: r + index * SPAN + (index === count - 1 ? extra : 0),
  }));
  if (trailingWidth > 0) {
    const start = lobes.at(-1)!.end + SPAN;
    lobes.push({ start, end: start + Math.max(0, trailingWidth - 2 * r) });
  }
  const dx = r * Math.cos(ANGLE);
  const dy = r * Math.sin(ANGLE);
  const reach = (dy - NECK) / (0.75 * Math.cos(ANGLE));
  const rx = reach * Math.sin(ANGLE);
  const ry = reach * Math.cos(ANGLE);
  const top = r - dy;
  const bottom = r + dy;
  const n = (value: number): string => value.toFixed(2);
  const path = [`M${r} 0`];
  lobes.forEach((lobe, index) => {
    path.push(`L${n(lobe.end)} 0`);
    const next = lobes[index + 1];
    if (next) path.push(
      `A${r} ${r} 0 0 1 ${n(lobe.end + dx)} ${n(top)}`,
      `C${n(lobe.end + dx + rx)} ${n(top + ry)} ${n(next.start - dx - rx)} ${n(top + ry)} ${n(next.start - dx)} ${n(top)}`,
      `A${r} ${r} 0 0 1 ${n(next.start)} 0`,
    );
    else path.push(`A${r} ${r} 0 0 1 ${n(lobe.end)} ${2 * r}`);
  });
  for (let index = lobes.length - 1; index >= 0; index -= 1) {
    const lobe = lobes[index]!;
    path.push(`L${n(lobe.start)} ${2 * r}`);
    const previous = lobes[index - 1];
    if (previous) path.push(
      `A${r} ${r} 0 0 1 ${n(lobe.start - dx)} ${n(bottom)}`,
      `C${n(lobe.start - dx - rx)} ${n(bottom - ry)} ${n(previous.end + dx + rx)} ${n(bottom - ry)} ${n(previous.end + dx)} ${n(bottom)}`,
      `A${r} ${r} 0 0 1 ${n(previous.end)} ${2 * r}`,
    );
    else path.push(`A${r} ${r} 0 0 1 ${r} 0 Z`);
  }
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
 * `labelLast` writes the last object's name beside its mark, stretching that
 * mark into a pill the name's width; the shape is measured from the name as
 * laid out, so it fits whatever font and size it renders in. The bridge never
 * grows past its container: a name too long for the room ends in an ellipsis
 * and the pill is drawn to the width it was given. `trailing` joins a control
 * after the last mark in a neutral glass lobe, measured from its rendered width.
 */
export function MarkBridge({ className, items, labelLast = false, trailing }: {
  className?: string | undefined;
  items: readonly MarkBridgeItem[];
  labelLast?: boolean | undefined;
  /** A control joined to the last mark with a neutral glass lobe. */
  trailing?: ReactNode;
}): React.JSX.Element | null {
  const id = useId();
  const root = useRef<HTMLSpanElement>(null);
  const tail = useRef<HTMLSpanElement>(null);
  const label = useRef<HTMLSpanElement>(null);
  // The name's full width, however much of it shows, and the width the
  // bridge was actually given once its container had its say.
  const [size, setSize] = useState({ name: 0, given: 0, tail: 0 });
  const hasTrailing = Boolean(trailing);
  const labelled = labelLast && items.length > 0;
  // A different last object is a new label element: observe that one.
  const last = items.at(-1);
  useLayoutEffect(() => {
    const box = root.current;
    const element = label.current;
    if ((!labelled && !hasTrailing) || !box) { setSize({ name: 0, given: 0, tail: 0 }); return undefined; }
    const measure = (): void => setSize((current) => {
      // scrollWidth rounds to the nearest pixel, which can undersize even a
      // short name and trigger an ellipsis. A range measures the full text
      // at subpixel precision even when the label is clipped.
      const text = document.createRange();
      if (element) text.selectNodeContents(element);
      const next = { name: element ? Math.ceil(text.getBoundingClientRect().width) : 0, given: box.getBoundingClientRect().width, tail: tail.current?.getBoundingClientRect().width ?? 0 };
      return next.name === current.name && next.given === current.given && next.tail === current.tail ? current : next;
    });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    if (element) observer.observe(element);
    if (tail.current) observer.observe(tail.current);
    return () => observer.disconnect();
  }, [labelled, last?.key, last?.name, hasTrailing]);
  const count = items.length;
  // Nothing to join: the geometry below assumes at least one mark.
  if (count === 0) return null;
  // The gradient spans the circles; past the last it holds the last tint.
  const tintWidth = markBridgeWidth(count);
  // Asked for the whole name; drawn to what the container allowed.
  const wanted = labelled && size.name > 0 ? tintWidth + size.name + LABEL_END : tintWidth;
  const width = labelled && size.name > 0 && size.given > 0 ? Math.max(tintWidth, Math.min(wanted, size.given - (trailing ? size.tail + SPAN - 2 * RADIUS : 0))) : wanted;
  const extra = width - tintWidth;
  const tailWidth = trailing ? Math.max(2 * RADIUS, size.tail) : 0;
  const totalWidth = width + (trailing ? tailWidth + SPAN - 2 * RADIUS : 0);
  const path = bridgePath(count, extra, tailWidth);
  const stops = bridgeStops(items.map((item) => item.mark.tint));
  if (trailing) {
    // Keep the last crumb tinted through its label, blending only at the neck.
    stops.forEach((stop) => { stop.offset *= tintWidth / totalWidth; });
    stops.push(
      { offset: (width - HOLD) / totalWidth, color: last!.mark.tint },
      { offset: (width + SPAN - 2 * RADIUS + HOLD) / totalWidth, color: 'var(--av-sys-color-surface-raised)' },
      { offset: 1, color: 'var(--av-sys-color-surface-raised)' },
    );
  }
  const height = 2 * RADIUS;
  return <span className={clsx('mark-bridge', trailing && 'has-trailing', className)} ref={root} style={{ height, minWidth: tintWidth, width: trailing ? undefined : wanted }}>
    {trailing ? <span aria-hidden="true" className="mark-bridge-spacer" style={{ minWidth: tintWidth, width: wanted }} /> : null}
    <svg
      aria-hidden="true"
      className="mark-bridge-glass"
      height={height + 2}
      // The trailing control paints itself. Fade its backing glass underneath
      // its left cap, preserving its own rim and shadow without a clipped edge.
      style={trailing ? { maskImage: `linear-gradient(to right, #000 ${width}px, transparent ${width + SPAN - RADIUS}px)` } : undefined}
      viewBox={`-1 -1 ${totalWidth + 2} ${height + 2}`}
      width={totalWidth + 2}
    >
      <defs>
        <linearGradient gradientUnits="userSpaceOnUse" id={`${id}-tint`} x1="0" x2={trailing ? totalWidth : tintWidth} y1="0" y2="0">
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
      </defs>
      <path d={path} fill={`url(#${id}-tint)`} />
      <path d={path} fill={`url(#${id}-sheen)`} />
      <path clipPath={`url(#${id}-inside)`} d={path} fill="none" stroke={`url(#${id}-rim)`} strokeWidth="3" />
      <path className="mark-bridge-edge" d={path} />
    </svg>
    {items.map((item, index) => {
      const Icon = item.mark.icon;
      const named = labelled && index === count - 1;
      const symbol = <>
        <ShapeOutline className="mark-bridge-outline" shape={item.mark.shape} size={2 * RADIUS} strokeWidth={1.1} />
        <Icon aria-hidden="true" className="mark-bridge-icon" size={14} strokeWidth={2} />
      </>;
      const content = named ? <>
        <span className="mark-bridge-cell">{symbol}</span>
        <span className="mark-bridge-label" ref={label}>{item.name}</span>
      </> : symbol;
      const style = { color: item.mark.ink, left: index * SPAN, ...(named ? { paddingRight: LABEL_END, width: 2 * RADIUS + extra } : {}) };
      const markClass = clsx('mark-bridge-mark', named && 'is-labelled');
      const accessibleName = item.action ? `${item.action}: ${item.name}` : item.name;
      const mark = item.menu
        ? <DropdownMenu.Trigger asChild>
          <button aria-label={accessibleName} className={markClass} style={style} type="button">{content}</button>
        </DropdownMenu.Trigger>
        : item.onSelect
          ? <button aria-label={accessibleName} className={markClass} disabled={item.disabled} onClick={item.onSelect} style={style} type="button">{content}</button>
          : <span aria-label={accessibleName} className={markClass} role="img" style={style}>{content}</span>;
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
    {trailing ? <span className="mark-bridge-trailing" ref={tail}>{trailing}</span> : null}
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
