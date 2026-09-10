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
  destroyed: number;
  close(): void;
  minimize(): void;
  settleLoad(): void;
  failLoad(error: Error): void;
}

function fakeWindow(
  section: DesktopSettingsSection | null,
  callbacks: SettingsWindowLifecycleCallbacks,
): FakeWindow {
  let destroyed = false;
  let minimized = false;
  let settle: (() => void) | null = null;
  let fail: ((error: Error) => void) | null = null;
  const loading = new Promise<void>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  const window: FakeWindow = {
    section,
    callbacks,
    shown: 0,
    focused: 0,
    restored: 0,
    destroyed: 0,
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
    load: () => loading,
    // The real factory detaches its `closed` listener before destroying, so a
    // disposal never reaches `onClosed`. The fake models that by not calling it.
    destroy: () => {
      destroyed = true;
      window.destroyed += 1;
    },
    // Somebody closing the window, which does reach the controller.
    close: () => {
      destroyed = true;
      callbacks.onClosed();
    },
    minimize: () => {
      minimized = true;
    },
    settleLoad: () => settle?.(),
    failLoad: (error) => fail?.(error),
  };
  return window;
}

/** A controller plus the levers a `BrowserWindow` would pull on it. */
function harness(options: { mayPrewarm?: () => boolean } = {}) {
  const windows: FakeWindow[] = [];
  const reportError = vi.fn();
  let failNextCreate: Error | null = null;
  const createWindow = vi.fn((
    section: DesktopSettingsSection | null,
    callbacks: SettingsWindowLifecycleCallbacks,
  ): SettingsWindowHandle => {
    if (failNextCreate) {
      const error = failNextCreate;
      failNextCreate = null;
      throw error;
    }
    const window = fakeWindow(section, callbacks);
    windows.push(window);
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
    /**
     * Let the newest window finish loading. Loading is deliberately not
     * instant: `ready-to-show` and the load settling race in Electron, and the
     * order between them is what this class exists to survive, so the tests
     * drive each one by hand.
     */
    finishLoad: async (): Promise<void> => {
      windows[windows.length - 1]?.settleLoad();
      await Promise.resolve();
      await Promise.resolve();
    },
    /** Make the newest window's renderer load fail, as a bad URL would. */
    breakLoad: async (error: Error): Promise<void> => {
      windows[windows.length - 1]?.failLoad(error);
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

  it('shows a window whose readiness arrives before its load settles', async () => {
    const test = harness();
    const opened = test.controller.open();
    // `ready-to-show` routinely fires before `loadURL` resolves, which is why
    // the callback is wired at construction and the window is adopted before
    // the load rather than after it. Ready means painted; there is nothing left
    // to wait for.
    test.windows[0]!.callbacks.onReadyToShow();
    expect(test.windows[0]!.shown).toBe(1);

    await test.finishLoad();
    await opened;

    // Still one reveal for the one request, though both of its triggers ran.
    expect(test.windows[0]!.shown).toBe(1);
    expect(test.windows[0]!.focused).toBe(1);
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

    first.close();
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

  /**
   * The next window is built for nobody — `prewarm` is reached by every token
   * refresh — so a request left over from a failed `open` would put Settings in
   * front of somebody who never asked for it.
   */
  async function expectsNoInheritedRequest(test: ReturnType<typeof harness>): Promise<void> {
    expect(test.controller.isRevealRequested()).toBe(false);
    const warmed = test.controller.prewarm();
    await test.finishLoad();
    await warmed;
    test.latest().callbacks.onReadyToShow();
    expect(test.latest().shown).toBe(0);
    expect(test.controller.isRevealRequested()).toBe(false);
  }

  it('does not leave a request behind when the window could not be built', async () => {
    const test = harness();
    test.failNextCreate(new Error('settings window could not be built'));

    await expect(test.controller.open()).rejects.toThrow();

    await expectsNoInheritedRequest(test);
  });

  it('does not leave a request behind when its renderer could not load', async () => {
    const test = harness();
    const opened = test.controller.open();
    await test.breakLoad(new Error('settings loadURL failed'));
    await expect(opened).rejects.toThrow();

    await expectsNoInheritedRequest(test);
  });

  it('gives up a prewarmed window when the last window somebody used closes', async () => {
    const test = harness();
    const prewarmed = test.controller.prewarm();
    await test.finishLoad();
    await prewarmed;
    test.latest().callbacks.onReadyToShow();

    test.controller.releasePrewarmed();

    // `window-all-closed` is the only thing that quits Rally off macOS and it
    // waits for every window, hidden ones included.
    expect(test.latest().destroyed).toBe(1);
    // Released, not recycled: rebuilding here would re-block the exit.
    expect(test.createWindow).toHaveBeenCalledTimes(1);
  });

  it('keeps a settings window somebody actually opened', async () => {
    const test = harness();
    const opened = test.controller.open();
    await test.finishLoad();
    test.latest().callbacks.onReadyToShow();
    await opened;

    test.controller.releasePrewarmed();

    expect(test.latest().destroyed).toBe(0);
    expect(test.controller.isRevealRequested()).toBe(true);
  });

  it('discards a prewarm that was released while it was still loading', async () => {
    const test = harness();
    const prewarmed = test.controller.prewarm();
    test.controller.releasePrewarmed();
    await test.finishLoad();
    await prewarmed;
    test.latest().callbacks.onReadyToShow();

    expect(test.latest().destroyed).toBe(1);
    expect(test.latest().shown).toBe(0);
  });

  it('prewarms again once a release is followed by a real request', async () => {
    const test = harness();
    const prewarmed = test.controller.prewarm();
    await test.finishLoad();
    await prewarmed;
    test.controller.releasePrewarmed();

    const opened = test.controller.open();
    await test.finishLoad();
    test.latest().callbacks.onReadyToShow();
    await opened;

    expect(test.windows).toHaveLength(2);
    expect(test.latest().shown).toBe(1);
  });

  it('never adopts a window that was destroyed while it loaded', async () => {
    const test = harness();
    const opened = test.controller.open();
    const window = test.windows[0]!;
    window.close();
    await test.finishLoad();
    await opened;

    window.callbacks.onReadyToShow();
    expect(window.shown).toBe(0);
    expect(test.controller.isRevealRequested()).toBe(false);
  });

  it('destroys the window when its renderer fails to load', async () => {
    const test = harness();
    const failure = new Error('settings loadURL failed');
    const opened = test.controller.open();
    const window = test.windows[0]!;

    await test.breakLoad(failure);
    await expect(opened).rejects.toBe(failure);

    // Electron leaves a window whose load failed exactly where it was, so a
    // controller that merely forgot it would strand a blank window and its
    // renderer process for the life of the process.
    expect(window.destroyed).toBe(1);
    expect(test.controller.isRevealRequested()).toBe(false);
  });

  it('builds one replacement after a failed load, not one per attempt', async () => {
    const test = harness();
    const failed = test.controller.open();
    await test.breakLoad(new Error('settings loadURL failed'));
    await expect(failed).rejects.toThrow();

    const opened = test.controller.open();
    await test.finishLoad();
    test.latest().callbacks.onReadyToShow();
    await opened;

    // Two windows total, and the first was released rather than orphaned by the
    // second overwriting the reference to it.
    expect(test.windows).toHaveLength(2);
    expect(test.windows[0]!.destroyed).toBe(1);
    expect(test.windows[1]!.destroyed).toBe(0);
    expect(test.windows[1]!.shown).toBe(1);
  });

  it('reports a failed prewarm load without rebuilding on the disposal', async () => {
    const test = harness();
    const failure = new Error('settings loadURL failed');
    const prewarmed = test.controller.prewarm();
    await test.breakLoad(failure);
    await prewarmed;

    expect(test.reportError).toHaveBeenCalledWith(failure);
    expect(test.windows[0]!.destroyed).toBe(1);
    // A disposal is not somebody closing Settings. Treating it as one would
    // rebuild a window that cannot load, and then rebuild it again.
    expect(test.createWindow).toHaveBeenCalledTimes(1);
  });
});
