/** How often the service is asked again whether Developer may be offered. */
export const DEVELOPER_SETTINGS_FLAG_POLL_INTERVAL_MS = 60_000;

export interface DeveloperSettingsFlagControllerDependencies {
  /**
   * Asks the service. Resolves to the flag's value, or rejects when it could
   * not be asked at all — the two are deliberately different answers, and only
   * the first one moves the state.
   */
  read: () => Promise<boolean>;
  onChange: (enabled: boolean) => void;
  pollIntervalMs?: number;
}

/**
 * Owns whether Application → Developer may be offered on this device.
 *
 * The Debug enabled preference is per-device and lives in
 * `application-settings.json`; whether the section exists at all is the
 * service's decision, scoped to staff accounts. This controller holds the
 * second half, so the effective preference is the stored one **and** this — a
 * file that says `debugEnabled: true` grants nothing on its own.
 *
 * It starts off and stays off until the service says otherwise, so a device
 * that has never reached the service, or has just signed out, offers nothing.
 * A flag is not a schedule, though: it is flipped between polls, which is why
 * this polls rather than reading once at launch. A poll that fails to reach the
 * service leaves the last answer standing rather than revoking the section on a
 * dropped connection — the section reveals debugging affordances the renderer
 * already holds and crosses no trust boundary, so a network blip is not worth
 * flickering it. Only an answer, a sign-out, or a stop turns it off.
 */
export class DeveloperSettingsFlagController {
  private serverEnabled = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<boolean> | null = null;

  constructor(private readonly dependencies: DeveloperSettingsFlagControllerDependencies) {}

  enabled(): boolean {
    return this.serverEnabled;
  }

  /** Begins polling, asking once immediately. Safe to call again at any time. */
  start(): void {
    if (this.timer === null) {
      const intervalMs = this.dependencies.pollIntervalMs ?? DEVELOPER_SETTINGS_FLAG_POLL_INTERVAL_MS;
      this.timer = setInterval(() => void this.refresh(), intervalMs);
      // A feature flag must never be the reason the process stays alive.
      this.timer.unref?.();
    }
    void this.refresh();
  }

  /** Stops polling and closes the section. Sign-out and shutdown both take this. */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.settle(false);
  }

  /**
   * Asks the service once, now. Concurrent callers share one request: the
   * interval, a session change, and a window opening can all land together, and
   * three answers to the same question are worth one round trip.
   */
  async refresh(): Promise<boolean> {
    if (this.inFlight) return this.inFlight;
    const request = this.dependencies
      .read()
      .then((enabled) => this.settle(enabled === true))
      // An unanswered poll is not an answer; keep whatever the last one said.
      .catch(() => this.serverEnabled)
      .finally(() => {
        this.inFlight = null;
      });
    this.inFlight = request;
    return request;
  }

  private settle(enabled: boolean): boolean {
    if (enabled === this.serverEnabled) return this.serverEnabled;
    this.serverEnabled = enabled;
    this.dependencies.onChange(this.serverEnabled);
    return this.serverEnabled;
  }
}
