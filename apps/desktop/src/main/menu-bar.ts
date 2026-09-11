import type { MenuItemConstructorOptions } from 'electron';
import { nextRecencyBoundary } from '../common/recency-groups';
import { defaultStoredApplicationSettings, type StoredApplicationSettings } from './application-settings';
import { menuBarMenuTemplate, type MenuBarActions, type MenuBarContent } from './menu-bar-menu';

/** The slice of Electron's `Tray` this module drives. Injected so the whole
 * controller runs in a test process with no display server. */
export interface MenuBarTray {
  readonly setContextMenu: (template: MenuItemConstructorOptions[]) => void;
  readonly destroy: () => void;
}

export interface MenuBarControllerDependencies {
  readonly supported: boolean;
  readonly appName: string;
  readonly createTray: () => MenuBarTray;
  readonly content: () => MenuBarContent;
  readonly signedIn: () => boolean;
  readonly sectionHeaders: boolean;
  readonly actions: MenuBarActions;
  readonly readSettings: () => Promise<StoredApplicationSettings>;
  readonly writeSettings: (settings: Partial<StoredApplicationSettings>) => Promise<void>;
  readonly onChange: (enabled: boolean) => void;
  readonly logWarning: (message: string, error: unknown) => void;
  /** Injected so the recency boundary can be driven in tests. */
  readonly now?: () => number;
}

/**
 * Owns the Rally status item: whether it exists, and what its drop-down says.
 *
 * The menu is rebuilt from whatever is cached rather than fetched on open, so a
 * click always produces a menu at once. Freshness is the caller's job — it asks
 * for a refresh when the pointer reaches the item, and the resulting change
 * arrives here as another `refresh()`.
 */
export class MenuBarController {
  private tray: MenuBarTray | null = null;
  private enabledState = defaultStoredApplicationSettings.menuBarEnabled;
  private queue: Promise<unknown> = Promise.resolve();
  /**
   * When the headings in the menu as currently built stop being true, even if
   * nothing about its content changes. See {@link refreshIfHeadingsExpired}.
   */
  private headingsValidUntil = Number.NEGATIVE_INFINITY;

  constructor(private readonly dependencies: MenuBarControllerDependencies) {}

  enabled(): boolean {
    return this.enabledState;
  }

  available(): boolean {
    return this.dependencies.supported;
  }

  /**
   * Whether a status item is actually in the menu bar right now — the
   * preference being on is not enough, because creating the item can fail.
   * A launch that opens no window asks this: without an item there would be
   * nothing on screen at all.
   */
  present(): boolean {
    return this.tray !== null;
  }

  async initialize(): Promise<void> {
    try {
      this.enabledState = (await this.dependencies.readSettings()).menuBarEnabled;
    } finally {
      // Even when the preference could not be read. Skipping this leaves
      // `enabledState` on its default of `true` with no tray to match it, and
      // the caller then fetches and caches menu content that nothing can
      // render. Falling back to the default is what the rest of the preference
      // file does for an unreadable value; here it also keeps the two halves
      // agreeing with each other.
      this.applyPresence();
    }
  }

  async set(rawEnabled: unknown): Promise<boolean> {
    if (typeof rawEnabled !== 'boolean') throw new Error('Invalid menu bar item value');
    const enabled = rawEnabled;
    const applied = this.queue.then(() => this.apply(enabled), () => this.apply(enabled));
    this.queue = applied.catch(() => undefined);
    return applied;
  }

  /** Rebuilds the drop-down from the current content. Safe to call when the
   * item is off; it does nothing. */
  refresh(): void {
    if (!this.tray) return;
    const content = this.dependencies.content();
    const now = new Date((this.dependencies.now ?? Date.now)());
    try {
      this.tray.setContextMenu(menuBarMenuTemplate({
        appName: this.dependencies.appName,
        content,
        signedIn: this.dependencies.signedIn(),
        sectionHeaders: this.dependencies.sectionHeaders,
        now,
        actions: this.dependencies.actions,
      }));
      // Only once the menu it describes is actually installed. Recording the
      // boundary for a build that threw would suppress every retry until it
      // passed.
      this.headingsValidUntil = nextRecencyBoundary(content.recents, now);
    } catch (error) {
      this.dependencies.logWarning('could not rebuild the menu bar item', error);
    }
  }

  /**
   * Rebuilds only if a heading in the current menu has stopped being true.
   *
   * The recency headings are a function of the content *and of the time*, and
   * only the first of those produces a change anybody reports: a work stream
   * that was under **Today** at 23:59 belongs under **Yesterday** a minute
   * later without one byte of its data moving. `refresh()` alone cannot cover
   * that, because it is called when content changes — and content stops
   * changing exactly when this matters most, since a refresh that fails
   * publishes nothing. Offline overnight, the menu would otherwise keep saying
   * **Today** indefinitely.
   *
   * Called as the pointer reaches the status item, which is a menu's worth of
   * time before anyone reads it, rather than from a timer: waking the process
   * to redraw a menu nobody is looking at buys nothing, and the heading only
   * has to be true when it is read. Guarded by `nextRecencyBoundary` so a
   * pointer crossing the item is not a rebuild — the overwhelmingly common case
   * is that no boundary has passed and this returns immediately.
   *
   * A boundary that passes while the menu is *open* is deliberately not
   * covered: macOS owns an open menu, and nothing can redraw it underneath the
   * reader.
   */
  refreshIfHeadingsExpired(): void {
    if (!this.tray) return;
    if ((this.dependencies.now ?? Date.now)() < this.headingsValidUntil) return;
    this.refresh();
  }

  destroy(): void {
    this.removeTray();
  }

  private async apply(enabled: boolean): Promise<boolean> {
    if (enabled === this.enabledState) return this.enabledState;
    await this.dependencies.writeSettings({ menuBarEnabled: enabled });
    this.enabledState = enabled;
    this.applyPresence();
    this.dependencies.onChange(this.enabledState);
    return this.enabledState;
  }

  private applyPresence(): void {
    if (!this.enabledState || !this.dependencies.supported) {
      this.removeTray();
      return;
    }
    if (!this.tray) {
      try {
        this.tray = this.dependencies.createTray();
      } catch (error) {
        // A status item that cannot be created is a degraded menu bar, not a
        // failed launch: every action it offers exists in the app itself.
        this.dependencies.logWarning('could not add Rally to the menu bar', error);
        return;
      }
    }
    this.refresh();
  }

  private removeTray(): void {
    if (!this.tray) return;
    const tray = this.tray;
    this.tray = null;
    try {
      tray.destroy();
    } catch (error) {
      this.dependencies.logWarning('could not remove Rally from the menu bar', error);
    }
  }
}
