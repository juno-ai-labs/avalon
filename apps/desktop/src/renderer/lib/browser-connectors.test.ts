import { expect, it } from 'vitest';
import { isMobileOs } from './browser-connectors';

it('treats phones and tablets as mobile and desktops as not', () => {
  expect(isMobileOs('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', 'iPhone', 5)).toBe(true);
  expect(isMobileOs('Mozilla/5.0 (Linux; Android 15; Pixel 9)', 'Linux armv8l', 5)).toBe(true);
  expect(isMobileOs('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 'MacIntel', 5)).toBe(true);
  expect(isMobileOs('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 'MacIntel', 0)).toBe(false);
  expect(isMobileOs('Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Win32', 0)).toBe(false);
});
