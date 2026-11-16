import { describe, expect, it } from 'vitest';

import { dynamicTypeSizes, isDynamicTypeHost, typeScaleWrites } from '../src/dynamic-type';

const defaults = {
  'caption-2': 11, 'caption-1': 12, footnote: 13, subheadline: 15, callout: 16, body: 17,
  headline: 17, 'title-3': 20, 'title-2': 22, 'title-1': 28, 'large-title': 34, display: 38,
};

describe('dynamicTypeSizes', () => {
  it('takes each style the engine measures, moves callout with body, and the large titles with title 1', () => {
    // iOS's "xxxLarge" setting: body 23, the small styles grow less than body does.
    const measured: Record<string, number> = {
      '-apple-system-body': 23, '-apple-system-caption2': 15, '-apple-system-caption1': 16, '-apple-system-footnote': 17,
      '-apple-system-subheadline': 21, '-apple-system-headline': 23, '-apple-system-title3': 26, '-apple-system-title2': 28, '-apple-system-title1': 34,
    };
    expect(dynamicTypeSizes(defaults, (keyword) => measured[keyword] ?? null)).toEqual({
      'caption-2': 15, 'caption-1': 16, footnote: 17, subheadline: 21, callout: 21.5, body: 23,
      headline: 23, 'title-3': 26, 'title-2': 28, 'title-1': 34, 'large-title': 41.5, display: 46,
    });
  });

  it('moves every role with body when the engine supports only body', () => {
    const sizes = dynamicTypeSizes(defaults, (keyword) => (keyword === '-apple-system-body' ? 19 : null));
    expect(sizes).toMatchObject({ 'caption-2': 12.5, body: 19, 'title-1': 31.5, 'large-title': 38 });
  });

  it('sets nothing when a design value cannot be read', () => {
    expect(dynamicTypeSizes({ ...defaults, footnote: Number.NaN }, () => 20)).toBeNull();
  });

  it('sets nothing when body cannot be measured', () => {
    expect(dynamicTypeSizes(defaults, () => null)).toBeNull();
  });
});

describe('isDynamicTypeHost', () => {
  it('is true on iOS, including an iPad that reports a touch Mac, and false elsewhere', () => {
    expect(isDynamicTypeHost('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', 'iPhone', 5)).toBe(true);
    expect(isDynamicTypeHost('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 'MacIntel', 5)).toBe(true);
    expect(isDynamicTypeHost('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 'MacIntel', 0)).toBe(false);
    expect(isDynamicTypeHost('Mozilla/5.0 (Linux; Android 15; Pixel 9)', 'Linux armv8l', 5)).toBe(false);
  });
});

describe('typeScaleWrites', () => {
  const sizes = { ...defaults };
  const px = (values: Record<string, number>) => (name: string) => `${values[name.replace('--av-sys-type-', '')]}px`;

  it('writes nothing when every role already has its size', () => {
    expect(typeScaleWrites(px(defaults), sizes)).toEqual([]);
  });

  it('writes only the role that changed', () => {
    expect(typeScaleWrites(px(defaults), { ...sizes, body: 19 })).toEqual([['--av-sys-type-body', '19px']]);
  });
});
