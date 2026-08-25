import type { MenuItemConstructorOptions } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { defaultStoredApplicationSettings, type StoredApplicationSettings } from './application-settings';
import { MenuBarController, type MenuBarTray } from './menu-bar';
import { emptyMenuBarContent, type MenuBarActions, type MenuBarContent } from './menu-bar-menu';

function noopActions(): MenuBarActions {
  return {
    selected: vi.fn(),
    newMeetingNote: vi.fn(),
    newWorkstream: vi.fn(),
    newAutomation: vi.fn(),
    startSuggestion: vi.fn(),
    openWorkstream: vi.fn(),
    openAvalon: vi.fn(),
    quit: vi.fn(),
  };
}

function harness(options: {
  supported?: boolean;
  stored?: Partial<StoredApplicationSettings>;
  content?: MenuBarContent;
  createTrayFails?: boolean;
} = {}) {
  const menus: MenuItemConstructorOptions[][] = [];
  const destroy = vi.fn();
  const createTray = vi.fn((): MenuBarTray => {
    if (options.createTrayFails) throw new Error('no status item is available');
    return {
      setContextMenu: (template) => {
        menus.push(template);
      },
      destroy,
    };
  });
  let settings: StoredApplicationSettings = { ...defaultStoredApplicationSettings, ...options.stored };
  const onChange = vi.fn();
  const logWarning = vi.fn();
  const controller = new MenuBarController({
    supported: options.supported ?? true,
    appName: 'Avalon',
    createTray,
    content: () => options.content ?? emptyMenuBarContent,
    signedIn: () => true,
    meetingRecordingAvailable: () => true,
    suggestedWorkAvailable: () => true,
    sectionHeaders: true,
    actions: noopActions(),
    readSettings: () => Promise.resolve(settings),
    writeSettings: (patch) => {
      settings = { ...settings, ...patch };
      return Promise.resolve();
    },
    onChange,
    logWarning,
  });
  return { controller, createTray, destroy, menus, onChange, logWarning, storedSettings: () => settings };
}

describe('menu bar controller', () => {
  it('puts Avalon in the menu bar by default', async () => {
    const subject = harness();
    await subject.controller.initialize();

    expect(subject.controller.enabled()).toBe(true);
    expect(subject.createTray).toHaveBeenCalledTimes(1);
    expect(subject.menus).toHaveLength(1);
  });

  it('honours a stored preference to keep it out', async () => {
    const subject = harness({ stored: { menuBarEnabled: false } });
    await subject.controller.initialize();

    expect(subject.controller.enabled()).toBe(false);
    expect(subject.createTray).not.toHaveBeenCalled();
  });

  it('adds and removes the status item as the preference changes', async () => {
    const subject = harness();
    await subject.controller.initialize();

    await subject.controller.set(false);
    expect(subject.destroy).toHaveBeenCalledTimes(1);
    expect(subject.storedSettings().menuBarEnabled).toBe(false);
    expect(subject.onChange).toHaveBeenCalledWith(false);

    await subject.controller.set(true);
    expect(subject.createTray).toHaveBeenCalledTimes(2);
  });

  it('writes nothing and announces nothing when the preference does not move', async () => {
    const subject = harness();
    await subject.controller.initialize();

    await expect(subject.controller.set(true)).resolves.toBe(true);

    expect(subject.onChange).not.toHaveBeenCalled();
    expect(subject.createTray).toHaveBeenCalledTimes(1);
  });

  it('serializes overlapping writes', async () => {
    const subject = harness();
    await subject.controller.initialize();

    await Promise.all([subject.controller.set(false), subject.controller.set(true)]);

    expect(subject.controller.enabled()).toBe(true);
    expect(subject.storedSettings().menuBarEnabled).toBe(true);
  });

  it('refuses a value that is not a boolean', async () => {
    const subject = harness();
    await subject.controller.initialize();
    await expect(subject.controller.set('on')).rejects.toThrow(/Invalid menu bar item value/u);
  });

  it('creates no status item on a platform without a menu bar', async () => {
    const subject = harness({ supported: false });
    await subject.controller.initialize();

    expect(subject.controller.available()).toBe(false);
    expect(subject.createTray).not.toHaveBeenCalled();
    // The preference is still stored, so the same profile on a Mac gets the
    // choice rather than the default.
    await subject.controller.set(false);
    expect(subject.storedSettings().menuBarEnabled).toBe(false);
  });

  it('degrades rather than failing the launch when the status item cannot be created', async () => {
    const subject = harness({ createTrayFails: true });
    await subject.controller.initialize();

    expect(subject.logWarning).toHaveBeenCalledTimes(1);
    expect(subject.controller.enabled()).toBe(true);
    // A rebuild after a failed creation must not throw either; every action the
    // menu offers still exists inside the app.
    expect(() => subject.controller.refresh()).not.toThrow();
  });

  it('separates the preference from whether an item is actually in the menu bar', async () => {
    // A launch that opens no window asks `present`, not `enabled`: hiding into
    // a menu bar item that does not exist leaves nothing on screen at all.
    const failed = harness({ createTrayFails: true });
    await failed.controller.initialize();
    expect(failed.controller.enabled()).toBe(true);
    expect(failed.controller.present()).toBe(false);

    const off = harness({ stored: { menuBarEnabled: false } });
    await off.controller.initialize();
    expect(off.controller.present()).toBe(false);

    const unsupported = harness({ supported: false });
    await unsupported.controller.initialize();
    expect(unsupported.controller.present()).toBe(false);

    const subject = harness();
    await subject.controller.initialize();
    expect(subject.controller.present()).toBe(true);
    await subject.controller.set(false);
    expect(subject.controller.present()).toBe(false);
  });

  it('still settles its presence when the preference cannot be read', async () => {
    const menus: MenuItemConstructorOptions[][] = [];
    const createTray = vi.fn((): MenuBarTray => ({
      setContextMenu: (template) => {
        menus.push(template);
      },
      destroy: vi.fn(),
    }));
    const controller = new MenuBarController({
      supported: true,
      appName: 'Avalon',
      createTray,
      content: () => emptyMenuBarContent,
      signedIn: () => true,
      meetingRecordingAvailable: () => true,
      suggestedWorkAvailable: () => true,
      sectionHeaders: true,
      actions: noopActions(),
      readSettings: () => Promise.reject(new Error('EACCES: permission denied')),
      writeSettings: () => Promise.resolve(),
      onChange: vi.fn(),
      logWarning: vi.fn(),
    });

    await expect(controller.initialize()).rejects.toThrow(/EACCES/u);

    // Otherwise `enabledState` keeps its default of `true` with no tray to
    // match it, and the caller fetches and caches menu content that nothing can
    // render.
    expect(createTray).toHaveBeenCalledTimes(1);
    expect(controller.enabled()).toBe(true);
    expect(controller.present()).toBe(true);
  });

  it('rebuilds the drop-down from whatever is currently cached', async () => {
    const subject = harness({
      content: {
        suggestions: [],
        recents: [{ id: 'a', title: 'Acme renewal' }],
        pinned: [],
      },
    });
    await subject.controller.initialize();
    subject.controller.refresh();

    expect(subject.menus).toHaveLength(2);
    expect(subject.menus[1]?.map((item) => item.label)).toContain('Acme renewal');
  });
});
