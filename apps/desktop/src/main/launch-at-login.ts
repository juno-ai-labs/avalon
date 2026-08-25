import type { StoredApplicationSettings } from './application-settings';

/** The subset of Electron's login-item settings this module reads. */
export interface LoginItemState {
  readonly openAtLogin: boolean;
  readonly wasOpenedAtLogin: boolean;
}

export interface LaunchAtLoginDependencies {
  readonly supported: boolean;
  /** Whether the enabled-by-default login item may be registered on this
   * launch. False in development, where the executable macOS would register is
   * a shared Electron binary rather than an installed Rally. */
  readonly registersDefault: boolean;
  readonly getLoginItemState: () => LoginItemState;
  readonly setOpenAtLogin: (openAtLogin: boolean) => void;
  readonly readSettings: () => Promise<StoredApplicationSettings>;
  readonly writeSettings: (settings: Partial<StoredApplicationSettings>) => Promise<void>;
  readonly onChange: (enabled: boolean) => void;
  readonly logWarning: (message: string, error: unknown) => void;
}

/**
 * Whether this process was started by the operating system rather than by a
 * person.
 *
 * macOS answers this directly: `wasOpenedAtLogin` is set on a launch that came
 * from a login item — the Login Items list, or a `SMAppService` registration
 * like the one `setOpenAtLogin` makes — and is unset when the app is opened from
 * the Dock, Finder, Spotlight, or a deep link. Nothing distinguishes a login
 * launch from a system restart; both are the same login event to macOS, and
 * Rally treats them the same way.
 *
 * `--hidden` is honoured alongside it so the startup path can be exercised
 * without waiting for a real login, and because it is the argument other
 * launchers pass for the same intent.
 */
export function launchedAtLogin(input: {
  readonly platform: NodeJS.Platform;
  readonly loginItemState: LoginItemState;
  readonly argv: readonly string[];
}): boolean {
  if (input.argv.includes('--hidden')) return true;
  return input.platform === 'darwin' && input.loginItemState.wasOpenedAtLogin;
}

/**
 * Owns whether Rally is registered to open at login.
 *
 * The operating system holds the state, not `application-settings.json`: a
 * person can remove the login item from System Settings, and a preference file
 * that disagreed would put it back without being asked. The file records only
 * that the enabled-by-default registration has happened once, so turning the
 * login item off survives the next launch.
 */
export class LaunchAtLoginController {
  private enabledState = false;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly dependencies: LaunchAtLoginDependencies) {}

  /**
   * Whether macOS opens Rally at login — read from the operating system on
   * every call rather than from the last value this process wrote.
   *
   * The login item can be removed, added, or approved in System Settings →
   * General → Login Items at any moment, and nothing tells Rally it happened.
   * A cached answer would have Settings offer to turn on something already on,
   * or claim Rally opens at login after someone removed it, until the next
   * launch. The read is a synchronous `SMAppService` status query.
   */
  enabled(): boolean {
    if (!this.dependencies.supported) return false;
    try {
      this.enabledState = this.dependencies.getLoginItemState().openAtLogin;
    } catch (error) {
      // Keep the last answer rather than reporting off. "Rally does not open
      // at login" is a claim about the system, and this cannot make it while it
      // cannot see the system.
      this.dependencies.logWarning('could not read whether Rally opens at login', error);
    }
    return this.enabledState;
  }

  available(): boolean {
    return this.dependencies.supported;
  }

  async initialize(): Promise<void> {
    if (!this.dependencies.supported) return;
    try {
      const stored = await this.dependencies.readSettings();
      if (this.dependencies.registersDefault && !stored.launchAtLoginDefaultApplied) {
        // Register before recording it. A failed registration that had already
        // written the marker would never be retried, and Rally would silently
        // ship its default off.
        this.dependencies.setOpenAtLogin(true);
        await this.dependencies.writeSettings({ launchAtLoginDefaultApplied: true });
      }
    } finally {
      // Read back whatever happened above, including when it threw. The
      // registration can succeed and the marker fail to write, and reporting
      // the login item as off while macOS holds it on is the one answer that
      // is certainly wrong — Settings would offer to turn on something already
      // on, and the marker is retried on the next launch anyway.
      this.enabledState = this.dependencies.getLoginItemState().openAtLogin;
    }
  }

  async set(rawEnabled: unknown): Promise<boolean> {
    if (typeof rawEnabled !== 'boolean') throw new Error('Invalid launch at login value');
    const enabled = rawEnabled;
    const applied = this.queue.then(() => this.apply(enabled), () => this.apply(enabled));
    this.queue = applied.catch(() => undefined);
    return applied;
  }

  private async apply(enabled: boolean): Promise<boolean> {
    if (!this.dependencies.supported) {
      throw new Error('Opening at login is available only on macOS');
    }
    this.dependencies.setOpenAtLogin(enabled);
    // Once the choice has been made explicitly there is no default left to
    // apply, so record it even when the toggle is turned off first.
    await this.dependencies.writeSettings({ launchAtLoginDefaultApplied: true });
    // Read back rather than assume: macOS can hold a registration in
    // `requires-approval` until the person allows it in System Settings, and
    // the menu must show what is true rather than what was asked for.
    this.enabledState = this.dependencies.getLoginItemState().openAtLogin;
    this.dependencies.onChange(this.enabledState);
    return this.enabledState;
  }
}
