import { isConfiguredRegion } from "@rally/contracts/regions";
import { parseThemeChoice, type ThemeChoice } from '../themes';
import type { Region } from '@rally/contracts/regions';

export const DEVICE_PREFERENCES_STORAGE_KEY = 'rally:device-preferences';
const LEGACY_REGION_STORAGE_KEY = 'rally:selected-region';
const LEGACY_WORKSPACE_NAME_STORAGE_KEY = 'rally:workspace-name';

export interface DevicePreferences {
  version: 1;
  selectedRegion?: Region;
  workspaceName?: string;
  microphoneDeviceId?: string;
  /** Absent means the theme has never been chosen, which is not the same as
   * having chosen `system` mode: only the latter survives a change of default.
   * A string here is the flat pre-family shape and is migrated on read. */
  theme?: ThemeChoice;
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
    const microphoneDeviceId = candidate['microphoneDeviceId'];
    const theme = parseThemeChoice(candidate['theme']);
    if (workspaceName !== undefined && typeof workspaceName !== 'string') return null;
    if (microphoneDeviceId !== undefined && typeof microphoneDeviceId !== 'string') return null;
    return {
      version: 1,
      ...(isConfiguredRegion(selectedRegion) ? { selectedRegion } : {}),
      ...(typeof workspaceName === 'string' ? { workspaceName: workspaceName.trim() } : {}),
      ...(typeof microphoneDeviceId === 'string' && microphoneDeviceId.trim()
        ? { microphoneDeviceId: microphoneDeviceId.trim() }
        : {}),
      // An unrecognised theme is dropped rather than rejecting the whole
      // document: a build that removes a theme must not also cost the person
      // their region and microphone.
      ...(theme ? { theme } : {}),
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
    ...(isConfiguredRegion(legacyRegion) ? { selectedRegion: legacyRegion } : {}),
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

export function setDeviceTheme(theme: ThemeChoice): void {
  const preferences = readDevicePreferences();
  preferences.theme = theme;
  writeDevicePreferences(preferences);
}

export function setDeviceMicrophoneId(microphoneDeviceId: string): void {
  const preferences = readDevicePreferences();
  preferences.microphoneDeviceId = microphoneDeviceId.trim() || 'default';
  writeDevicePreferences(preferences);
}
