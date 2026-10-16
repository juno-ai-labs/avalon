import clsx from 'clsx';
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { Tip } from './primitives';

/**
 * What a tile's outline says about the thing it stands for. A Channel is a
 * squircle and a Thread is a circle, everywhere a list shows one, so a row is
 * read as one or the other before its name is. The section switcher draws the
 * same outlines, plus the triangle for Activity, which no object takes.
 */
export type TileShape = 'squircle' | 'circle';

/** What an object is drawn as: its outline, its symbol, and the pair it is painted in. */
export interface IdentityMark {
  shape: TileShape;
  icon: LucideIcon;
  /** The fill behind the symbol. */
  tint: string;
  /** The symbol, and anything else drawn over that fill. */
  ink: string;
}

/**
 * How many badges a tile draws. Each 22px badge sits 14px left of the one
 * before, starting 6px past the tile's right edge, so a 36px tile holds two;
 * a third would start 8px past its left edge, out over the row's padding.
 * Geometry, not a policy: a surface that wants more names them elsewhere, as
 * a thread row's second line does.
 */
const BADGE_ROOM = 2;

/**
 * How far a nested badge reaches past its parent badge's corner. The parent
 * moves in by the same amount, so the deepest badge's corner is where a lone
 * badge's would be, at every depth. Large enough that the parent shows above
 * and left of the nested badge rather than hiding under it.
 */
const NESTED_OVERHANG = 5;

/** What every badge has, whatever is drawn in it. */
interface BadgeBase {
  key: string;
  shape: TileShape;
  /** What the badge stands for, shown as a tooltip on hover. */
  label?: string | undefined;
}

/** A symbol the tile draws, in an ink over a fill. */
interface SymbolBadge extends BadgeBase {
  /** The badge's fill. */
  fill: string;
  /** What its symbol is drawn in over that fill. */
  ink: string;
  icon: LucideIcon;
  content?: never;
}

/**
 * Something the caller draws, such as a person's avatar, which paints its own
 * fill. The tile keeps the ring; an `.avatar` is sized to the badge, and
 * anything else keeps its own size.
 */
interface ContentBadge extends BadgeBase {
  content: ReactNode;
  fill?: never;
  ink?: never;
  icon?: never;
}

/** A badge's look, without a badge of its own. */
export type NestedTileBadge = SymbolBadge | ContentBadge;

/**
 * A small tile pinned to a larger one's bottom-right corner, and optionally a
 * smaller badge on its own corner, for a chain of containers: a breakout's
 * tile carries its thread, and the thread carries its Channel. One level: the
 * 15px nested badge has no room for another.
 */
export type TileBadge = NestedTileBadge & { badge?: NestedTileBadge | undefined };

/** A badge in its ring, and the badge nested on its corner, if any. */
function Badge({ badge, bottom, nested = false, right }: {
  badge: TileBadge | NestedTileBadge;
  bottom?: number | undefined;
  nested?: boolean;
  right: number;
}): React.JSX.Element {
  // The tip sits on the fill, not the ring, so hovering a nested badge, which
  // is inside its parent's ring, opens only the nested badge's tip.
  const fill = badge.icon
    ? <span className={clsx('identity-tile-badge-fill', `is-${badge.shape}`)} style={{ background: badge.fill, color: badge.ink }}>
      <badge.icon size={nested ? 7 : 10} strokeWidth={2.2} />
    </span>
    : <span className={clsx('identity-tile-badge-fill', `is-${badge.shape}`)}>{badge.content}</span>;
  return <span
    className={clsx('identity-tile-badge', `is-${badge.shape}`, nested && 'is-nested')}
    style={{ bottom, right }}
  >
    {badge.label ? <Tip disableHoverableContent label={badge.label}>{fill}</Tip> : fill}
    {!nested && 'badge' in badge && badge.badge && <Badge
      badge={badge.badge}
      bottom={-NESTED_OVERHANG}
      nested
      right={-NESTED_OVERHANG}
    />}
  </span>;
}

/**
 * A shaped, tinted tile with one symbol in it, and optionally badges on its
 * corner: a thread's tile carries the Channels it sits in, an Activity row's
 * carries who acted.
 *
 * Each badge sits in a ring painted `--tile-ring`, which the surface sets to
 * its own background, so the badge reads as cut out of the tile on a plain,
 * hovered or selected row alike. The ring is a fill rather than a mask because
 * the badge has to cover the tile beneath it whatever the tile's colour.
 */
export function IdentityTile({ badges, className, icon: Icon, ink, shape, size = 36, tint }: {
  badges?: readonly TileBadge[] | undefined;
  className?: string | undefined;
  icon: LucideIcon;
  ink: string;
  shape: TileShape;
  size?: number;
  tint: string;
}): React.JSX.Element {
  return <span
    aria-hidden="true"
    className={clsx('identity-tile', className)}
    style={{ height: size, width: size }}
  >
    <span className={clsx('identity-tile-shape', `is-${shape}`)} style={{ background: tint, color: ink }}>
      <Icon size={Math.round(size * 0.47)} strokeWidth={1.8} />
    </span>
    {badges?.slice(0, BADGE_ROOM).map((badge, index) => {
      const inset = badge.badge ? NESTED_OVERHANG : 0;
      return <Badge badge={badge} bottom={-5 + inset} key={badge.key} right={-6 + index * 14 + inset} />;
    })}
  </span>;
}

/** A shape an outline can draw: a tile's, the triangle no object uses, and a Sidekick's hexagon. */
export type OutlineShape = TileShape | 'triangle' | 'hexagon';

const OUTLINES: Record<OutlineShape, ReactNode> = {
  squircle: <rect height="16.8" rx="5.6" width="16.8" x="3.6" y="3.6" />,
  circle: <circle cx="12" cy="12" r="8.6" />,
  triangle: <path d="M10.6 4.3a1.6 1.6 0 0 1 2.8 0l7.9 13.9a1.6 1.6 0 0 1-1.4 2.4H4.1a1.6 1.6 0 0 1-1.4-2.4z" />,
  // `HexagonGlyph`'s outline, scaled into this grid.
  hexagon: <path d="M10.72 3.85C11.45 3.3 12.37 3.3 13.28 3.85L18.59 6.96C19.51 7.51 20.06 8.25 20.06 9.34L20.06 14.84C20.06 15.94 19.51 16.67 18.59 17.22L13.28 20.15C12.37 20.7 11.45 20.7 10.53 20.15L5.41 17.04C4.49 16.49 3.94 15.75 3.94 14.66L3.94 9.16C3.94 8.06 4.49 7.33 5.41 6.78Z" />,
};

/** A shape's bare outline, for the section switcher and a collapsed title crumb. */
export function ShapeOutline({ className, shape, size = 22, strokeWidth = 1.8 }: {
  className?: string | undefined;
  shape: OutlineShape;
  size?: number;
  /** In the 24-unit grid, so it scales with `size`. */
  strokeWidth?: number;
}): React.JSX.Element {
  return <svg aria-hidden="true" className={className} fill="none" height={size} stroke="currentColor" strokeLinejoin="round" strokeWidth={strokeWidth} viewBox="0 0 24 24" width={size}>
    {OUTLINES[shape]}
  </svg>;
}

/** Where each of a grid's four cells sits in the 24-unit grid, clockwise from the top left. */
const GRID_CELLS = [[1.5, 1.5], [13.5, 1.5], [13.5, 13.5], [1.5, 13.5]] as const;
/** Each cell is 9 units, leaving a clear gap between strokes; an outline's drawn box is 17.4 of its own 24. */
const GRID_SCALE = 9 / 17.4;

/**
 * Four outlines in a two-by-two grid, clockwise from the top left, for a
 * section that holds several kinds of object. The stroke is in the whole
 * grid's units, a little lighter than a lone outline's so the four small
 * shapes stay apart.
 */
export function ShapeGrid({ className, shapes, size = 22, strokeWidth = 1.5 }: {
  className?: string | undefined;
  shapes: readonly [OutlineShape, OutlineShape, OutlineShape, OutlineShape];
  size?: number;
  strokeWidth?: number;
}): React.JSX.Element {
  return <svg aria-hidden="true" className={className} fill="none" height={size} stroke="currentColor" strokeLinejoin="round" strokeWidth={strokeWidth / GRID_SCALE} viewBox="0 0 24 24" width={size}>
    {shapes.map((shape, index) => {
      const [x, y] = GRID_CELLS[index]!;
      // The outline's 3.3-unit margin is cropped, so its box fills the cell.
      return <g key={index} transform={`translate(${x} ${y}) scale(${GRID_SCALE}) translate(-3.3 -3.3)`}>{OUTLINES[shape]}</g>;
    })}
  </svg>;
}
