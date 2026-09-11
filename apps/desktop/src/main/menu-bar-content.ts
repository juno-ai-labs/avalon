import { z } from 'zod';
import { workstreamRecencyAt } from '../common/recency-groups';
import {
  emptyMenuBarContent,
  MENU_BAR_PINNED_LIMIT,
  MENU_BAR_RECENT_LIMIT,
  type MenuBarContent,
  type MenuBarWorkstream,
} from './menu-bar-menu';

/**
 * Deliberately narrower than `@rally/contracts` describes this response. The
 * status item needs a handful of fields, and parsing the full work-stream
 * contract here would let an unrelated field addition empty the menu on an older
 * client. Everything the menu does not read is ignored rather than rejected.
 */
const MenuBarWorkstreamPageSchema = z.object({
  items: z.array(z.object({
    id: z.string().min(1),
    title: z.string(),
    titleStatus: z.enum(['naming', 'automatic', 'settled']).default('settled'),
    // The reader's own place for this work stream in their arrangement, or null
    // if they have not pinned it. See `workstream-pinning.md`.
    pinPosition: z.number().int().nonnegative().nullable().default(null),
    // What the recency headings are computed from. `lastAccessedAt` is absent
    // on a server too old to report visits and null when nobody has visited;
    // `workstreamRecencyAt` owns the difference, and the sidebar reads the same
    // three fields the same way.
    lastActivityAt: z.string().min(1),
    createdAt: z.string().min(1).optional(),
    lastAccessedAt: z.string().min(1).nullable().optional(),
  })),
});

/** Shown for a work stream Rally has not finished naming. The renderer draws a
 * skeleton in that state; a menu row cannot, and the placeholder title on the
 * wire is not written to be read. */
const UNNAMED_WORKSTREAM_LABEL = 'Untitled work stream';

export interface MenuBarContentDependencies {
  /** Performs an authorized request against the account's regional API and
   * returns the decoded JSON body. Rejects when nobody is signed in. */
  readonly requestJson: (path: string) => Promise<unknown>;
  readonly onChange: (content: MenuBarContent) => void;
  readonly logWarning: (message: string, error: unknown) => void;
  /** Injected so the staleness window can be driven in tests. */
  readonly now?: () => number;
}

/**
 * The menu's data, cached in the main process rather than pushed from a window.
 *
 * Rally can be launched hidden at login, and the status item is then the only
 * surface there is — no renderer exists to hold a React Query cache or to answer
 * an IPC request. So this fetches for itself, against the same regional endpoint
 * and credential the rest of main uses.
 */
export class MenuBarContentStore {
  private cached: MenuBarContent = emptyMenuBarContent;
  private inFlight: Promise<void> | null = null;
  private inFlightGeneration = -1;
  private lastRefreshStartedAt = Number.NEGATIVE_INFINITY;
  /**
   * Which account the cache describes. Every request carries the generation it
   * was issued under and publishes only if that is still current, so an answer
   * already on the wire when the account changed is dropped rather than written
   * over what replaced it.
   */
  private generation = 0;

  constructor(private readonly dependencies: MenuBarContentDependencies) {}

  content(): MenuBarContent {
    return this.cached;
  }

  /** Drops everything the previous account could see. Called on sign-out, where
   * leaving the last titles in the menu would keep them readable to whoever
   * signs in next — including through a request that was already in flight when
   * they signed out, which is why this bumps the generation rather than only
   * emptying the cache. */
  clear(): void {
    this.generation += 1;
    this.lastRefreshStartedAt = Number.NEGATIVE_INFINITY;
    if (this.cached === emptyMenuBarContent) return;
    this.cached = emptyMenuBarContent;
    this.dependencies.onChange(this.cached);
  }

  /**
   * Refreshes only if the cache is older than `maxAgeMs`. The pointer reaching
   * the status item is the trigger, and that fires whenever anyone crosses the
   * menu bar; without this the menu would poll the API on mouse movement.
   */
  refreshIfStale(maxAgeMs: number): Promise<void> {
    const now = (this.dependencies.now ?? Date.now)();
    if (now - this.lastRefreshStartedAt < maxAgeMs) return Promise.resolve();
    return this.refresh();
  }

  /**
   * Coalesced, because the pointer reaching the status item and a sign-in can
   * ask within moments of each other, and two overlapping refreshes would race
   * to publish and could leave the older answer in place. Only a request issued
   * under the *current* generation is reused: after a sign-out the answer
   * already in flight describes a state that no longer exists, and handing it
   * back would report it as fresh.
   */
  refresh(): Promise<void> {
    if (this.inFlight && this.inFlightGeneration === this.generation) return this.inFlight;
    const generation = this.generation;
    this.lastRefreshStartedAt = (this.dependencies.now ?? Date.now)();
    const request = this.refreshNow(generation).finally(() => {
      // Only if it is still the newest. A superseded request settling later
      // must not clear the one that replaced it.
      if (this.inFlightGeneration === generation) this.inFlight = null;
    });
    this.inFlight = request;
    this.inFlightGeneration = generation;
    return request;
  }

  private async refreshNow(generation: number): Promise<void> {
    // One request answers both sections. `GET /workstreams` leaves pins out of
    // the recency order and appends every one of them to the first page, so a
    // page of ten carries the ten most recent *unpinned* streams and the whole
    // pinned list behind them.
    const page = await this.load(
      'recent work streams',
      `/workstreams?limit=${MENU_BAR_RECENT_LIMIT}`,
      MenuBarWorkstreamPageSchema,
    );
    if (!page) return;
    // Sign-out while this was on the wire. What came back describes a state
    // that no longer exists.
    if (generation !== this.generation) return;
    const workstreams = page.items.map((workstream) => ({
      pinPosition: workstream.pinPosition,
      entry: {
        id: workstream.id,
        title: workstream.titleStatus === 'naming' || workstream.title.trim().length === 0
          ? UNNAMED_WORKSTREAM_LABEL
          : workstream.title,
        lastActivityAt: workstreamRecencyAt(workstream),
      } satisfies MenuBarWorkstream,
    }));
    this.cached = {
      recents: workstreams
        .filter((workstream) => workstream.pinPosition === null)
        .slice(0, MENU_BAR_RECENT_LIMIT)
        .map((workstream) => workstream.entry),
      // The arrangement is the person's own, so the menu takes the top of it
      // rather than re-sorting. Sorted here because the append is by position
      // already but the order of an appended block is not part of the contract.
      pinned: workstreams
        .filter((workstream) => workstream.pinPosition !== null)
        .sort((left, right) => left.pinPosition! - right.pinPosition!)
        .slice(0, MENU_BAR_PINNED_LIMIT)
        .map((workstream) => workstream.entry),
    };
    this.dependencies.onChange(this.cached);
  }

  private async load<T>(
    description: string,
    path: string,
    schema: z.ZodType<T>,
  ): Promise<T | null> {
    try {
      const parsed = schema.safeParse(await this.dependencies.requestJson(path));
      if (!parsed.success) throw new Error(`Rally returned an unreadable ${description} response`);
      return parsed.data;
    } catch (error) {
      this.dependencies.logWarning(`could not read ${description} for the menu bar`, error);
      return null;
    }
  }
}
