import clsx from 'clsx';
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

/**
 * What a tile's outline says about the thing it stands for. A Channel is a
 * squircle and a Thread is a circle, everywhere a list shows one, so a row is
 * read as one or the other before its name is. The section switcher draws the
 * same outlines, plus the triangle for Activity, which no object takes.
 */
export type TileShape = 'squircle' | 'circle';

/**
 * How many badges a tile draws. Each 22px badge sits 14px left of the one
 * before, starting 6px past the tile's right edge, so a 36px tile holds two;
 * a third would start 8px past its left edge, out over the row's padding.
 * Geometry, not a policy: a surface that wants more names them elsewhere, as
 * a thread row's second line does. A nested badge reaches 11px past the
 * tile's right edge and 9px below it, inside the row's gap and padding.
 */
const BADGE_ROOM = 2;

/** A small tile pinned to a larger one's bottom-right corner. */
export interface TileBadge extends NestedTileBadge {
  /**
   * A smaller badge on this badge's own corner, for a chain of containers: a
   * breakout's tile carries its thread, and the thread carries its Channel.
   * One level: the 15px nested badge has no room for another.
   */
  badge?: NestedTileBadge | undefined;
}

/** A badge's look, without a badge of its own. */
export interface NestedTileBadge {
  key: string;
  shape: TileShape;
  /** The badge's fill. */
  fill: string;
  /** What its symbol or text is drawn in over that fill. */
  ink: string;
  icon?: LucideIcon | undefined;
  /** Text in place of a symbol, such as a person's initials. */
  text?: string | undefined;
}

/** A badge in its ring, and the badge nested on its corner, if any. */
function Badge({ badge, nested = false, right }: { badge: TileBadge | NestedTileBadge; nested?: boolean; right: number }): React.JSX.Element {
  return <span
    className={clsx('identity-tile-badge', `is-${badge.shape}`, nested && 'is-nested')}
    style={{ right }}
  >
    <span className={clsx('identity-tile-badge-fill', `is-${badge.shape}`)} style={{ background: badge.fill, color: badge.ink }}>
      {badge.icon ? <badge.icon size={nested ? 7 : 10} strokeWidth={2.2} /> : badge.text}
    </span>
    {!nested && 'badge' in badge && badge.badge && <Badge badge={badge.badge} nested right={-5} />}
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
    {badges?.slice(0, BADGE_ROOM).map((badge, index) => <Badge badge={badge} key={badge.key} right={-6 + index * 14} />)}
  </span>;
}

const OUTLINES: Record<TileShape | 'triangle', ReactNode> = {
  squircle: <rect height="16.8" rx="5.6" width="16.8" x="3.6" y="3.6" />,
  circle: <circle cx="12" cy="12" r="8.6" />,
  triangle: <path d="M10.6 4.3a1.6 1.6 0 0 1 2.8 0l7.9 13.9a1.6 1.6 0 0 1-1.4 2.4H4.1a1.6 1.6 0 0 1-1.4-2.4z" />,
};

/** A shape's bare outline, for the section switcher. */
export function ShapeOutline({ shape, size = 22 }: { shape: TileShape | 'triangle'; size?: number }): React.JSX.Element {
  return <svg aria-hidden="true" fill="none" height={size} stroke="currentColor" strokeLinejoin="round" strokeWidth="1.8" viewBox="0 0 24 24" width={size}>
    {OUTLINES[shape]}
  </svg>;
}
