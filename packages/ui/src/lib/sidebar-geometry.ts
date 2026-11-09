// macOS places 12px traffic lights at x=18, 38, and 58. The last one ends at
// 70px, so 88px leaves the same 18px from that edge as the first light has
// from the leading edge. Every hierarchy rail uses this width.
export const COLLAPSED_SIDEBAR_WIDTH = 88;
/**
 * Wide enough for the top bar's five buttons beside the macOS traffic lights:
 * 100px inset + 5 × 32px buttons + 4 × 8px gaps + 14px. The attention count
 * stays in its 32px button (99+ past two digits). Shared by every host, web too.
 */
export const MIN_SIDEBAR_WIDTH = 306;
/** The navigation rail's column (`--navigation-rail-width` in app.css). */
export const NAVIGATION_RAIL_WIDTH = 76;
/** The list column beside the rail, from design.html §1 and §2. */
export const SIDEBAR_LIST_DEFAULT_WIDTH = 340;
/**
 * The single navigation sidebar's starting width: the rail plus the design's
 * list column. A width the person dragged to is kept over it.
 */
export const SINGLE_SIDEBAR_DEFAULT_WIDTH = NAVIGATION_RAIL_WIDTH + SIDEBAR_LIST_DEFAULT_WIDTH;
/**
 * Keeps the 60px of drag room above the default that the sidebar had before
 * the default moved from 340 (rail included) to the design's rail plus list.
 */
export const MAX_SIDEBAR_WIDTH = SINGLE_SIDEBAR_DEFAULT_WIDTH + 60;
export const DEFAULT_SIDEBAR_WIDTH = 280;
/** The main conversation width GrokBot protects before forcing the icon rail. */
export const SIDEBAR_CONTENT_MIN_WIDTH = 424;
/** Drag thresholds include GrokBot's ten-pixel hysteresis on expansion. */
export const SIDEBAR_COLLAPSE_DRAG_THRESHOLD = 210;
export const SIDEBAR_EXPAND_DRAG_THRESHOLD = 220;
