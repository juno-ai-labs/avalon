// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { DISABLE_AUTO_UPDATE_ENV, updatePolicy } from './update-policy';

const supported = {
  isPackaged: true,
  platform: 'darwin' as NodeJS.Platform,
  arch: 'arm64',
  env: {},
};

describe('desktop auto-update policy', () => {
  it('enables only the packaged Apple-silicon macOS app', () => {
    expect(updatePolicy(supported)).toEqual({ kind: 'enabled' });
  });

  it.each([
    [{ ...supported, isPackaged: false }, 'not a packaged build'],
    [{ ...supported, platform: 'win32' as NodeJS.Platform }, "unsupported platform 'win32'"],
    [{ ...supported, arch: 'x64' }, "unsupported architecture 'x64'"],
    [{ ...supported, env: { [DISABLE_AUTO_UPDATE_ENV]: '1' } }, `${DISABLE_AUTO_UPDATE_ENV} is set`],
  ])('disables unsupported runtime %#', (input, reason) => {
    expect(updatePolicy(input)).toEqual({ kind: 'disabled', reason });
  });
});
