import { expect, it } from 'vitest';
import { mixOklab } from './color-mix';

// Expected values are Chromium's own `color-mix(in oklab, …)` for the same inputs.
it('matches CSS color-mix in oklab', () => {
  expect(mixOklab('#06b6d4', '#c3f1fd', 0)).toBe('#c3f1fd');
  expect(mixOklab('#06b6d4', '#c3f1fd', 1)).toBe('#06b6d4');
  expect(mixOklab('#000000', '#ffffff', 0.5)).toBe('#636363');
  // The lead card's gradient end: 20% of the hue into its pastel tint, light and dark.
  expect(mixOklab('#06b6d4', '#c3f1fd', 0.2)).toBe('#a8e5f5');
  expect(mixOklab('#06b6d4', '#014552', 0.2)).toBe('#025a6a');
  expect(mixOklab('#22c55e', '#d1fae5', 0.2)).toBe('#b5f0cb');
});
