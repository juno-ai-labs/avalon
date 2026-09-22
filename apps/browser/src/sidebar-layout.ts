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

/** Preserve Electron's conversation minimum while sizing the two outer hierarchy rails. */
export function browserSidebarLayout(input: {
  channelOpen: boolean;
  channelsCollapsed: boolean;
  channelsPreferredWidth: number;
  spacesCollapsed: boolean;
  spacesPreferredWidth: number;
  viewportWidth: number;
}): BrowserSidebarLayout {
  const breakoutWidth = input.channelOpen ? COLLAPSED_SIDEBAR_WIDTH : 0;
  const spacesAvailableWidth = input.viewportWidth
    - SIDEBAR_CONTENT_MIN_WIDTH
    - COLLAPSED_SIDEBAR_WIDTH
    - breakoutWidth;
  const spacesConstrained = spacesAvailableWidth < MIN_SIDEBAR_WIDTH;
  const spacesWidth = input.spacesCollapsed || spacesConstrained
    ? COLLAPSED_SIDEBAR_WIDTH
    : Math.min(input.spacesPreferredWidth, spacesAvailableWidth);
  const channelsAvailableWidth = input.viewportWidth
    - SIDEBAR_CONTENT_MIN_WIDTH
    - breakoutWidth
    - spacesWidth;
  const channelsConstrained = channelsAvailableWidth < input.channelsPreferredWidth;
  const channelsWidth = input.channelsCollapsed || channelsConstrained
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
