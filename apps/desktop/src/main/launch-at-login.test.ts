import { describe, expect, it, vi } from 'vitest';
import { defaultStoredApplicationSettings, type StoredApplicationSettings } from './application-settings';
import { LaunchAtLoginController, launchedAtLogin, type LoginItemState } from './launch-at-login';

function harness(options: {
  supported?: boolean;
  registersDefault?: boolean;
  stored?: Partial<StoredApplicationSettings>;
  openAtLogin?: boolean;
  /** macOS can leave a registration awaiting approval in System Settings, so
   * what was asked for and what is true can differ. */
  registrationTakesEffect?: boolean;
} = {}) {
  const state: { openAtLogin: boolean; wasOpenedAtLogin: boolean } = {
    openAtLogin: options.openAtLogin ?? false,
    wasOpenedAtLogin: false,
  };
  let settings: StoredApplicationSettings = { ...defaultStoredApplicationSettings, ...options.stored };
  const setOpenAtLogin = vi.fn((openAtLogin: boolean) => {
    if (options.registrationTakesEffect === false) return;
    state.openAtLogin = openAtLogin;
  });
  const onChange = vi.fn();
  const logWarning = vi.fn();
  const controller = new LaunchAtLoginController({
    supported: options.supported ?? true,
    registersDefault: options.registersDefault ?? true,
    getLoginItemState: () => ({ ...state }),
    setOpenAtLogin,
    readSettings: () => Promise.resolve(settings),
    writeSettings: (patch) => {
      settings = { ...settings, ...patch };
      return Promise.resolve();
    },
    onChange,
    logWarning,
  });
  return { controller, setOpenAtLogin, onChange, logWarning, state, storedSettings: () => settings };
}

describe('launch at login', () => {
  it('registers the login item once, on the first launch that can', async () => {
    const first = harness();
    await first.controller.initialize();

    expect(first.setOpenAtLogin).toHaveBeenCalledWith(true);
    expect(first.controller.enabled()).toBe(true);
    expect(first.storedSettings().launchAtLoginDefaultApplied).toBe(true);
  });

  it('never re-applies the default over a person turning it off', async () => {
    const subject = harness();
    await subject.controller.initialize();
    await subject.controller.set(false);
    expect(subject.controller.enabled()).toBe(false);

    const relaunched = harness({
      stored: { launchAtLoginDefaultApplied: true },
      openAtLogin: false,
    });
    await relaunched.controller.initialize();

    expect(relaunched.setOpenAtLogin).not.toHaveBeenCalled();
    expect(relaunched.controller.enabled()).toBe(false);
  });

  it('does not register a development build as a login item', async () => {
    const subject = harness({ registersDefault: false });
    await subject.controller.initialize();

    expect(subject.setOpenAtLogin).not.toHaveBeenCalled();
    expect(subject.storedSettings().launchAtLoginDefaultApplied).toBe(false);
    // The toggle still works; only the automatic registration is withheld.
    await expect(subject.controller.set(true)).resolves.toBe(true);
  });

  it('retries the default registration when it failed', async () => {
    const subject = harness();
    subject.setOpenAtLogin.mockImplementationOnce(() => {
      throw new Error('the login item service refused the registration');
    });

    await expect(subject.controller.initialize()).rejects.toThrow(/refused/u);
    // Recording the default as applied before it succeeded would ship the
    // preference off, silently, with no launch left that would retry it.
    expect(subject.storedSettings().launchAtLoginDefaultApplied).toBe(false);
  });

  it('reports the registration it made even when recording it failed', async () => {
    const subject = harness();
    let write = 0;
    const controller = new LaunchAtLoginController({
      supported: true,
      registersDefault: true,
      getLoginItemState: () => ({ ...subject.state }),
      setOpenAtLogin: subject.setOpenAtLogin,
      readSettings: () => Promise.resolve({ ...defaultStoredApplicationSettings }),
      writeSettings: () => {
        write += 1;
        return Promise.reject(new Error('the preference file is read-only'));
      },
      onChange: vi.fn(),
      logWarning: vi.fn(),
    });

    await expect(controller.initialize()).rejects.toThrow(/read-only/u);

    // The login item is registered. Reporting it as off would have Settings
    // offer to turn on something macOS already holds on, and the marker is
    // retried on the next launch anyway.
    expect(write).toBe(1);
    expect(controller.enabled()).toBe(true);
  });

  it('reports what macOS holds rather than what was asked for', async () => {
    const subject = harness({ stored: { launchAtLoginDefaultApplied: true }, registrationTakesEffect: false });
    await subject.controller.initialize();

    await expect(subject.controller.set(true)).resolves.toBe(false);
    expect(subject.onChange).toHaveBeenCalledWith(false);
  });

  it('records that the default is spent even when the first choice is off', async () => {
    const subject = harness({ stored: { launchAtLoginDefaultApplied: false }, registersDefault: false });
    await subject.controller.initialize();

    await subject.controller.set(false);

    expect(subject.storedSettings().launchAtLoginDefaultApplied).toBe(true);
  });

  it('follows the login item being changed in System Settings while Rally runs', async () => {
    const subject = harness({ stored: { launchAtLoginDefaultApplied: true }, openAtLogin: true });
    await subject.controller.initialize();
    expect(subject.controller.enabled()).toBe(true);

    // Nothing tells Rally this happened, so a cached answer would keep
    // claiming Rally opens at login until the next launch.
    subject.state.openAtLogin = false;

    expect(subject.controller.enabled()).toBe(false);
  });

  it('keeps its last answer when the login item cannot be read at all', async () => {
    const subject = harness({ stored: { launchAtLoginDefaultApplied: true }, openAtLogin: true });
    await subject.controller.initialize();

    const failing = new LaunchAtLoginController({
      supported: true,
      registersDefault: false,
      getLoginItemState: () => {
        throw new Error('the login item service is unavailable');
      },
      setOpenAtLogin: vi.fn(),
      readSettings: () => Promise.resolve({ ...defaultStoredApplicationSettings }),
      writeSettings: () => Promise.resolve(),
      onChange: vi.fn(),
      logWarning: subject.logWarning,
    });

    // Reporting off would be a claim about the system this cannot see.
    expect(failing.enabled()).toBe(false);
    expect(subject.logWarning).toHaveBeenCalledTimes(1);
  });

  it('refuses a value that is not a boolean, and the platform that has no login items', async () => {
    const subject = harness();
    await expect(subject.controller.set('yes')).rejects.toThrow(/Invalid launch at login value/u);

    const unsupported = harness({ supported: false });
    await unsupported.controller.initialize();
    expect(unsupported.setOpenAtLogin).not.toHaveBeenCalled();
    await expect(unsupported.controller.set(true)).rejects.toThrow(/only on macOS/u);
  });
});

describe('detecting a login launch', () => {
  const loginItemState = (wasOpenedAtLogin: boolean): LoginItemState => ({
    openAtLogin: true,
    wasOpenedAtLogin,
  });

  it('reads the macOS login-item launch flag', () => {
    expect(launchedAtLogin({ platform: 'darwin', loginItemState: loginItemState(true), argv: [] })).toBe(true);
    expect(launchedAtLogin({ platform: 'darwin', loginItemState: loginItemState(false), argv: [] })).toBe(false);
  });

  it('ignores the flag off macOS, which does not set it', () => {
    expect(launchedAtLogin({ platform: 'win32', loginItemState: loginItemState(true), argv: [] })).toBe(false);
  });

  it('honours an explicit --hidden launch', () => {
    expect(launchedAtLogin({ platform: 'linux', loginItemState: loginItemState(false), argv: ['rally', '--hidden'] }))
      .toBe(true);
  });
});
