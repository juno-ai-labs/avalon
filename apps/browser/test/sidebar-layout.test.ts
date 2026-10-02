import { describe, expect, it } from 'vitest';
import { browserSidebarVisible, browserSidebarWidth } from '../src/sidebar-layout';

describe('browserSidebarWidth', () => {
  it('keeps the preferred width when the window holds it beside the conversation', () => {
    expect(browserSidebarWidth(320, 1_200)).toBe(320);
  });

  it('gives the conversation its minimum before the sidebar its preference', () => {
    expect(browserSidebarWidth(400, 760)).toBe(336);
  });

  it('stays within the shared minimum and maximum', () => {
    expect(browserSidebarWidth(120, 1_600)).toBe(240);
    expect(browserSidebarWidth(900, 1_600)).toBe(400);
    expect(browserSidebarWidth(320, 500)).toBe(240);
  });
});

describe('browserSidebarVisible', () => {
  it('stays while the directory has not answered', () => {
    expect(browserSidebarVisible(undefined)).toBe(true);
  });

  it('leaves a lone shared Channel to open on its own', () => {
    expect(browserSidebarVisible({ spaceCount: 1, channelCount: 1 })).toBe(false);
    expect(browserSidebarVisible({ spaceCount: 0, channelCount: 1 })).toBe(false);
  });

  it('draws the sidebar when there is a Channel or a Space to choose', () => {
    expect(browserSidebarVisible({ spaceCount: 1, channelCount: 2 })).toBe(true);
    expect(browserSidebarVisible({ spaceCount: 2, channelCount: 1 })).toBe(true);
    expect(browserSidebarVisible({ spaceCount: 0, channelCount: 0 })).toBe(true);
  });
});
