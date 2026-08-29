import { describe, expect, it } from 'vitest';
import google from 'thesvg/google';
import slack from 'thesvg/slack';
import { PLUGIN_BRAND_MARKS } from './plugin-marks';

const decode = (mask: string): string =>
  decodeURIComponent(mask.replace(/^url\("data:image\/svg\+xml,/u, '').replace(/"\)$/u, ''));

describe('PLUGIN_BRAND_MARKS', () => {
  it('hands CSS a mask rather than markup for every brand', () => {
    for (const [slug, mask] of Object.entries(PLUGIN_BRAND_MARKS)) {
      expect(mask, slug).toMatch(/^url\("data:image\/svg\+xml,/u);
      expect(decode(mask), slug).toContain('<svg');
    }
  });

  it('prefers the monochrome art, because a mask reads only alpha', () => {
    // Google's colour mark is a solid four-colour silhouette; masked, it is a
    // filled blob rather than the outlined G. Its mono variant is the outline,
    // and every brand that ships one is treated the same way.
    expect(decode(PLUGIN_BRAND_MARKS.google)).toBe(google.variants['mono']);
    expect(decode(PLUGIN_BRAND_MARKS.google)).not.toBe(google.svg);
  });

  it('falls back to the colour art for a brand that ships no monochrome variant', () => {
    // Slack's colour art is four flat paths whose alpha is the same shape a
    // monochrome treatment would be, so the mask loses nothing.
    expect(slack.variants['mono']).toBeUndefined();
    expect(decode(PLUGIN_BRAND_MARKS.slack)).toBe(slack.svg);
  });

  it('draws a different mark for every brand', () => {
    const marks = Object.values(PLUGIN_BRAND_MARKS);
    expect(new Set(marks).size).toBe(marks.length);
  });
});
