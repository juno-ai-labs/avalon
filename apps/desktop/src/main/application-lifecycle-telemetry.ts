export type ApplicationFocusTransition = 'foreground' | 'background';

/**
 * Converts Electron window focus observations into application-level
 * transitions. The first observation establishes the launch baseline because
 * `launch_started` already represents the initial Application Opened event.
 */
export class ApplicationLifecycleTelemetry {
  private focused: boolean | null = null;

  constructor(private readonly report: (state: ApplicationFocusTransition) => void) {}

  observeFocused(focused: boolean): void {
    if (this.focused === null) {
      this.focused = focused;
      return;
    }
    if (this.focused === focused) return;
    this.focused = focused;
    this.report(focused ? 'foreground' : 'background');
  }
}
