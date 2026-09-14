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

// Cancellation releases the serial queue even when Electron's native registration
// promise cannot itself be canceled. A late result cannot write a registration.
async function cancellable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort: () => void = () => {};
  const canceled = new Promise<never>((_resolve, reject) => { abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true }); });
  try { return await Promise.race([operation, canceled]); }
  finally { signal.removeEventListener('abort', abort); }
}

export class DesktopPushNotifications {
  private bridge: NativePushBridge | null = null;
  private installationId: string | null = null;
  private enabled = true;
  private permission = 'unavailable';
  private permissionResult: ((status: string) => void) | undefined;
  private serial: Promise<void> = Promise.resolve();
  private cancellation = new AbortController();
  private stopped = false;
  private knownCredentials: StoredAuth[] = [];
  private observedFlag: boolean | undefined;
  constructor(private readonly dependencies: PushDependencies) {}
  state() { return { pushNotificationsEnabled: this.enabled, pushNotificationStatus: this.permission }; }
  async initialize(): Promise<void> {
    try {
      const settings = await readStoredApplicationSettings(app.getPath('userData'));
      this.enabled = settings.pushNotificationsEnabled;
      const installationId = settings.pushInstallationId ?? randomUUID();
      if (!settings.pushInstallationId) await updateStoredApplicationSettings(app.getPath('userData'), { pushInstallationId: installationId });
      this.installationId = installationId;
      this.installNativeBridge();
      void this.reconcile();
    } catch {
      this.installationId = null;
      this.permission = 'unavailable';
      this.dependencies.warn();
      this.dependencies.changed();
    }
  }
  installNativeBridge(): void {
    if (this.bridge || process.platform !== 'darwin' || !app.isPackaged) return;
    try {
      const binding: NativePushBridge = createRequire(import.meta.url)(join(process.resourcesPath, 'native/push-notifications.node'));
      this.bridge = binding;
      binding.start((encoded) => {
        const event: unknown = JSON.parse(encoded);
        if (!event || typeof event !== 'object') return;
        if ('permission' in event && typeof event.permission === 'string') {
          this.permission = event.permission;
          this.permissionResult?.(event.permission);
        }
        if ('response' in event) {
          const data = PushNotificationDataSchema.safeParse(event.response);
          this.dependencies.clicked(data.success ? data.data.url : null);
        }
        this.dependencies.changed();
      });
    } catch { this.permission = 'unavailable'; this.dependencies.warn(); }
  }
  private enqueue(run: () => Promise<void>): Promise<void> {
    this.serial = this.serial.then(run, run).catch((error: unknown) => {
      if (!(error instanceof DOMException && error.name === 'AbortError')) this.dependencies.warn();
    });
    return this.serial;
  }
  private async readPermission(request: boolean, signal: AbortSignal): Promise<string> {
    try {
      const result = new Promise<string>((resolve) => { this.permissionResult = resolve; });
      this.bridge!.permission(request);
      return await cancellable(result, signal);
    } finally { this.permissionResult = undefined; }
  }
  reconcile(): Promise<void> {
    return this.enqueue(async () => {
      if (!this.bridge || !this.installationId || this.stopped) return;
      const signal = this.cancellation.signal;
      const credentials = await cancellable(this.dependencies.credentials(), signal);
      this.knownCredentials = credentials;
      if (!this.enabled) { await this.deleteRegistrations(credentials, signal); return; }
      const eligible: StoredAuth[] = [];
      for (const credential of credentials) {
        const response = await cancellable(this.dependencies.request(credential, '/feature-flags', { signal }), signal);
        if (response.ok && ClientFeatureFlagsSchema.parse(await response.json()).pushNotificationsEnabled) eligible.push(credential);
      }
      if (!eligible.length) { await this.deleteRegistrations(credentials, signal); return; }
      // Authorization is asynchronous. A denied device must not suppress email.
      if (await this.readPermission(true, signal) !== 'enabled') { await this.deleteRegistrations(credentials, signal); return; }
      const token = await cancellable(pushNotifications.registerForAPNSNotifications(), signal);
      signal.throwIfAborted();
      if (!this.enabled || this.stopped) return;
      for (const credential of eligible) {
        signal.throwIfAborted();
        const response = await cancellable(this.dependencies.request(credential, `/push-devices/${this.installationId}`, {
          signal, method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
            platform: 'macos', transport: 'apns', topic: APNS_TOPICS.macos, apnsEnvironment: 'production',
            token, appVersion: app.getVersion(),
          }),
        }), signal);
        if (!response.ok) throw new Error('Push registration failed');
      }
    });
  }
  async set(enabled: boolean): Promise<void> {
    this.enabled = enabled;
    if (!enabled) this.cancelRegistration();
    await updateStoredApplicationSettings(app.getPath('userData'), { pushNotificationsEnabled: enabled });
    if (enabled) this.stopped = false;
    await this.reconcile();
    this.dependencies.changed();
  }
  private cancelRegistration(): void {
    this.cancellation.abort();
    this.cancellation = new AbortController();
    if (this.bridge) pushNotifications.unregisterForAPNSNotifications();
  }
  private async deleteRegistrations(credentials: StoredAuth[], signal: AbortSignal): Promise<void> {
    if (!this.installationId) return;
    for (const credential of credentials) {
      try {
        const response = await cancellable(this.dependencies.request(credential, `/push-devices/${this.installationId}`, { method: 'DELETE', signal }), signal);
        if (!response.ok) throw new Error('Push deregistration failed');
      } catch (error) {
        if (signal.aborted) throw error;
        this.dependencies.warn();
      }
    }
    if (this.bridge) pushNotifications.unregisterForAPNSNotifications();
  }
  // Local sign-out never waits on optional push networking. Capture credentials
  // before they are cleared; serialize cleanup before any subsequent sign-in.
  signOut(credentials: StoredAuth[] = this.knownCredentials): void {
    this.stopped = true;
    this.cancelRegistration();
    const signal = this.cancellation.signal;
    void this.enqueue(() => this.deleteRegistrations(credentials, signal));
  }
  sessionChanged(): void { if (this.stopped) this.cancelRegistration(); this.stopped = false; void this.reconcile(); }
  featureFlagChanged(enabled: boolean): void {
    if (this.observedFlag === enabled) return;
    this.observedFlag = enabled;
    void this.reconcile();
  }
  refreshPermission(): void {
    void this.enqueue(async () => {
      if (!this.bridge || !this.installationId || this.stopped) return;
      const previous = this.permission;
      if (await this.readPermission(false, this.cancellation.signal) !== previous) void this.reconcile();
    });
  }
}
