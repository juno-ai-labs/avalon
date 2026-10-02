import {
  MAX_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
  SIDEBAR_CONTENT_MIN_WIDTH,
} from '@rally/ui/lib/sidebar-geometry';

/**
 * Whether the tab draws its navigation sidebar at all. A guest shared one
 * Channel and nothing else has no choice to make, so the Channel opens alone;
 * until the directory answers, and when it holds nothing, the sidebar stays,
 * since it carries the loading, error and empty states.
 */
export function browserSidebarVisible(counts: { spaceCount: number; channelCount: number } | undefined): boolean {
  if (!counts) return true;
  return counts.channelCount !== 1 || counts.spaceCount > 1;
}

/**
 * The sidebar's width: the reader's preference between the shared clamps, and
 * never more than the window leaves after the conversation minimum.
 */
export function browserSidebarWidth(preferredWidth: number, viewportWidth: number): number {
  return Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, preferredWidth, viewportWidth - SIDEBAR_CONTENT_MIN_WIDTH));
}
