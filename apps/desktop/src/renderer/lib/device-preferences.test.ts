import "../../../../../tests/isolated-region";
import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEVICE_PREFERENCES_STORAGE_KEY,
  readDevicePreferences,
  setDeviceSelectedRegion,
  setDeviceMicrophoneId,
  setDeviceTheme,
  setDeviceWorkspaceName,
} from './device-preferences';

describe('device preferences', () => {
  it('drops a retired deployment while preserving the other device preferences', () => {
    window.localStorage.setItem(DEVICE_PREFERENCES_STORAGE_KEY, JSON.stringify({
      version: 1, selectedRegion: 'retired-deployment', workspaceName: 'Research',
      microphoneDeviceId: 'mic-1', theme: { family: 'default', mode: 'dark' },
    }));
    expect(readDevicePreferences()).toMatchObject({
      version: 1, workspaceName: 'Research', microphoneDeviceId: 'mic-1', theme: 'dark',
    });
    expect(readDevicePreferences().selectedRegion).toBeUndefined();
  });

  beforeEach(() => window.localStorage.clear());

  it('stores renderer preferences in one versioned record', () => {
    setDeviceSelectedRegion('enterprise');
    setDeviceWorkspaceName('  European Research  ');
    setDeviceMicrophoneId('  microphone-42  ');

    expect(readDevicePreferences()).toEqual({
      version: 1,
      selectedRegion: 'enterprise',
      workspaceName: 'European Research',
      microphoneDeviceId: 'microphone-42',
    });
    expect(JSON.parse(window.localStorage.getItem(DEVICE_PREFERENCES_STORAGE_KEY)!)).toEqual({
      version: 1,
      selectedRegion: 'enterprise',
      workspaceName: 'European Research',
      microphoneDeviceId: 'microphone-42',
    });
  });

  it('migrates the two legacy preference keys without treating them as auth data', () => {
    window.localStorage.setItem('rally:selected-region', 'global');
    window.localStorage.setItem('rally:workspace-name', 'Rally');

    expect(readDevicePreferences()).toEqual({
      version: 1,
      selectedRegion: 'global',
      workspaceName: 'Rally',
    });
    expect(window.localStorage.getItem('rally:selected-region')).toBeNull();
    expect(window.localStorage.getItem('rally:workspace-name')).toBeNull();
  });

  it('keeps the chosen appearance beside the other preferences', () => {
    setDeviceSelectedRegion('global');
    setDeviceTheme('dark');

    expect(readDevicePreferences())
      .toEqual({ version: 1, selectedRegion: 'global', theme: 'dark' });
  });

  /**
   * An appearance a later build cannot read — or an older build reading a newer file —
   * costs the person that one preference and nothing else. Rejecting the whole
   * document would take their region and microphone with it, which is a far
   * worse outcome than an appearance reverting to the default.
   */
  it('drops an unknown appearance without discarding the rest of the record', () => {
    window.localStorage.setItem(DEVICE_PREFERENCES_STORAGE_KEY, JSON.stringify({
      version: 1,
      selectedRegion: 'enterprise',
      microphoneDeviceId: 'microphone-42',
      theme: 'sepia',
    }));

    expect(readDevicePreferences()).toEqual({
      version: 1,
      selectedRegion: 'enterprise',
      microphoneDeviceId: 'microphone-42',
    });
  });

  it('ignores incompatible preference versions and allows the region to be cleared', () => {
    window.localStorage.setItem(DEVICE_PREFERENCES_STORAGE_KEY, JSON.stringify({
      version: 2,
      selectedRegion: 'enterprise',
    }));

    expect(readDevicePreferences()).toEqual({ version: 1 });
    setDeviceSelectedRegion('global');
    setDeviceSelectedRegion(null);
    expect(readDevicePreferences()).toEqual({ version: 1 });
  });
});
