import { expect, it } from 'vitest';
import { browserCanConnect, isMobileOs } from './browser-connectors';

it('offers a connection in the browser only when every capability it asks for is listed', () => {
  const allowed = ['drive.read', 'docs.read'];
  expect(browserCanConnect(['drive.read', 'docs.read'], allowed)).toBe(true);
  expect(browserCanConnect(['drive.read', 'sheets.write'], allowed)).toBe(false);
  expect(browserCanConnect([], allowed)).toBe(false);
});

it('treats phones and tablets as mobile and desktops as not', () => {
  expect(isMobileOs('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', 'iPhone', 5)).toBe(true);
  expect(isMobileOs('Mozilla/5.0 (Linux; Android 15; Pixel 9)', 'Linux armv8l', 5)).toBe(true);
  expect(isMobileOs('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 'MacIntel', 5)).toBe(true);
  expect(isMobileOs('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 'MacIntel', 0)).toBe(false);
  expect(isMobileOs('Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Win32', 0)).toBe(false);
});
