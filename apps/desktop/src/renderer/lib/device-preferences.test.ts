import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEVICE_PREFERENCES_STORAGE_KEY,
  readDevicePreferences,
  setDeviceSelectedRegion,
  setDeviceWorkspaceName,
} from './device-preferences';

describe('device preferences', () => {
  beforeEach(() => window.localStorage.clear());

  it('stores renderer preferences in one versioned record', () => {
    setDeviceSelectedRegion('eu');
    setDeviceWorkspaceName('  European Research  ');

    expect(readDevicePreferences()).toEqual({
      version: 1,
      selectedRegion: 'eu',
      workspaceName: 'European Research',
    });
    expect(JSON.parse(window.localStorage.getItem(DEVICE_PREFERENCES_STORAGE_KEY)!)).toEqual({
      version: 1,
      selectedRegion: 'eu',
      workspaceName: 'European Research',
    });
  });

  it('migrates the two legacy preference keys without treating them as auth data', () => {
    window.localStorage.setItem('avalon:selected-region', 'global');
    window.localStorage.setItem('avalon:workspace-name', 'Avalon');

    expect(readDevicePreferences()).toEqual({
      version: 1,
      selectedRegion: 'global',
      workspaceName: 'Avalon',
    });
    expect(window.localStorage.getItem('avalon:selected-region')).toBeNull();
    expect(window.localStorage.getItem('avalon:workspace-name')).toBeNull();
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
