import type { MenuItemConstructorOptions } from 'electron';
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
  readonly meetingRecordingAvailable?: () => boolean;
  readonly suggestedWorkAvailable?: () => boolean;
  readonly sectionHeaders: boolean;
  readonly actions: MenuBarActions;
  readonly readSettings: () => Promise<StoredApplicationSettings>;
  readonly writeSettings: (settings: Partial<StoredApplicationSettings>) => Promise<void>;
  readonly onChange: (enabled: boolean) => void;
  readonly logWarning: (message: string, error: unknown) => void;
}

/**
 * Owns the Avalon status item: whether it exists, and what its drop-down says.
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
    try {
      this.tray.setContextMenu(menuBarMenuTemplate({
        appName: this.dependencies.appName,
        content: this.dependencies.content(),
        signedIn: this.dependencies.signedIn(),
        meetingRecordingAvailable: this.dependencies.meetingRecordingAvailable?.() ?? true,
        suggestedWorkAvailable: this.dependencies.suggestedWorkAvailable?.() ?? true,
        sectionHeaders: this.dependencies.sectionHeaders,
        actions: this.dependencies.actions,
      }));
    } catch (error) {
      this.dependencies.logWarning('could not rebuild the menu bar item', error);
    }
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
        this.dependencies.logWarning('could not add Avalon to the menu bar', error);
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
      this.dependencies.logWarning('could not remove Avalon from the menu bar', error);
    }
  }
}
