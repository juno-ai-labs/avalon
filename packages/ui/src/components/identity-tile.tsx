import clsx from 'clsx';
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { Tip } from './primitives';

/**
 * What a tile's outline says about the thing it stands for. A Channel is a
 * squircle and a Thread is a circle, everywhere a list shows one, so a row is
 * read as one or the other before its name is. An artifact is a sheet, a
 * square with a tighter corner than a Channel's, painted neutral rather than in
 * a hue. The section switcher draws the same outlines, plus the triangle for
 * Activity, which no object takes; Artifacts' outline is a page.
 */
export type TileShape = 'squircle' | 'circle' | 'sheet';

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

/**
 * One badge at a lone badge's place on the corner of a tile that is not an
 * `IdentityTile`, such as an Activity row's glyph, which carries the Canvas
 * the row is about. The tile is the caller's; it must be positioned.
 */
export function CornerBadge({ badge }: { badge: TileBadge }): React.JSX.Element {
  return <Badge badge={badge} bottom={-5} right={-6} />;
}

/** A shape an outline can draw: a tile's, and the triangle no object uses. */
export type OutlineShape = TileShape | 'triangle';

const OUTLINES: Record<OutlineShape, ReactNode> = {
  squircle: <rect height="16.8" rx="5.6" width="16.8" x="3.6" y="3.6" />,
  circle: <circle cx="12" cy="12" r="8.6" />,
  triangle: <path d="M10.6 4.3a1.6 1.6 0 0 1 2.8 0l7.9 13.9a1.6 1.6 0 0 1-1.4 2.4H4.1a1.6 1.6 0 0 1-1.4-2.4z" />,
  sheet: <>
    <path d="M6.6 3.4h7.2l5.2 5.2v10.4a1.6 1.6 0 0 1-1.6 1.6H6.6A1.6 1.6 0 0 1 5 19V5a1.6 1.6 0 0 1 1.6-1.6z" />
    <path d="M13.6 3.6v3.6a1.6 1.6 0 0 0 1.6 1.6h3.6" />
  </>,
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
