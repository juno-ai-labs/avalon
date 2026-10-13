import type { ActivityItem, ActivityPage } from '@rally/contracts';

/** What the watch hands its host: the first page of Activity, and whether it has been read yet. */
export interface ActivityFeedSnapshot {
  /** The newest page, newest first, as `GET /navigation/activity` returned it. */
  readonly items: readonly ActivityItem[];
  /** False until the first read on this session lands, so an empty list is not yet "nothing". */
  readonly complete: boolean;
}

export const emptyActivityFeedSnapshot: ActivityFeedSnapshot = { items: [], complete: false };

export interface ActivityFeedWatchDependencies {
  /** Reads the first page of the person's Activity. */
  readonly fetchPage: () => Promise<ActivityPage>;
  /** Called after the snapshot changes. */
  readonly onChange: () => void;
  readonly logWarning: (message: string, error: unknown) => void;
}

/**
 * The first page of the person's Activity tab, held by the main process for
 * the menu bar's Needs attention section.
 *
 * Activity is a REST read, not a socket list, so this holds no rows of its
 * own making: the host calls `refresh` when the workspace socket says Activity
 * may have moved (its subscribe answer, and every `activity` sync), the same
 * signals the sidebar's Activity tab re-reads on. One read is in flight at a
 * time; a refresh asked for meanwhile runs once after it, so a burst of syncs
 * costs two reads rather than one per sync, and the last read always starts
 * after the last signal.
 */
export class ActivityFeedWatch {
  private current: ActivityFeedSnapshot = emptyActivityFeedSnapshot;
  private inFlight = false;
  private again = false;
  /** Bumped by `stop`, so a read that lands after a sign-out is dropped. */
  private generation = 0;

  constructor(private readonly dependencies: ActivityFeedWatchDependencies) {}

  snapshot(): ActivityFeedSnapshot {
    return this.current;
  }

  /** Reads the first page again, or queues one more read behind the one in flight. */
  refresh(): void {
    if (this.inFlight) {
      this.again = true;
      return;
    }
    this.inFlight = true;
    const generation = this.generation;
    void this.dependencies.fetchPage().then((page) => {
      if (generation !== this.generation) return;
      this.current = { items: page.items, complete: true };
      this.dependencies.onChange();
    }, (error: unknown) => {
      // The rows already held stay; the next sync or reconnect reads again.
      if (generation === this.generation) this.dependencies.logWarning('could not read activity for the menu bar', error);
    }).finally(() => {
      if (generation !== this.generation) return;
      this.inFlight = false;
      if (!this.again) return;
      this.again = false;
      this.refresh();
    });
  }

  /** Forgets every row, so nothing the previous account could see survives into the next one's menu. */
  stop(): void {
    this.generation += 1;
    this.inFlight = false;
    this.again = false;
    if (this.current === emptyActivityFeedSnapshot) return;
    this.current = emptyActivityFeedSnapshot;
    this.dependencies.onChange();
  }
}
