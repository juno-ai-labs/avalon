import type { DesktopSettingsSection } from '../common/settings';

/**
 * The window itself, narrowed to what the lifecycle below actually touches.
 *
 * `ready-to-show` and `closed` are not on here: both can fire before the
 * factory's promise resolves — a load that fails destroys the window, and
 * `ready-to-show` routinely beats `loadURL` — so they are handed to the factory
 * as callbacks and wired the moment the window is constructed. A listener this
 * interface let the controller attach afterwards would be a listener attached
 * after the event it is waiting for.
 */
export interface SettingsWindowHandle {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
  /** Ask the renderer to move to a section, for a window that already exists. */
  deliverSection(section: DesktopSettingsSection): void;
}

export interface SettingsWindowLifecycleCallbacks {
  onReadyToShow(): void;
  onClosed(): void;
}

export interface SettingsWindowControllerDependencies {
  /**
   * Builds the window, hidden, wires the two callbacks before loading anything,
   * and resolves once its renderer has been told to load. `section` is baked
   * into the URL so a cold open lands on the right pane in its first paint.
   */
  createWindow(
    section: DesktopSettingsSection | null,
    callbacks: SettingsWindowLifecycleCallbacks,
  ): Promise<SettingsWindowHandle>;
  /** Whether a window may be built before anybody has asked to see one. */
  mayPrewarm(): boolean;
  reportError(error: unknown): void;
}

/**
 * One settings window, built before it is asked for.
 *
 * Settings is its own `BrowserWindow`, so opening it used to mean spawning a
 * renderer process, parsing the whole application bundle, booting the session
 * and mounting React before a single row could be drawn — all of it after the
 * click, all of it while the person waits at nothing. None of that work depends
 * on anything the click supplies. So it is done in advance, hidden, and the
 * click costs a `show()`.
 *
 * The state this holds is the consequence of that split. A window that exists
 * but must not be seen cannot use `ready-to-show` to reveal itself, which is
 * what an on-demand window does, so readiness and the wish to be seen are
 * tracked separately and whichever arrives second reveals the window.
 */
export class SettingsWindowController {
  private window: SettingsWindowHandle | null = null;
  private creation: Promise<void> | null = null;
  private ready = false;
  private closed = false;
  private revealRequested = false;
  /**
   * One reveal owed to one `open`, consumed when it is paid.
   *
   * Distinct from `revealRequested`, which stays true for the life of a window
   * that has been asked for. Both a reveal's two possible triggers — the window
   * being adopted and `ready-to-show` arriving — call `revealIfReady`, and
   * whichever is second used to raise and focus the window a second time.
   * Consuming this is what makes the reveal happen exactly once per request,
   * while a later `open` on a window already on screen still raises it.
   */
  private pendingReveal = false;
  private pendingSection: DesktopSettingsSection | null = null;

  constructor(private readonly dependencies: SettingsWindowControllerDependencies) {}

  /**
   * Whether anybody has asked to see settings since the current window began.
   *
   * False for a window that exists only because it was prewarmed — including
   * while it is still loading, which is why this is not derived from whether the
   * window has been adopted yet. Callers that mean "settings is where this
   * belongs" ask this, never whether a window object exists.
   */
  isRevealRequested(): boolean {
    return this.revealRequested;
  }

  /**
   * Build the window now, hidden, so a later `open` costs only a `show()`.
   *
   * Safe to call repeatedly and from anything that might mean a window is worth
   * having — a sign-in, a token refresh, the main renderer coming up, the
   * previous window closing. It returns immediately when one already exists or
   * is being built, so the callers do not have to agree about who is first.
   */
  async prewarm(): Promise<void> {
    if (this.window || this.creation) return;
    if (!this.dependencies.mayPrewarm()) return;
    // Never rejects, unlike `open`. Nobody asked for this window, so a failure
    // to build it has no one to report to and must not surface as an unhandled
    // rejection in the main process; the next `open` builds one and *that*
    // failure reaches the person who asked.
    try {
      await this.ensureWindow();
    } catch (error) {
      this.dependencies.reportError(error);
    }
  }

  /** Show settings, building the window first when prewarming has not. */
  async open(section?: DesktopSettingsSection): Promise<void> {
    if (section) this.pendingSection = section;
    this.revealRequested = true;
    this.pendingReveal = true;
    await this.ensureWindow();
    this.revealIfReady();
  }

  private ensureWindow(): Promise<void> {
    if (this.window) return Promise.resolve();
    this.creation ??= this.createNow().finally(() => {
      this.creation = null;
    });
    return this.creation;
  }

  private async createNow(): Promise<void> {
    // Consumed here rather than at reveal: a cold open knows its section before
    // the renderer starts, so it travels in the URL and the first paint is
    // already the right pane. Only a window that outlived the request it was
    // built for has to be told over IPC.
    const section = this.pendingSection;
    this.pendingSection = null;
    this.ready = false;
    this.closed = false;
    const window = await this.dependencies.createWindow(section, {
      onReadyToShow: () => {
        this.ready = true;
        this.revealIfReady();
      },
      onClosed: () => {
        this.closed = true;
        this.forget();
        // Closing settings is the strongest signal there is that this person
        // opens settings, and the machine is idle in the moment right after.
        void this.prewarm();
      },
    });
    // A window destroyed while it loaded has already run `onClosed`. Adopting it
    // now would leave a destroyed window as the one this controller shows.
    if (this.closed || window.isDestroyed()) return;
    this.window = window;
    this.revealIfReady();
  }

  private revealIfReady(): void {
    const window = this.window;
    if (!window || !this.ready || !this.pendingReveal) return;
    if (window.isDestroyed()) {
      this.forget();
      return;
    }
    this.pendingReveal = false;
    if (this.pendingSection) {
      window.deliverSection(this.pendingSection);
      this.pendingSection = null;
    }
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  }

  private forget(): void {
    this.window = null;
    this.ready = false;
    this.revealRequested = false;
    this.pendingReveal = false;
    this.pendingSection = null;
  }
}
