import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesktopSettingsSection } from '../common/settings';
import {
  SettingsWindowController,
  type SettingsWindowHandle,
  type SettingsWindowLifecycleCallbacks,
} from './settings-window-controller';

interface FakeWindow extends SettingsWindowHandle {
  readonly section: DesktopSettingsSection | null;
  readonly callbacks: SettingsWindowLifecycleCallbacks;
  shown: number;
  focused: number;
  restored: number;
  readonly delivered: DesktopSettingsSection[];
  destroy(): void;
  minimize(): void;
}

function fakeWindow(
  section: DesktopSettingsSection | null,
  callbacks: SettingsWindowLifecycleCallbacks,
): FakeWindow {
  let destroyed = false;
  let minimized = false;
  const window: FakeWindow = {
    section,
    callbacks,
    shown: 0,
    focused: 0,
    restored: 0,
    delivered: [],
    isDestroyed: () => destroyed,
    isMinimized: () => minimized,
    restore: () => {
      minimized = false;
      window.restored += 1;
    },
    show: () => {
      window.shown += 1;
    },
    focus: () => {
      window.focused += 1;
    },
    deliverSection: (next) => window.delivered.push(next),
    destroy: () => {
      destroyed = true;
    },
    minimize: () => {
      minimized = true;
    },
  };
  return window;
}

/** A controller plus the levers a `BrowserWindow` would pull on it. */
function harness(options: { mayPrewarm?: () => boolean } = {}) {
  const windows: FakeWindow[] = [];
  const resolvers: Array<() => void> = [];
  const reportError = vi.fn();
  let failNextCreate: Error | null = null;
  const createWindow = vi.fn(async (
    section: DesktopSettingsSection | null,
    callbacks: SettingsWindowLifecycleCallbacks,
  ): Promise<SettingsWindowHandle> => {
    if (failNextCreate) {
      const error = failNextCreate;
      failNextCreate = null;
      throw error;
    }
    const window = fakeWindow(section, callbacks);
    windows.push(window);
    // Loading is deliberately not instant: `ready-to-show` and the load promise
    // race in Electron, and the order between them is what this class exists to
    // survive, so the tests drive each one by hand.
    await new Promise<void>((resolve) => resolvers.push(resolve));
    return window;
  });
  const controller = new SettingsWindowController({
    createWindow,
    mayPrewarm: options.mayPrewarm ?? (() => true),
    reportError,
  });
  return {
    controller,
    createWindow,
    reportError,
    windows,
    latest: (): FakeWindow => windows[windows.length - 1]!,
    /** Let the pending `createWindow` resolve, handing the window over. */
    finishLoad: async (): Promise<void> => {
      resolvers.shift()?.();
      await Promise.resolve();
      await Promise.resolve();
    },
    failNextCreate: (error: Error): void => {
      failNextCreate = error;
    },
  };
}

describe('SettingsWindowController', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('builds a hidden window on prewarm and never shows it', async () => {
    const test = harness();
    const prewarmed = test.controller.prewarm();
    await test.finishLoad();
    await prewarmed;

    expect(test.createWindow).toHaveBeenCalledTimes(1);
    expect(test.latest().section).toBeNull();
    test.latest().callbacks.onReadyToShow();
    expect(test.latest().shown).toBe(0);
    expect(test.controller.isRevealRequested()).toBe(false);
  });

  it('shows a prewarmed window without building a second one', async () => {
    const test = harness();
    const prewarmed = test.controller.prewarm();
    await test.finishLoad();
    await prewarmed;
    test.latest().callbacks.onReadyToShow();

    await test.controller.open();

    expect(test.createWindow).toHaveBeenCalledTimes(1);
    expect(test.windows).toHaveLength(1);
    expect(test.latest().shown).toBe(1);
    expect(test.latest().focused).toBe(1);
    expect(test.controller.isRevealRequested()).toBe(true);
  });

  it('raises the window again when settings is asked for while it is already open', async () => {
    const test = harness();
    const opened = test.controller.open();
    await test.finishLoad();
    test.latest().callbacks.onReadyToShow();
    await opened;
    expect(test.latest().shown).toBe(1);

    await test.controller.open('digest');

    expect(test.createWindow).toHaveBeenCalledTimes(1);
    expect(test.latest().shown).toBe(2);
    expect(test.latest().focused).toBe(2);
    expect(test.latest().delivered).toEqual(['digest']);
  });

  it('restores a prewarmed window that the person had minimized', async () => {
    const test = harness();
    const prewarmed = test.controller.prewarm();
    await test.finishLoad();
    await prewarmed;
    test.latest().callbacks.onReadyToShow();
    test.latest().minimize();

    await test.controller.open();

    expect(test.latest().restored).toBe(1);
    expect(test.latest().shown).toBe(1);
  });

  it('carries the section in the URL when it builds the window for the request', async () => {
    const test = harness();
    const opened = test.controller.open('connections');
    await test.finishLoad();
    test.latest().callbacks.onReadyToShow();
    await opened;

    expect(test.latest().section).toBe('connections');
    // The pane is already right in the first paint, so there is nothing to say
    // over IPC and no frame showing Account before it.
    expect(test.latest().delivered).toEqual([]);
    expect(test.latest().shown).toBe(1);
  });

  it('tells a prewarmed window its section before showing it', async () => {
    const test = harness();
    const prewarmed = test.controller.prewarm();
    await test.finishLoad();
    await prewarmed;
    const window = test.latest();
    window.callbacks.onReadyToShow();

    await test.controller.open('github');

    expect(window.section).toBeNull();
    expect(window.delivered).toEqual(['github']);
    expect(window.shown).toBe(1);
  });

  it('waits for readiness when the window is opened before it can paint', async () => {
    const test = harness();
    const opened = test.controller.open();
    await test.finishLoad();
    await opened;
    // The load resolved, so the controller holds the window — but Electron has
    // not said it can paint yet, and showing now is the unpainted flash that
    // `ready-to-show` exists to prevent.
    expect(test.latest().shown).toBe(0);

    test.latest().callbacks.onReadyToShow();
    expect(test.latest().shown).toBe(1);
  });

  it('shows a window whose readiness beat its load', async () => {
    const test = harness();
    const opened = test.controller.open();
    // `ready-to-show` routinely fires before `loadURL` resolves, which is why
    // the callback is wired at construction rather than after the await.
    test.windows[0]!.callbacks.onReadyToShow();
    expect(test.windows[0]!.shown).toBe(0);

    await test.finishLoad();
    await opened;

    expect(test.windows[0]!.shown).toBe(1);
  });

  it('reveals a window that was prewarmed and asked for while still loading', async () => {
    const test = harness();
    const prewarmed = test.controller.prewarm();
    const opened = test.controller.open('workspace');
    await test.finishLoad();
    await Promise.all([prewarmed, opened]);
    test.latest().callbacks.onReadyToShow();

    expect(test.createWindow).toHaveBeenCalledTimes(1);
    expect(test.latest().shown).toBe(1);
    // The prewarm consumed the URL slot with no section, so the request that
    // arrived mid-flight has to travel over IPC.
    expect(test.latest().delivered).toEqual(['workspace']);
  });

  it('builds a replacement in the background once the window is closed', async () => {
    const test = harness();
    const opened = test.controller.open();
    await test.finishLoad();
    test.latest().callbacks.onReadyToShow();
    await opened;
    const first = test.latest();

    first.destroy();
    first.callbacks.onClosed();
    await test.finishLoad();

    expect(test.createWindow).toHaveBeenCalledTimes(2);
    expect(test.windows).toHaveLength(2);
    expect(test.latest()).not.toBe(first);
    expect(test.controller.isRevealRequested()).toBe(false);
    test.latest().callbacks.onReadyToShow();
    expect(test.latest().shown).toBe(0);
  });

  it('does not prewarm when there is nobody a window would belong to', async () => {
    const test = harness({ mayPrewarm: () => false });
    await test.controller.prewarm();
    expect(test.createWindow).not.toHaveBeenCalled();
  });

  it('still opens on request when prewarming is refused', async () => {
    const test = harness({ mayPrewarm: () => false });
    const opened = test.controller.open();
    await test.finishLoad();
    test.latest().callbacks.onReadyToShow();
    await opened;

    expect(test.createWindow).toHaveBeenCalledTimes(1);
    expect(test.latest().shown).toBe(1);
  });

  it('swallows a failed prewarm and reports it, then builds again on request', async () => {
    const test = harness();
    const failure = new Error('settings loadURL failed');
    test.failNextCreate(failure);

    await expect(test.controller.prewarm()).resolves.toBeUndefined();
    expect(test.reportError).toHaveBeenCalledWith(failure);

    const opened = test.controller.open();
    await test.finishLoad();
    test.latest().callbacks.onReadyToShow();
    await opened;
    expect(test.latest().shown).toBe(1);
  });

  it('rejects an open that could not build its window', async () => {
    const test = harness();
    const failure = new Error('settings loadURL failed');
    test.failNextCreate(failure);

    await expect(test.controller.open()).rejects.toBe(failure);
  });

  it('never adopts a window that was destroyed while it loaded', async () => {
    const test = harness();
    const opened = test.controller.open();
    const window = test.windows[0]!;
    window.destroy();
    window.callbacks.onClosed();
    await test.finishLoad();
    await opened;

    window.callbacks.onReadyToShow();
    expect(window.shown).toBe(0);
    expect(test.controller.isRevealRequested()).toBe(false);
  });
});
