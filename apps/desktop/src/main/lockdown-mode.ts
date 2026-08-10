import type { DesktopLockdownSettings } from '../common/desktop';
import type { StoredApplicationSettings } from './application-settings';
import {
  LockdownDowngradeRequiresReloginError,
  type SessionEncryptionMode,
  type SessionSafeStorage,
} from './session-encryption';

export interface LockdownModeControllerDependencies {
  safeStorage: SessionSafeStorage;
  readSettings: () => Promise<StoredApplicationSettings>;
  writeSettings: (settings: Partial<StoredApplicationSettings>) => Promise<void>;
  migrateSession: (
    mode: SessionEncryptionMode,
    options?: { allowLockdownToGlobal?: boolean },
  ) => Promise<void>;
  recoverGlobalSessionWithoutKeystore: () => Promise<void>;
  clearCredentialsForRelogin: () => Promise<void>;
  runExclusive: <T>(operation: () => Promise<T>) => Promise<T>;
  onChange: (settings: DesktopLockdownSettings) => void;
}

export class LockdownModeController {
  private lockdownMode = false;

  constructor(private readonly dependencies: LockdownModeControllerDependencies) {}

  encryptionMode(): SessionEncryptionMode {
    return this.lockdownMode ? 'lockdown' : 'global';
  }

  state(): DesktopLockdownSettings {
    return {
      lockdownMode: this.lockdownMode,
      lockdownAvailable: this.dependencies.safeStorage.isEncryptionAvailable(),
    };
  }

  async initialize(): Promise<DesktopLockdownSettings> {
    this.lockdownMode = (await this.dependencies.readSettings()).lockdownMode;
    if (this.lockdownMode && !this.dependencies.safeStorage.isEncryptionAvailable()) {
      return this.automaticFallbackOff();
    }
    try {
      await this.dependencies.migrateSession(this.encryptionMode(), {
        allowLockdownToGlobal: false,
      });
    } catch (error) {
      if (!(error instanceof LockdownDowngradeRequiresReloginError)) throw error;
      await this.dependencies.clearCredentialsForRelogin();
    }
    return this.state();
  }

  async settings(): Promise<DesktopLockdownSettings> {
    if (!this.lockdownMode || this.dependencies.safeStorage.isEncryptionAvailable()) {
      return this.state();
    }
    return this.dependencies.runExclusive(() => {
      if (!this.lockdownMode || this.dependencies.safeStorage.isEncryptionAvailable()) {
        return Promise.resolve(this.state());
      }
      return this.automaticFallbackOff();
    });
  }

  async set(rawEnabled: unknown): Promise<DesktopLockdownSettings> {
    if (typeof rawEnabled !== 'boolean') throw new Error('Invalid Lockdown mode value');
    return this.dependencies.runExclusive(() => this.transition(rawEnabled));
  }

  private async transition(enabled: boolean): Promise<DesktopLockdownSettings> {
    if (enabled && !this.dependencies.safeStorage.isEncryptionAvailable()) {
      throw new Error('Lockdown mode requires an available operating-system keystore');
    }
    if (enabled === this.lockdownMode) return this.state();

    if (!enabled && !this.dependencies.safeStorage.isEncryptionAvailable()) {
      // The in-app toggle remains an authorized downgrade even if the
      // keystore disappeared after the session was loaded. Rebuild the global
      // envelope from main-process memory instead of unwrapping the disk copy.
      await this.dependencies.recoverGlobalSessionWithoutKeystore();
    } else {
      await this.dependencies.migrateSession(enabled ? 'lockdown' : 'global');
    }
    await this.dependencies.writeSettings({ lockdownMode: enabled });
    this.lockdownMode = enabled;
    const settings = this.state();
    this.dependencies.onChange(settings);
    return settings;
  }

  private async automaticFallbackOff(): Promise<DesktopLockdownSettings> {
    await this.dependencies.clearCredentialsForRelogin();
    await this.dependencies.writeSettings({ lockdownMode: false });
    this.lockdownMode = false;
    const settings = this.state();
    this.dependencies.onChange(settings);
    return settings;
  }
}
