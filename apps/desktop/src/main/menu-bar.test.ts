import type { MenuItemConstructorOptions } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { defaultStoredApplicationSettings, type StoredApplicationSettings } from './application-settings';
import { MenuBarController, type MenuBarTray } from './menu-bar';
import { emptyMenuBarContent, type MenuBarActions, type MenuBarContent } from './menu-bar-menu';

function noopActions(): MenuBarActions {
  return {
    selected: vi.fn(),
    openWorkstream: vi.fn(),
    openRally: vi.fn(),
    quit: vi.fn(),
  };
}

function harness(options: {
  supported?: boolean;
  stored?: Partial<StoredApplicationSettings>;
  content?: MenuBarContent;
  createTrayFails?: boolean;
  now?: () => number;
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
    appName: 'Rally',
    createTray,
    content: () => options.content ?? emptyMenuBarContent,
    signedIn: () => true,
    sectionHeaders: true,
    actions: noopActions(),
    readSettings: () => Promise.resolve(settings),
    writeSettings: (patch) => {
      settings = { ...settings, ...patch };
      return Promise.resolve();
    },
    onChange,
    logWarning,
    ...(options.now ? { now: options.now } : {}),
  });
  return { controller, createTray, destroy, menus, onChange, logWarning, storedSettings: () => settings };
}

describe('menu bar controller', () => {
  it('puts Rally in the menu bar by default', async () => {
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
      appName: 'Rally',
      createTray,
      content: () => emptyMenuBarContent,
      signedIn: () => true,
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

  it('rebuilds the headings once a recency boundary has passed, with no new content', async () => {
    // 23:30, so the row is under Today and the next boundary is midnight.
    let now = new Date('2026-09-10T23:30:00').getTime();
    const subject = harness({
      now: () => now,
      content: {
        recents: [{ id: 'a', title: 'Acme renewal', lastActivityAt: new Date(now - 4 * 3_600_000).toISOString() }],
        pinned: [],
      },
    });
    await subject.controller.initialize();
    expect(subject.menus.at(-1)?.map((item) => item.label)).toContain('Today');

    // The pointer reaching the item before midnight must not rebuild: a
    // crossing is not a reason to redraw a menu that is still true.
    now += 60_000;
    subject.controller.refreshIfHeadingsExpired();
    expect(subject.menus).toHaveLength(1);

    // Past midnight the same row belongs under Yesterday. Nothing about the
    // content moved, and offline nothing would: a failed refresh publishes
    // nothing, so without this the menu says Today until the next good fetch.
    now += 31 * 60_000;
    subject.controller.refreshIfHeadingsExpired();

    const rebuilt = subject.menus.at(-1)?.map((item) => item.label);
    expect(subject.menus).toHaveLength(2);
    expect(rebuilt).toContain('Yesterday');
    expect(rebuilt).not.toContain('Today');
  });

  it('does nothing when the item is off', () => {
    const subject = harness({ stored: { menuBarEnabled: false } });
    subject.controller.refreshIfHeadingsExpired();

    expect(subject.menus).toHaveLength(0);
    expect(subject.createTray).not.toHaveBeenCalled();
  });

  it('does not record a heading boundary for a build that failed', async () => {
    let now = new Date('2026-09-10T23:30:00').getTime();
    const subject = harness({ now: () => now });
    await subject.controller.initialize();
    subject.menus.length = 0;
    const tray = subject.createTray.mock.results[0]?.value as MenuBarTray;
    let failing = true;
    vi.spyOn(tray, 'setContextMenu').mockImplementation((template) => {
      if (failing) throw new Error('the status item went away');
      subject.menus.push(template);
    });

    // Past midnight, so the headings have expired and a rebuild is due. A
    // build that throws leaves the previous menu installed, so the boundary it
    // would have recorded describes a menu nobody is looking at. Recording it
    // anyway would suppress every retry until that boundary passed.
    now += 31 * 60_000;
    subject.controller.refreshIfHeadingsExpired();
    expect(subject.logWarning).toHaveBeenCalledTimes(1);
    expect(subject.menus).toHaveLength(0);

    failing = false;
    subject.controller.refreshIfHeadingsExpired();
    expect(subject.menus).toHaveLength(1);
  });

  it('rebuilds the drop-down from whatever is currently cached', async () => {
    const subject = harness({
      content: {
        recents: [{ id: 'a', title: 'Acme renewal', lastActivityAt: new Date().toISOString() }],
        pinned: [],
      },
    });
    await subject.controller.initialize();
    subject.controller.refresh();

    expect(subject.menus).toHaveLength(2);
    expect(subject.menus[1]?.map((item) => item.label)).toContain('Acme renewal');
  });
});
