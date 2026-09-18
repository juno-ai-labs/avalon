import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { defaultThemeChoice, parseThemeChoice, type ThemeChoice } from '../common/themes';
import {
  defaultDesktopReleaseChannel,
  parseDesktopReleaseChannel,
  type DesktopReleaseChannel,
} from '../common/release-channels';

const APPLICATION_SETTINGS_FILE_NAME = 'application-settings.json';

export interface StoredApplicationSettings {
  pushNotificationsEnabled: boolean;
  pushInstallationId: string | null;
  lockdownMode: boolean;
  debugEnabled: boolean;
  /** Whether the Rally status item is in the macOS menu bar. */
  menuBarEnabled: boolean;
  /**
   * Whether the enabled-by-default login item has been registered once. The
   * operating system, not this file, remembers whether Rally opens at login;
   * this only records that the default was applied, so a person who turns the
   * login item off does not get it switched back on by the next launch.
   */
  launchAtLoginDefaultApplied: boolean;
  /** Desired account choice. Collection is effective only when this is true
   * and the corresponding mutation is not pending acknowledgement. */
  productAnalyticsEnabled: boolean;
  /** Last canonical account version acknowledged by the regional API. */
  productAnalyticsPreferenceVersion: number;
  /** A durable offline mutation. Both enable and disable fail closed while set. */
  productAnalyticsPreferencePending: boolean;
  /** Which server-owned desktop release pointer this Mac follows. */
  releaseChannel: DesktopReleaseChannel;
  /**
   * The theme *choice* the renderer last drew, mirrored here for one purpose: a
   * window's `backgroundColor` has to be chosen before any renderer exists to
   * ask. The renderer's own copy in `localStorage` stays authoritative, so a
   * disagreement between the two resolves itself on the next report.
   *
   * Both axes, not the appearance they resolved to. Under `system` the
   * appearance depends on what the Mac is set to when it is read, and that is
   * not the same moment across a quit and a relaunch — storing the resolved
   * value meant a Mac that changed appearance overnight opened the first window
   * of the next launch in yesterday's colour and corrected itself once the
   * renderer ran, which is the flash this field exists to prevent.
   */
  themeChoice: ThemeChoice;
}

interface StoredApplicationSettingsFile extends StoredApplicationSettings {
  version: 1;
}

export const defaultStoredApplicationSettings: StoredApplicationSettings = {
  pushNotificationsEnabled: true,
  pushInstallationId: null,
  lockdownMode: false,
  debugEnabled: false,
  menuBarEnabled: true,
  launchAtLoginDefaultApplied: false,
  productAnalyticsEnabled: true,
  productAnalyticsPreferenceVersion: 0,
  productAnalyticsPreferencePending: false,
  releaseChannel: defaultDesktopReleaseChannel,
  themeChoice: defaultThemeChoice,
};

export function parseStoredApplicationSettings(value: unknown): StoredApplicationSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return defaultStoredApplicationSettings;
  }
  const candidate = value as {
    version?: unknown;
    pushNotificationsEnabled?: unknown;
    pushInstallationId?: unknown;
    lockdownMode?: unknown;
    debugEnabled?: unknown;
    menuBarEnabled?: unknown;
    launchAtLoginDefaultApplied?: unknown;
    productAnalyticsEnabled?: unknown;
    productAnalyticsPreferenceVersion?: unknown;
    productAnalyticsPreferencePending?: unknown;
    releaseChannel?: unknown;
    themeChoice?: unknown;
  };
  if (candidate.version !== 1 || typeof candidate.lockdownMode !== 'boolean') {
    return defaultStoredApplicationSettings;
  }
  // Preferences written before the Developer section carry no debug field. An
  // unreadable value falls back to off rather than discarding Lockdown mode.
  return {
    pushNotificationsEnabled: candidate.pushNotificationsEnabled !== false,
    pushInstallationId: typeof candidate.pushInstallationId === "string" ? candidate.pushInstallationId : null,
    lockdownMode: candidate.lockdownMode,
    debugEnabled: candidate.debugEnabled === true,
    // The menu bar item ships on, so a file written before it existed — and any
    // unreadable value — has to mean on. Reading it as off would silently
    // withdraw the status item from every device that upgraded.
    menuBarEnabled: candidate.menuBarEnabled !== false,
    launchAtLoginDefaultApplied: candidate.launchAtLoginDefaultApplied === true,
    productAnalyticsEnabled: typeof candidate.productAnalyticsEnabled === 'boolean'
      ? candidate.productAnalyticsEnabled
      : true,
    productAnalyticsPreferenceVersion: typeof candidate.productAnalyticsPreferenceVersion === 'number'
      && Number.isSafeInteger(candidate.productAnalyticsPreferenceVersion)
      && candidate.productAnalyticsPreferenceVersion >= 0
      ? candidate.productAnalyticsPreferenceVersion
      : 0,
    productAnalyticsPreferencePending: candidate.productAnalyticsPreferencePending === true,
    releaseChannel: parseDesktopReleaseChannel(candidate.releaseChannel) ?? defaultDesktopReleaseChannel,
    // A file written before themes existed, or naming one this build removed,
    // means the design Rally shipped with, following the Mac.
    themeChoice: parseThemeChoice(candidate.themeChoice) ?? defaultThemeChoice,
  };
}

export function applicationSettingsFilePath(userDataDirectory: string): string {
  return join(userDataDirectory, APPLICATION_SETTINGS_FILE_NAME);
}

export async function readStoredApplicationSettings(
  userDataDirectory: string,
): Promise<StoredApplicationSettings> {
  try {
    const encoded = await readFile(applicationSettingsFilePath(userDataDirectory), 'utf8');
    return parseStoredApplicationSettings(JSON.parse(encoded) as unknown);
  } catch (error) {
    if (error instanceof SyntaxError) return defaultStoredApplicationSettings;
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return defaultStoredApplicationSettings;
    }
    throw error;
  }
}

export async function writeStoredApplicationSettings(
  userDataDirectory: string,
  settings: StoredApplicationSettings,
): Promise<void> {
  await mkdir(userDataDirectory, { recursive: true, mode: 0o700 });
  const preferencePath = applicationSettingsFilePath(userDataDirectory);
  const temporaryPath = `${preferencePath}.${process.pid}.${randomUUID()}.tmp`;
  const stored: StoredApplicationSettingsFile = { version: 1, ...settings };
  try {
    await writeFile(temporaryPath, `${JSON.stringify(stored)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    await rename(temporaryPath, preferencePath);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

// One shared queue for every patch, because the read-merge-write below is only
// atomic against callers it is serialized with. The file's two owners —
// Lockdown mode, under the session-mutation lock, and the Developer section,
// under its own — serialize against themselves but not each other, so a Debug
// toggle committed during a Lockdown transition could read the pre-transition
// snapshot and then rename a document that drops `lockdownMode`. The next
// launch reads that off preference against a Lockdown envelope as an external
// downgrade and deletes the stored credentials. Serializing here rather than at
// the call sites keeps a future preference owner from reintroducing it.
let applicationSettingsWrites: Promise<unknown> = Promise.resolve();

/** Rewrites one preference without disturbing the others. Lockdown mode and
 * the Developer preference share a file but not an owner, so neither may write
 * the whole document from its own state. */
export async function updateStoredApplicationSettings(
  userDataDirectory: string,
  patch: Partial<StoredApplicationSettings>,
): Promise<void> {
  const merge = (): Promise<void> => mergeStoredApplicationSettings(userDataDirectory, patch);
  // A failed patch must not poison the queue for the next one.
  const applied = applicationSettingsWrites.then(merge, merge);
  applicationSettingsWrites = applied.catch(() => undefined);
  await applied;
}

async function mergeStoredApplicationSettings(
  userDataDirectory: string,
  patch: Partial<StoredApplicationSettings>,
): Promise<void> {
  const current = await readStoredApplicationSettings(userDataDirectory);
  await writeStoredApplicationSettings(userDataDirectory, { ...current, ...patch });
}
