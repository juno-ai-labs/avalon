import type { Region } from './types';

export const DEVICE_PREFERENCES_STORAGE_KEY = 'avalon:device-preferences';
const LEGACY_REGION_STORAGE_KEY = 'avalon:selected-region';
const LEGACY_WORKSPACE_NAME_STORAGE_KEY = 'avalon:workspace-name';

export interface DevicePreferences {
  version: 1;
  selectedRegion?: Region;
  workspaceName?: string;
}

function parsedPreferences(value: string | null): DevicePreferences | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const candidate = parsed as Record<string, unknown>;
    if (candidate['version'] !== 1) return null;
    const selectedRegion = candidate['selectedRegion'];
    const workspaceName = candidate['workspaceName'];
    if (selectedRegion !== undefined && selectedRegion !== 'global' && selectedRegion !== 'eu') return null;
    if (workspaceName !== undefined && typeof workspaceName !== 'string') return null;
    return {
      version: 1,
      ...(selectedRegion ? { selectedRegion } : {}),
      ...(typeof workspaceName === 'string' ? { workspaceName: workspaceName.trim() } : {}),
    };
  } catch {
    return null;
  }
}

function writeDevicePreferences(preferences: DevicePreferences): void {
  window.localStorage.setItem(DEVICE_PREFERENCES_STORAGE_KEY, JSON.stringify(preferences));
}

export function readDevicePreferences(): DevicePreferences {
  const stored = parsedPreferences(window.localStorage.getItem(DEVICE_PREFERENCES_STORAGE_KEY));
  if (stored) return stored;

  const legacyRegion = window.localStorage.getItem(LEGACY_REGION_STORAGE_KEY);
  const legacyWorkspaceName = window.localStorage.getItem(LEGACY_WORKSPACE_NAME_STORAGE_KEY)?.trim();
  const migrated: DevicePreferences = {
    version: 1,
    ...(legacyRegion === 'global' || legacyRegion === 'eu' ? { selectedRegion: legacyRegion } : {}),
    ...(legacyWorkspaceName !== undefined ? { workspaceName: legacyWorkspaceName } : {}),
  };
  if (migrated.selectedRegion !== undefined || migrated.workspaceName !== undefined) {
    writeDevicePreferences(migrated);
    window.localStorage.removeItem(LEGACY_REGION_STORAGE_KEY);
    window.localStorage.removeItem(LEGACY_WORKSPACE_NAME_STORAGE_KEY);
  }
  return migrated;
}

export function setDeviceSelectedRegion(selectedRegion: Region | null): void {
  const preferences = readDevicePreferences();
  if (selectedRegion === null) delete preferences.selectedRegion;
  else preferences.selectedRegion = selectedRegion;
  writeDevicePreferences(preferences);
}

export function setDeviceWorkspaceName(workspaceName: string): void {
  const preferences = readDevicePreferences();
  preferences.workspaceName = workspaceName.trim();
  writeDevicePreferences(preferences);
}
