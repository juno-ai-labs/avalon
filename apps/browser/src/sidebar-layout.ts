import {
  MAX_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
  SIDEBAR_CONTENT_MIN_WIDTH,
} from '@rally/ui/lib/sidebar-geometry';

/**
 * The sidebar's width: the reader's preference between the shared clamps, and
 * never more than the window leaves after the conversation minimum.
 */
export function browserSidebarWidth(preferredWidth: number, viewportWidth: number): number {
  return Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, preferredWidth, viewportWidth - SIDEBAR_CONTENT_MIN_WIDTH));
}
