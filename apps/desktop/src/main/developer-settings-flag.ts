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
  /**
   * Called once when polling starts failing, and again when it recovers. A
   * device that cannot reach the service keeps whatever answer it last had, so
   * without this a permanently broken poll — a 500, a schema change, an older
   * Worker answering 404 — would look exactly like a quiet, working one.
   */
  onAvailabilityChange?: (reachable: boolean, error?: unknown) => void;
  pollIntervalMs?: number;
}

/**
 * Owns whether Application → Developer may be offered on this device.
 *
 * The Debug enabled preference is per-device and lives in
 * `application-settings.json`; whether the section exists at all is the
 * service's decision. This controller holds the second half, so the effective
 * preference is the stored one **and** this — a file that says
 * `debugEnabled: true` grants nothing on its own.
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
  private inFlightSince = 0;
  private identity: string | null = null;
  private reachable = true;
  /**
   * Which account the answer in flight belongs to. Bumped whenever the account
   * changes or polling stops, so an answer that arrives after that is dropped
   * instead of applied. Without it a poll issued as one account could re-open
   * the section after sign-out, or hand a staff account's answer to whoever
   * signs in next.
   */
  private generation = 0;

  constructor(private readonly dependencies: DeveloperSettingsFlagControllerDependencies) {}

  enabled(): boolean {
    return this.serverEnabled;
  }

  /**
   * Follows the signed-in account, and is the only way polling starts.
   *
   * The same account again — which is what a token refresh looks like from here
   * — keeps the poll exactly as it was rather than asking an extra time. A
   * different one discards whatever is in flight and asks immediately, because
   * the answer belongs to the account rather than to the device.
   */
  observeSession(identity: string): void {
    const changedAccount = identity !== this.identity;
    this.identity = identity;
    if (changedAccount) {
      this.invalidate();
      // Closed until the *new* account is answered for. Keeping the last answer
      // through a failed poll is a rule about one account's connection, and it
      // must not carry an answer across accounts: onboarding replaces a Global
      // identity session with a regional one without passing through signed-out,
      // so without this the section would stay open on whatever the previous
      // context resolved to — indefinitely, if the new region's polls fail.
      this.settle(false);
    }
    const startedPolling = this.timer === null;
    if (startedPolling) {
      const intervalMs = this.dependencies.pollIntervalMs ?? DEVELOPER_SETTINGS_FLAG_POLL_INTERVAL_MS;
      this.timer = setInterval(() => void this.refresh(), intervalMs);
      // A feature flag must never be the reason the process stays alive.
      this.timer.unref?.();
    }
    if (changedAccount || startedPolling) void this.refresh();
  }

  /** Stops polling and closes the section. Sign-out and shutdown both take this. */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.identity = null;
    this.invalidate();
    this.settle(false);
  }

  /**
   * Asks the service once, now. Concurrent callers share one request: the
   * interval, a session change, and a window opening can all land together, and
   * three answers to the same question are worth one round trip.
   */
  async refresh(): Promise<boolean> {
    // A request that has outlived a whole poll interval is treated as lost.
    // The one real `read` bounds itself, but a shared promise that never
    // settles would otherwise wedge every later tick behind it for the life of
    // the process, which is too quiet a way for a flag to stop working.
    if (this.inFlight && Date.now() - this.inFlightSince >= this.abandonAfterMs()) this.invalidate();
    if (this.inFlight) return this.inFlight;
    const generation = this.generation;
    const current = (): boolean => this.serverEnabled;
    const request = this.dependencies
      .read()
      .then(
        (enabled) => {
          if (generation !== this.generation) return current();
          this.announceReachable(true);
          return this.settle(enabled === true);
        },
        // An unanswered poll is not an answer; keep whatever the last one said.
        (error: unknown) => {
          if (generation === this.generation) this.announceReachable(false, error);
          return current();
        },
      )
      .finally(() => {
        // Only the request that is still the current one may release the slot.
        if (generation === this.generation) this.inFlight = null;
      });
    this.inFlight = request;
    this.inFlightSince = Date.now();
    return request;
  }

  private abandonAfterMs(): number {
    return this.dependencies.pollIntervalMs ?? DEVELOPER_SETTINGS_FLAG_POLL_INTERVAL_MS;
  }

  /** Disowns whatever is in flight, so its answer can no longer be applied. */
  private invalidate(): void {
    this.generation += 1;
    this.inFlight = null;
  }

  private announceReachable(reachable: boolean, error?: unknown): void {
    if (reachable === this.reachable) return;
    this.reachable = reachable;
    this.dependencies.onAvailabilityChange?.(reachable, error);
  }

  private settle(enabled: boolean): boolean {
    if (enabled === this.serverEnabled) return this.serverEnabled;
    this.serverEnabled = enabled;
    this.dependencies.onChange(this.serverEnabled);
    return this.serverEnabled;
  }
}
