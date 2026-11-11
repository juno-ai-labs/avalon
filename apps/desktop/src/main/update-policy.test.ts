import { describe, expect, it } from 'vitest';
import { DISABLE_AUTO_UPDATE_ENV, updatePolicy } from './update-policy';

const supported = {
  isPackaged: true,
  platform: 'darwin' as NodeJS.Platform,
  arch: 'arm64',
  env: {},
};

describe('desktop auto-update policy', () => {
  it('enables the packaged Apple-silicon macOS app', () => {
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

  it('enables Linux x64 AppImage and Debian updates, but refuses unpacked directories and other architectures', () => {
    const linux = { ...supported, platform: 'linux' as const, arch: 'x64' };
    expect(updatePolicy({ ...linux, env: { APPIMAGE: '/home/me/Rally.AppImage' } })).toEqual({ kind: 'enabled' });
    expect(updatePolicy({ ...linux, linuxPackageType: 'deb' })).toEqual({ kind: 'enabled' });
    expect(updatePolicy(linux)).toEqual({ kind: 'disabled', reason: 'not an AppImage or Debian installation' });
    expect(updatePolicy({ ...linux, linuxPackageType: 'deb', arch: 'arm64' })).toEqual({ kind: 'disabled', reason: "unsupported architecture 'arm64'" });
    expect(updatePolicy({ ...linux, env: { APPIMAGE: '/app', RALLY_DISABLE_AUTO_UPDATE: '1' } })).toEqual({ kind: 'disabled', reason: 'RALLY_DISABLE_AUTO_UPDATE is set' });
  });
});
