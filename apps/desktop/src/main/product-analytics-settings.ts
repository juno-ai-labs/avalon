import type { StoredApplicationSettings } from './application-settings';

export interface ProductAnalyticsSettingsState {
  desiredEnabled: boolean;
  effectiveEnabled: boolean;
  pending: boolean;
}

export interface ProductAnalyticsSettingsDependencies {
  readSettings: () => Promise<StoredApplicationSettings>;
  writeSettings: (settings: Partial<StoredApplicationSettings>) => Promise<void>;
  syncPreference: (enabled: boolean, expectedVersion: number) => Promise<{
    enabled: boolean;
    version: number;
  }>;
  readPreference: () => Promise<{ enabled: boolean; version: number }>;
  invalidateNativeCrashGeneration: () => Promise<void>;
  purgeNonessentialSpool: () => Promise<void>;
  onChange: (state: ProductAnalyticsSettingsState) => void;
}

/**
 * Owns the one nonessential telemetry control. A disable is written locally
 * before any network call. An enable is deliberately ineffective until the
 * account service acknowledges its monotonic version.
 */
export class ProductAnalyticsSettingsController {
  private desiredEnabled = true;
  private preferenceVersion = 0;
  private pending = false;
  private remoteVerified = true;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly dependencies: ProductAnalyticsSettingsDependencies) {}

  state(): ProductAnalyticsSettingsState {
    return {
      desiredEnabled: this.desiredEnabled,
      effectiveEnabled: this.desiredEnabled && !this.pending && this.remoteVerified,
      pending: this.pending,
    };
  }

  /**
   * Whether nonessential events may enter the local spool while canonical
   * verification is in flight. Transmission still uses `effectiveEnabled`.
   * A pending explicit enable is not admission: it has never been accepted by
   * the account service, while a durable same-account enable has.
   */
  admissionEnabled(): boolean {
    return this.desiredEnabled && !this.pending;
  }

  async initialize(requireRemoteVerification = false): Promise<ProductAnalyticsSettingsState> {
    this.remoteVerified = !requireRemoteVerification;
    const stored = await this.dependencies.readSettings();
    this.desiredEnabled = stored.productAnalyticsEnabled;
    this.preferenceVersion = stored.productAnalyticsPreferenceVersion;
    this.pending = stored.productAnalyticsPreferencePending;
    return this.state();
  }

  async requireRemoteVerification(): Promise<ProductAnalyticsSettingsState> {
    this.remoteVerified = false;
    this.dependencies.onChange(this.state());
    await Promise.all([
      this.dependencies.invalidateNativeCrashGeneration(),
      this.dependencies.purgeNonessentialSpool(),
    ]);
    return this.state();
  }

  async set(rawEnabled: unknown): Promise<ProductAnalyticsSettingsState> {
    if (typeof rawEnabled !== 'boolean') throw new Error('Invalid Product analytics value');
    const applied = this.queue.then(() => this.apply(rawEnabled), () => this.apply(rawEnabled));
    this.queue = applied.catch(() => undefined);
    return applied;
  }

  async retryPending(): Promise<ProductAnalyticsSettingsState> {
    if (!this.pending) return this.state();
    const applied = this.queue.then(
      () => this.synchronize(),
      () => this.synchronize(),
    );
    this.queue = applied.catch(() => undefined);
    return applied;
  }

  async refresh(): Promise<ProductAnalyticsSettingsState> {
    if (this.pending) return this.retryPending();
    const remote = await this.dependencies.readPreference();
    if (!Number.isSafeInteger(remote.version) || remote.version <= 0) {
      throw new Error('Invalid Product analytics preference version');
    }
    if (remote.version === this.preferenceVersion && remote.enabled === this.desiredEnabled) {
      this.remoteVerified = true;
      this.dependencies.onChange(this.state());
      return this.state();
    }
    await this.dependencies.writeSettings({
      productAnalyticsEnabled: remote.enabled,
      productAnalyticsPreferenceVersion: remote.version,
      productAnalyticsPreferencePending: false,
    });
    this.desiredEnabled = remote.enabled;
    this.preferenceVersion = remote.version;
    this.pending = false;
    this.remoteVerified = true;
    if (!remote.enabled) {
      await Promise.all([
        this.dependencies.invalidateNativeCrashGeneration(),
        this.dependencies.purgeNonessentialSpool(),
      ]);
    }
    this.dependencies.onChange(this.state());
    return this.state();
  }

  private async apply(enabled: boolean): Promise<ProductAnalyticsSettingsState> {
    if (enabled !== this.desiredEnabled || !this.pending) {
      await this.dependencies.writeSettings({
        productAnalyticsEnabled: enabled,
        productAnalyticsPreferencePending: true,
      });
      this.desiredEnabled = enabled;
      this.pending = true;
      if (!enabled) {
        await Promise.all([
          this.dependencies.invalidateNativeCrashGeneration(),
          this.dependencies.purgeNonessentialSpool(),
        ]);
      }
      this.dependencies.onChange(this.state());
    }
    return this.synchronize();
  }

  private async synchronize(): Promise<ProductAnalyticsSettingsState> {
    const acknowledged = await this.dependencies.syncPreference(
      this.desiredEnabled,
      this.preferenceVersion,
    );
    if (!Number.isSafeInteger(acknowledged.version) || acknowledged.version <= this.preferenceVersion) {
      throw new Error('Invalid Product analytics preference version');
    }
    await this.dependencies.writeSettings({
      productAnalyticsEnabled: acknowledged.enabled,
      productAnalyticsPreferenceVersion: acknowledged.version,
      productAnalyticsPreferencePending: false,
    });
    this.desiredEnabled = acknowledged.enabled;
    this.preferenceVersion = acknowledged.version;
    this.pending = false;
    this.remoteVerified = true;
    this.dependencies.onChange(this.state());
    return this.state();
  }
}
