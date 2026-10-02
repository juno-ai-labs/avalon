// macOS places 12px traffic lights at x=18, 38, and 58. The last one ends at
// 70px, so 88px leaves the same 18px from that edge as the first light has
// from the leading edge. Every hierarchy rail uses this width.
export const COLLAPSED_SIDEBAR_WIDTH = 88;
export const MIN_SIDEBAR_WIDTH = 240;
export const MAX_SIDEBAR_WIDTH = 400;
export const DEFAULT_SIDEBAR_WIDTH = 280;
/**
 * The single navigation sidebar's starting width, from the redesign's mockup:
 * room for a Channel title beside its time without cutting it off. A width the
 * person dragged to is kept over it.
 */
export const SINGLE_SIDEBAR_DEFAULT_WIDTH = 340;
/** The main conversation width GrokBot protects before forcing the icon rail. */
export const SIDEBAR_CONTENT_MIN_WIDTH = 424;
/** Drag thresholds include GrokBot's ten-pixel hysteresis on expansion. */
export const SIDEBAR_COLLAPSE_DRAG_THRESHOLD = 210;
export const SIDEBAR_EXPAND_DRAG_THRESHOLD = 220;
