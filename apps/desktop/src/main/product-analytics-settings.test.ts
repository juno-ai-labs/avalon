import { describe, expect, it, vi } from 'vitest';
import { defaultStoredApplicationSettings, type StoredApplicationSettings } from './application-settings';
import { ProductAnalyticsSettingsController } from './product-analytics-settings';

function harness(initial: Partial<StoredApplicationSettings> = {}) {
  let stored = { ...defaultStoredApplicationSettings, ...initial };
  const changes: Array<{ desiredEnabled: boolean; effectiveEnabled: boolean; pending: boolean }> = [];
  const sync = vi.fn(async (enabled: boolean, expectedVersion: number) => ({
    enabled,
    version: expectedVersion + 1,
  }));
  const controller = new ProductAnalyticsSettingsController({
    readSettings: async () => stored,
    writeSettings: async (patch) => { stored = { ...stored, ...patch }; },
    syncPreference: sync,
    readPreference: async () => ({
      enabled: stored.productAnalyticsEnabled,
      version: Math.max(1, stored.productAnalyticsPreferenceVersion),
    }),
    invalidateNativeCrashGeneration: vi.fn(async () => undefined),
    purgeNonessentialSpool: vi.fn(async () => undefined),
    onChange: (state) => changes.push(state),
  });
  return { controller, sync, changes, stored: () => stored };
}

describe('Product analytics settings controller', () => {
  it('defaults to effective collection when no account mutation is pending', async () => {
    const { controller } = harness();
    await controller.initialize();
    expect(controller.state()).toEqual({ desiredEnabled: true, effectiveEnabled: true, pending: false });
  });

  it('fails closed for an authenticated launch until the account preference is verified', async () => {
    const base = harness({
      productAnalyticsEnabled: true,
      productAnalyticsPreferenceVersion: 3,
    });
    await base.controller.initialize(true);
    expect(base.controller.state()).toEqual({
      desiredEnabled: true, effectiveEnabled: false, pending: false,
    });
    expect(base.controller.admissionEnabled()).toBe(true);

    await base.controller.refresh();
    expect(base.controller.state()).toEqual({
      desiredEnabled: true, effectiveEnabled: true, pending: false,
    });
  });

  it('closes local admission as well as delivery when the account changes', async () => {
    const base = harness({
      productAnalyticsEnabled: true,
      productAnalyticsPreferenceVersion: 3,
    });
    await base.controller.initialize(true);
    expect(base.controller.admissionEnabled()).toBe(true);

    await base.controller.requireRemoteVerification();

    expect(base.controller.admissionEnabled()).toBe(false);
    expect(base.controller.state()).toEqual({
      desiredEnabled: true, effectiveEnabled: false, pending: false,
    });
  });

  it('durably disables and invalidates diagnostics before waiting for the account API', async () => {
    let resolveSync: ((value: { enabled: boolean; version: number }) => void) | undefined;
    const base = harness({ productAnalyticsPreferenceVersion: 4 });
    base.sync.mockImplementation(() => new Promise((resolve) => { resolveSync = resolve; }));
    await base.controller.initialize();

    const setting = base.controller.set(false);
    await vi.waitFor(() => expect(base.stored()).toMatchObject({
      productAnalyticsEnabled: false,
      productAnalyticsPreferencePending: true,
      productAnalyticsPreferenceVersion: 4,
    }));
    expect(base.controller.state()).toEqual({ desiredEnabled: false, effectiveEnabled: false, pending: true });
    expect(base.changes.at(-1)).toEqual({ desiredEnabled: false, effectiveEnabled: false, pending: true });

    resolveSync?.({ enabled: false, version: 5 });
    await expect(setting).resolves.toEqual({ desiredEnabled: false, effectiveEnabled: false, pending: false });
    expect(base.stored()).toMatchObject({
      productAnalyticsEnabled: false,
      productAnalyticsPreferencePending: false,
      productAnalyticsPreferenceVersion: 5,
    });
  });

  it('keeps a requested enablement ineffective until the server acknowledges it', async () => {
    const base = harness({
      productAnalyticsEnabled: false,
      productAnalyticsPreferenceVersion: 2,
    });
    let resolveSync: ((value: { enabled: boolean; version: number }) => void) | undefined;
    base.sync.mockImplementation(() => new Promise((resolve) => { resolveSync = resolve; }));
    await base.controller.initialize();
    const setting = base.controller.set(true);
    await vi.waitFor(() => expect(base.controller.state().pending).toBe(true));
    expect(base.controller.state()).toEqual({ desiredEnabled: true, effectiveEnabled: false, pending: true });
    resolveSync?.({ enabled: true, version: 3 });
    await setting;
    expect(base.controller.state()).toEqual({ desiredEnabled: true, effectiveEnabled: true, pending: false });
  });

  it('stays locally disabled and pending when synchronization fails', async () => {
    const base = harness();
    base.sync.mockRejectedValue(new Error('offline'));
    await base.controller.initialize();
    await expect(base.controller.set(false)).rejects.toThrow('offline');
    expect(base.controller.state()).toEqual({ desiredEnabled: false, effectiveEnabled: false, pending: true });
    expect(base.stored().productAnalyticsPreferencePending).toBe(true);
  });

  it('adopts a newer canonical opt-out instead of overwriting it with a stale pending opt-in', async () => {
    const base = harness({
      productAnalyticsEnabled: true,
      productAnalyticsPreferencePending: true,
      productAnalyticsPreferenceVersion: 4,
    });
    base.sync.mockResolvedValue({ enabled: false, version: 5 });
    await base.controller.initialize();

    await expect(base.controller.retryPending()).resolves.toEqual({
      desiredEnabled: false,
      effectiveEnabled: false,
      pending: false,
    });
    expect(base.sync).toHaveBeenCalledWith(true, 4);
    expect(base.stored()).toMatchObject({
      productAnalyticsEnabled: false,
      productAnalyticsPreferencePending: false,
      productAnalyticsPreferenceVersion: 5,
    });
  });
});
