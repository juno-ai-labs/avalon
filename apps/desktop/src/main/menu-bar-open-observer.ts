/**
 * Coalesces Electron's two notifications for one status-menu opening.
 *
 * macOS may deliver both the Tray click and Menu `menu-will-show`; either is a
 * sufficient fallback on its own. The matching close re-arms the next open.
 */
export class MenuBarOpenObserver {
  private open = false;
  private lastOpenedAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly onOpen: () => void,
    private readonly now: () => number = Date.now,
  ) {}

  opened(): void {
    const openedAt = this.now();
    // A close normally re-arms immediately. The small time guard also recovers
    // if a platform supplies click/show without the corresponding close.
    if (this.open && openedAt - this.lastOpenedAt < 100) return;
    this.open = true;
    this.lastOpenedAt = openedAt;
    this.onOpen();
  }

  closed(): void {
    this.open = false;
  }
}
