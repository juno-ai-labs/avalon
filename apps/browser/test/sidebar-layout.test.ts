import { describe, expect, it } from 'vitest';
import { browserSidebarLayout } from '../src/sidebar-layout';

describe('browserSidebarLayout', () => {
  it('protects the conversation and compact Breakout rail at a narrow desktop width', () => {
    expect(browserSidebarLayout({
      channelOpen: true,
      channelsCollapsed: false,
      channelsPreferredWidth: 400,
      spacesCollapsed: false,
      spacesPreferredWidth: 400,
      viewportWidth: 921,
    })).toEqual({
      channelsAvailableWidth: 88,
      channelsConstrained: true,
      channelsWidth: 88,
      spacesAvailableWidth: 321,
      spacesConstrained: false,
      spacesWidth: 321,
    });
  });

  it('leaves both preferred widths expanded when the complete hierarchy fits', () => {
    expect(browserSidebarLayout({
      channelOpen: true,
      channelsCollapsed: false,
      channelsPreferredWidth: 280,
      spacesCollapsed: false,
      spacesPreferredWidth: 280,
      viewportWidth: 1_200,
    })).toMatchObject({
      channelsConstrained: false,
      channelsWidth: 280,
      spacesConstrained: false,
      spacesWidth: 280,
    });
  });
});
