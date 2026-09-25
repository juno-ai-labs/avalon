import { describe, expect, it } from 'vitest';
import { browserRailVisibility, browserSidebarLayout } from '../src/sidebar-layout';

describe('browserSidebarLayout', () => {
  it('protects the conversation and compact Breakout rail at a narrow desktop width', () => {
    expect(browserSidebarLayout({
      channelOpen: true,
      channelsCollapsed: false,
      channelsPreferredWidth: 400,
      channelsVisible: true,
      spacesCollapsed: false,
      spacesPreferredWidth: 400,
      spacesVisible: true,
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
      channelsVisible: true,
      spacesCollapsed: false,
      spacesPreferredWidth: 280,
      spacesVisible: true,
      viewportWidth: 1_200,
    })).toMatchObject({
      channelsConstrained: false,
      channelsWidth: 280,
      spacesConstrained: false,
      spacesWidth: 280,
    });
  });

  it('gives a hidden rail no width and hands its space to the rail that remains', () => {
    expect(browserSidebarLayout({
      channelOpen: true,
      channelsCollapsed: false,
      channelsPreferredWidth: 400,
      channelsVisible: true,
      spacesCollapsed: false,
      spacesPreferredWidth: 400,
      spacesVisible: false,
      viewportWidth: 921,
    })).toEqual({
      channelsAvailableWidth: 409,
      channelsConstrained: false,
      channelsWidth: 400,
      spacesAvailableWidth: 321,
      spacesConstrained: false,
      spacesWidth: 0,
    });
    expect(browserSidebarLayout({
      channelOpen: true,
      channelsCollapsed: false,
      channelsPreferredWidth: 280,
      channelsVisible: false,
      spacesCollapsed: false,
      spacesPreferredWidth: 280,
      spacesVisible: false,
      viewportWidth: 1_200,
    })).toMatchObject({ channelsWidth: 0, spacesWidth: 0 });
  });
});

describe('browserRailVisibility', () => {
  it('keeps both rails until the directory answers', () => {
    expect(browserRailVisibility(undefined)).toEqual({ channels: true, spaces: true });
  });

  it('hides a rail that would list exactly one row', () => {
    expect(browserRailVisibility({ spaces: [{}], unplacedChannels: false, channelCount: 1 }))
      .toEqual({ channels: false, spaces: false });
    expect(browserRailVisibility({ spaces: [{}], unplacedChannels: false, channelCount: 3 }))
      .toEqual({ channels: true, spaces: false });
    expect(browserRailVisibility({ spaces: [], unplacedChannels: true, channelCount: 2 }))
      .toEqual({ channels: true, spaces: false });
  });

  it('counts the Shared channels group as a Space row', () => {
    expect(browserRailVisibility({ spaces: [{}], unplacedChannels: true, channelCount: 2 }))
      .toEqual({ channels: true, spaces: true });
  });

  it('keeps both rails when there is nothing to list, so the empty state shows', () => {
    expect(browserRailVisibility({ spaces: [], unplacedChannels: false, channelCount: 0 }))
      .toEqual({ channels: true, spaces: true });
  });
});
