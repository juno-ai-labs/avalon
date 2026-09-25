import {
  COLLAPSED_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
  SIDEBAR_CONTENT_MIN_WIDTH,
} from '@rally/ui/lib/sidebar-geometry';

export interface BrowserSidebarLayout {
  channelsAvailableWidth: number;
  channelsConstrained: boolean;
  channelsWidth: number;
  spacesAvailableWidth: number;
  spacesConstrained: boolean;
  spacesWidth: number;
}

export interface BrowserRailVisibility {
  channels: boolean;
  spaces: boolean;
}

/**
 * A rail with exactly one row offers no choice, so it is left out. Until the
 * directory answers, and when it holds nothing, both rails stay: they carry the
 * loading, error and empty states.
 */
export function browserRailVisibility(counts: { spaceCount: number; channelCount: number } | undefined): BrowserRailVisibility {
  if (!counts) return { channels: true, spaces: true };
  return { channels: counts.channelCount !== 1, spaces: counts.spaceCount !== 1 };
}

/** Preserve Electron's conversation minimum while sizing the two outer hierarchy rails. */
export function browserSidebarLayout(input: {
  channelOpen: boolean;
  channelsCollapsed: boolean;
  channelsPreferredWidth: number;
  channelsVisible: boolean;
  spacesCollapsed: boolean;
  spacesPreferredWidth: number;
  spacesVisible: boolean;
  viewportWidth: number;
}): BrowserSidebarLayout {
  const breakoutWidth = input.channelOpen ? COLLAPSED_SIDEBAR_WIDTH : 0;
  const spacesAvailableWidth = input.viewportWidth
    - SIDEBAR_CONTENT_MIN_WIDTH
    - (input.channelsVisible ? COLLAPSED_SIDEBAR_WIDTH : 0)
    - breakoutWidth;
  const spacesConstrained = input.spacesVisible && spacesAvailableWidth < MIN_SIDEBAR_WIDTH;
  const spacesWidth = !input.spacesVisible ? 0 : input.spacesCollapsed || spacesConstrained
    ? COLLAPSED_SIDEBAR_WIDTH
    : Math.min(input.spacesPreferredWidth, spacesAvailableWidth);
  const channelsAvailableWidth = input.viewportWidth
    - SIDEBAR_CONTENT_MIN_WIDTH
    - breakoutWidth
    - spacesWidth;
  const channelsConstrained = input.channelsVisible && channelsAvailableWidth < input.channelsPreferredWidth;
  const channelsWidth = !input.channelsVisible ? 0 : input.channelsCollapsed || channelsConstrained
    ? COLLAPSED_SIDEBAR_WIDTH
    : input.channelsPreferredWidth;

  return {
    channelsAvailableWidth,
    channelsConstrained,
    channelsWidth,
    spacesAvailableWidth,
    spacesConstrained,
    spacesWidth,
  };
}
