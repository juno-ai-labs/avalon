import type { StoredApplicationSettings } from './application-settings';

export interface DebugSettingsControllerDependencies {
  readSettings: () => Promise<StoredApplicationSettings>;
  writeSettings: (settings: Partial<StoredApplicationSettings>) => Promise<void>;
  onChange: (debugEnabled: boolean) => void;
}

/**
 * Owns the Developer → Debug enabled preference. Unlike Lockdown mode it moves
 * no credential and relaxes no trust boundary — it only reveals debugging
 * affordances such as resource identifiers — so it needs no session-mutation
 * lock. Its writes are still serialized against each other because the
 * preference file is read, merged, and rewritten on every change.
 */
export class DebugSettingsController {
  private debugEnabled = false;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly dependencies: DebugSettingsControllerDependencies) {}

  enabled(): boolean {
    return this.debugEnabled;
  }

  async initialize(): Promise<boolean> {
    this.debugEnabled = (await this.dependencies.readSettings()).debugEnabled;
    return this.debugEnabled;
  }

  async set(rawEnabled: unknown): Promise<boolean> {
    if (typeof rawEnabled !== 'boolean') throw new Error('Invalid Debug enabled value');
    const enabled = rawEnabled;
    const applied = this.queue.then(() => this.apply(enabled), () => this.apply(enabled));
    this.queue = applied.catch(() => undefined);
    return applied;
  }

  private async apply(enabled: boolean): Promise<boolean> {
    if (enabled === this.debugEnabled) return this.debugEnabled;
    await this.dependencies.writeSettings({ debugEnabled: enabled });
    this.debugEnabled = enabled;
    this.dependencies.onChange(this.debugEnabled);
    return this.debugEnabled;
  }
}
