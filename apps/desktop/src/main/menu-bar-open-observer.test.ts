import { describe, expect, it, vi } from 'vitest';
import { MenuBarOpenObserver } from './menu-bar-open-observer';

describe('MenuBarOpenObserver', () => {
  it('coalesces the tray click and menu callback for one open, then resets on close', () => {
    const now = 0;
    const onOpen = vi.fn();
    const observer = new MenuBarOpenObserver(onOpen, () => now);

    observer.opened();
    observer.opened();
    expect(onOpen).toHaveBeenCalledTimes(1);

    observer.closed();
    observer.opened();
    expect(onOpen).toHaveBeenCalledTimes(2);
  });

  it('records an open when only the menu callback fires', () => {
    const onOpen = vi.fn();
    const observer = new MenuBarOpenObserver(onOpen);

    observer.opened();

    expect(onOpen).toHaveBeenCalledOnce();
  });

  it('re-arms after the duplicate window if a platform omits the close callback', () => {
    let now = 0;
    const onOpen = vi.fn();
    const observer = new MenuBarOpenObserver(onOpen, () => now);

    observer.opened();
    now = 50;
    observer.opened();
    now = 101;
    observer.opened();

    expect(onOpen).toHaveBeenCalledTimes(2);
  });
});
