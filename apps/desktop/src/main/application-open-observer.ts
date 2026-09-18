export type ApplicationOpenEntrypoint =
  | 'system_start'
  | 'user_launch'
  | 'dock'
  | 'deep_link'
  | 'menu_bar'
  | 'push_notification';

export type ApplicationOpenPhase = 'cold_start' | 'activation';

export function initialApplicationOpenEntrypoint(input: {
  openedAtLogin: boolean;
  hasDeepLink: boolean;
  hasPushNotification?: boolean;
}): Extract<ApplicationOpenEntrypoint, 'system_start' | 'user_launch' | 'deep_link' | 'push_notification'> {
  if (input.hasPushNotification) return 'push_notification';
  if (input.openedAtLogin) return 'system_start';
  if (input.hasDeepLink) return 'deep_link';
  // Electron cannot distinguish Dock, Finder, Spotlight, or another ordinary
  // GUI launcher for a new process. Do not manufacture Dock attribution.
  return 'user_launch';
}

/**
 * Coalesces Electron's generic `activate` callback with a more specific open
 * source. Explicit handlers can run immediately before or after activation, so
 * Dock attribution waits one short turn and loses to a proved source.
 */
export class ApplicationOpenObserver {
  private pendingDock: ReturnType<typeof setTimeout> | null = null;
  private explicitUntil = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly report: (entrypoint: ApplicationOpenEntrypoint, phase: ApplicationOpenPhase) => void,
    private readonly now: () => number = Date.now,
    private readonly coalesceMs = 100,
  ) {}

  launched(entrypoint: Extract<ApplicationOpenEntrypoint, 'system_start' | 'user_launch' | 'deep_link' | 'push_notification'>): void {
    this.cancelPendingDock();
    this.explicitUntil = this.now() + this.coalesceMs;
    this.report(entrypoint, 'cold_start');
  }

  opened(entrypoint: Exclude<ApplicationOpenEntrypoint, 'system_start' | 'dock'>): void {
    this.cancelPendingDock();
    this.explicitUntil = this.now() + this.coalesceMs;
    this.report(entrypoint, 'activation');
  }

  activated(): void {
    if (this.now() <= this.explicitUntil || this.pendingDock) return;
    this.pendingDock = setTimeout(() => {
      this.pendingDock = null;
      if (this.now() <= this.explicitUntil) return;
      this.report('dock', 'activation');
    }, this.coalesceMs);
  }

  destroy(): void {
    this.cancelPendingDock();
  }

  private cancelPendingDock(): void {
    if (!this.pendingDock) return;
    clearTimeout(this.pendingDock);
    this.pendingDock = null;
  }
}
