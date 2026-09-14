import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { app, pushNotifications } from 'electron';
import { ClientFeatureFlagsSchema } from '@rally/contracts';
import { APNS_TOPICS, PushNotificationDataSchema } from '@rally/contracts/push-notifications';
import { readStoredApplicationSettings, updateStoredApplicationSettings } from './application-settings';
import type { StoredAuth } from './stored-auth';

interface NativePushBridge { start(callback: (encoded: string) => void): void; permission(request: boolean): void }
interface PushDependencies {
  credentials(): Promise<StoredAuth[]>;
  request(credential: StoredAuth, path: string, init?: RequestInit): Promise<Response>;
  clicked(url: string | null): void;
  changed(): void;
  warn(): void;
}
export class DesktopPushNotifications {
  private bridge: NativePushBridge | null = null;
  private token: string | null = null;
  private installationId: string | null = null;
  private enabled = true;
  private permission = 'unavailable';
  private serial: Promise<void> = Promise.resolve();
  private stopped = false;
  private reconciling = false;
  constructor(private readonly dependencies: PushDependencies) {}
  state() { return { pushNotificationsEnabled: this.enabled, pushNotificationStatus: this.permission }; }
  async initialize(): Promise<void> {
    const settings = await readStoredApplicationSettings(app.getPath('userData'));
    this.enabled = settings.pushNotificationsEnabled;
    this.installationId = settings.pushInstallationId ?? randomUUID();
    await updateStoredApplicationSettings(app.getPath('userData'), { pushInstallationId: this.installationId });
    this.installNativeBridge();
    void this.reconcile();
  }
  installNativeBridge(): void {
    if (this.bridge) return;
    if (process.platform !== 'darwin' || !app.isPackaged) return;
    try {
      const binding: NativePushBridge = createRequire(import.meta.url)(join(process.resourcesPath, 'native/push-notifications.node'));
      this.bridge = binding;
      binding.start((encoded) => {
        const event: unknown = JSON.parse(encoded);
        if (!event || typeof event !== 'object') return;
        if ('permission' in event && typeof event.permission === 'string') this.permission = event.permission;
        if ('response' in event) {
          const data = PushNotificationDataSchema.safeParse(event.response);
          this.dependencies.clicked(data.success ? data.data.url : null);
        }
        this.dependencies.changed();
      });
      binding.permission(false);
    } catch { this.permission = 'unavailable'; this.dependencies.warn(); }
  }
  reconcile(): Promise<void> {
    if (this.reconciling) return this.serial;
    this.reconciling = true;
    const run = async () => {
      if (!this.bridge || !this.installationId || this.stopped) return;
      this.bridge.permission(false);
      if (!this.enabled) { await this.deleteRegistrations(); return; }
      const credentials = await this.dependencies.credentials();
      const eligible: StoredAuth[] = [];
      for (const credential of credentials) {
        const response = await this.dependencies.request(credential, '/feature-flags');
        if (response.ok && ClientFeatureFlagsSchema.parse(await response.json()).pushNotificationsEnabled) eligible.push(credential);
      }
      if (!eligible.length || !this.enabled || this.stopped) return;
      this.bridge.permission(true);
      this.token ??= await pushNotifications.registerForAPNSNotifications();
      for (const credential of eligible) {
        if (!this.enabled || this.stopped) break;
        const response = await this.dependencies.request(credential, `/push-devices/${this.installationId}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
            platform: 'macos', transport: 'apns', topic: APNS_TOPICS.macos, apnsEnvironment: 'production',
            token: this.token, appVersion: app.getVersion(),
          }),
        });
        if (!response.ok) throw new Error('Push registration failed');
      }
    };
    this.serial = this.serial.then(run, run).catch(() => { this.dependencies.warn(); }).finally(() => { this.reconciling = false; });
    return this.serial;
  }
  async set(enabled: boolean): Promise<void> {
    this.enabled = enabled;
    await updateStoredApplicationSettings(app.getPath('userData'), { pushNotificationsEnabled: enabled });
    if (enabled) { this.stopped = false; await this.reconcile(); }
    else await this.unregister();
    this.dependencies.changed();
  }
  async unregister(): Promise<void> {
    await this.serial;
    await this.deleteRegistrations();
  }
  private async deleteRegistrations(): Promise<void> {
    if (!this.installationId) return;
    const credentials = await this.dependencies.credentials();
    for (const credential of credentials) {
      try {
        const response = await this.dependencies.request(credential, `/push-devices/${this.installationId}`, { method: 'DELETE' });
        if (!response.ok) throw new Error('Push deregistration failed');
      }
      catch { this.dependencies.warn(); }
    }
    if (this.bridge) pushNotifications.unregisterForAPNSNotifications();
    this.token = null;
  }
  async signOut(): Promise<void> { this.stopped = true; await this.unregister(); }
  sessionChanged(): void { this.stopped = false; void this.reconcile(); }
}
