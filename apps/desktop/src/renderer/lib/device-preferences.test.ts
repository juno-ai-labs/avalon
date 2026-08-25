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
  beforeEach(() => window.localStorage.clear());

  it('stores renderer preferences in one versioned record', () => {
    setDeviceSelectedRegion('eu');
    setDeviceWorkspaceName('  European Research  ');
    setDeviceMicrophoneId('  microphone-42  ');

    expect(readDevicePreferences()).toEqual({
      version: 1,
      selectedRegion: 'eu',
      workspaceName: 'European Research',
      microphoneDeviceId: 'microphone-42',
    });
    expect(JSON.parse(window.localStorage.getItem(DEVICE_PREFERENCES_STORAGE_KEY)!)).toEqual({
      version: 1,
      selectedRegion: 'eu',
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

  it('keeps the chosen theme beside the other preferences', () => {
    setDeviceSelectedRegion('global');
    setDeviceTheme({ family: 'air', mode: 'dark' });

    expect(readDevicePreferences())
      .toEqual({ version: 1, selectedRegion: 'global', theme: { family: 'air', mode: 'dark' } });
  });

  /**
   * A theme a later build removed — or an older build reading a newer file —
   * costs the person that one preference and nothing else. Rejecting the whole
   * document would take their region and microphone with it, which is a far
   * worse outcome than an appearance reverting to the default.
   */
  it('drops an unknown theme without discarding the rest of the record', () => {
    window.localStorage.setItem(DEVICE_PREFERENCES_STORAGE_KEY, JSON.stringify({
      version: 1,
      selectedRegion: 'eu',
      microphoneDeviceId: 'microphone-42',
      theme: 'sepia',
    }));

    expect(readDevicePreferences()).toEqual({
      version: 1,
      selectedRegion: 'eu',
      microphoneDeviceId: 'microphone-42',
    });
  });

  it('ignores incompatible preference versions and allows the region to be cleared', () => {
    window.localStorage.setItem(DEVICE_PREFERENCES_STORAGE_KEY, JSON.stringify({
      version: 2,
      selectedRegion: 'eu',
    }));

    expect(readDevicePreferences()).toEqual({ version: 1 });
    setDeviceSelectedRegion('global');
    setDeviceSelectedRegion(null);
    expect(readDevicePreferences()).toEqual({ version: 1 });
  });
});
