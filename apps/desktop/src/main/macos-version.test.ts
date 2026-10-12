import { expect, it } from 'vitest';
import { macosMajorVersion } from './macos-version';

it('reads the major version, and 0 when it cannot', () => {
  expect(macosMajorVersion('26.1')).toBe(26);
  expect(macosMajorVersion('15.6.1')).toBe(15);
  expect(macosMajorVersion('')).toBe(0);
});
