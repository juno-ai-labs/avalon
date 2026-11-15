import { describe, expect, it } from 'vitest';

import { dynamicTypeSizes } from '../src/dynamic-type';

const defaults = {
  'caption-2': 11, 'caption-1': 12, footnote: 13, subheadline: 15, callout: 16, body: 17,
  headline: 17, 'title-3': 20, 'title-2': 22, 'title-1': 28, 'large-title': 34, display: 38,
};

describe('dynamicTypeSizes', () => {
  it('takes each style the engine measures, and moves the rest with body', () => {
    // iOS's "xxxLarge" setting: body 23, the small styles grow less than body does.
    const measured: Record<string, number> = {
      '-apple-system-body': 23, '-apple-system-caption2': 15, '-apple-system-caption1': 16, '-apple-system-footnote': 17,
      '-apple-system-subheadline': 21, '-apple-system-headline': 23, '-apple-system-title3': 26, '-apple-system-title2': 28, '-apple-system-title1': 34,
    };
    expect(dynamicTypeSizes(defaults, (keyword) => measured[keyword] ?? null)).toEqual({
      'caption-2': 15, 'caption-1': 16, footnote: 17, subheadline: 21, callout: 21.5, body: 23,
      headline: 23, 'title-3': 26, 'title-2': 28, 'title-1': 34, 'large-title': 46, display: 51.5,
    });
  });

  it('moves every role with body when the engine supports only body', () => {
    const sizes = dynamicTypeSizes(defaults, (keyword) => (keyword === '-apple-system-body' ? 19 : null));
    expect(sizes).toMatchObject({ 'caption-2': 12.5, body: 19, 'title-1': 31.5 });
  });

  it('sets nothing when body cannot be measured', () => {
    expect(dynamicTypeSizes(defaults, () => null)).toBeNull();
  });
});
