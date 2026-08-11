import { z } from 'zod';
import {
  emptyMenuBarContent,
  MENU_BAR_PINNED_LIMIT,
  MENU_BAR_RECENT_LIMIT,
  type MenuBarContent,
  type MenuBarSuggestion,
  type MenuBarWorkstream,
} from './menu-bar-menu';

/**
 * Deliberately narrower than `@avalon/contracts` describes these responses. The
 * status item needs three strings and a number, and parsing the full work-stream
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
  })),
});

const MenuBarOpportunityPageSchema = z.object({
  items: z.array(z.object({
    id: z.string().min(1),
    version: z.number().int().positive(),
    displayPrompt: z.string().min(1),
  })),
});

const StartedWorkstreamSchema = z.object({
  workstream: z.object({ id: z.string().min(1) }),
});

/** Shown for a work stream Avalon has not finished naming. The renderer draws a
 * skeleton in that state; a menu row cannot, and the placeholder title on the
 * wire is not written to be read. */
const UNNAMED_WORKSTREAM_LABEL = 'Untitled work stream';

export interface MenuBarContentDependencies {
  /** Performs an authorized request against the account's regional API and
   * returns the decoded JSON body. Rejects when nobody is signed in. */
  readonly requestJson: (path: string, init?: { method: 'POST'; body: unknown }) => Promise<unknown>;
  readonly onChange: (content: MenuBarContent) => void;
  readonly logWarning: (message: string, error: unknown) => void;
  /** Injected so the staleness window can be driven in tests. */
  readonly now?: () => number;
}

/**
 * The menu's data, cached in the main process rather than pushed from a window.
 *
 * Avalon can be launched hidden at login, and the status item is then the only
 * surface there is — no renderer exists to hold a React Query cache or to answer
 * an IPC request. So this fetches for itself, against the same regional endpoint
 * and credential the rest of main uses.
 */
export class MenuBarContentStore {
  private cached: MenuBarContent = emptyMenuBarContent;
  private inFlight: Promise<void> | null = null;
  private lastRefreshStartedAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly dependencies: MenuBarContentDependencies) {}

  content(): MenuBarContent {
    return this.cached;
  }

  /** Drops everything the previous account could see. Called on sign-out, where
   * leaving the last titles in the menu would keep them readable to whoever
   * signs in next. */
  clear(): void {
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
   * Refreshes both halves. Coalesced, because the menu asks on every open and
   * the periodic timer asks on its own schedule; two overlapping refreshes would
   * race to publish and could leave the older answer in place.
   */
  refresh(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.lastRefreshStartedAt = (this.dependencies.now ?? Date.now)();
    const request = this.refreshNow().finally(() => {
      this.inFlight = null;
    });
    this.inFlight = request;
    return request;
  }

  private async refreshNow(): Promise<void> {
    // Each half is independent: a failing suggestion poll must not blank the
    // recent list, which is the part a person actually navigates with.
    // One request answers both work-stream sections. `GET /workstreams` leaves
    // pins out of the recency order and appends every one of them to the first
    // page, so a page of five carries the five most recent *unpinned* streams
    // and the whole pinned list behind them.
    const [page, suggestions] = await Promise.all([
      this.load('recent work streams', `/workstreams?limit=${MENU_BAR_RECENT_LIMIT}`, MenuBarWorkstreamPageSchema),
      this.load('suggested work streams', '/work-opportunities?limit=4', MenuBarOpportunityPageSchema),
    ]);
    if (!page && !suggestions) return;
    const workstreams = page?.items.map((workstream) => ({
      pinPosition: workstream.pinPosition,
      entry: {
        id: workstream.id,
        title: workstream.titleStatus === 'naming' || workstream.title.trim().length === 0
          ? UNNAMED_WORKSTREAM_LABEL
          : workstream.title,
      } satisfies MenuBarWorkstream,
    }));
    this.cached = {
      recents: workstreams
        ? workstreams
            .filter((workstream) => workstream.pinPosition === null)
            .slice(0, MENU_BAR_RECENT_LIMIT)
            .map((workstream) => workstream.entry)
        : this.cached.recents,
      // The arrangement is the person's own, so the menu takes the top of it
      // rather than re-sorting. Sorted here because the append is by position
      // already but the order of an appended block is not part of the contract.
      pinned: workstreams
        ? workstreams
            .filter((workstream) => workstream.pinPosition !== null)
            .sort((left, right) => left.pinPosition! - right.pinPosition!)
            .slice(0, MENU_BAR_PINNED_LIMIT)
            .map((workstream) => workstream.entry)
        : this.cached.pinned,
      suggestions: suggestions
        ? suggestions.items.map((opportunity) => ({
            id: opportunity.id,
            version: opportunity.version,
            label: opportunity.displayPrompt,
          }))
        : this.cached.suggestions,
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
      if (!parsed.success) throw new Error(`Avalon returned an unreadable ${description} response`);
      return parsed.data;
    } catch (error) {
      this.dependencies.logWarning(`could not read ${description} for the menu bar`, error);
      return null;
    }
  }

  /**
   * Starts a suggested work stream and returns its identifier so the caller can
   * open it. The suggestion is dropped from the cached menu first: starting one
   * consumes it, and a second click would be rejected by the version check with
   * nothing on screen explaining why.
   */
  async startSuggestion(suggestion: MenuBarSuggestion): Promise<string> {
    this.forget(suggestion.id);
    const response = await this.dependencies.requestJson(
      `/work-opportunities/${encodeURIComponent(suggestion.id)}/start`,
      {
        method: 'POST',
        body: {
          version: suggestion.version,
          // Bounded to this click. A retry after a failure is a new attempt by
          // a person who watched nothing happen, not a duplicate delivery.
          idempotencyKey: crypto.randomUUID(),
        },
      },
    );
    const parsed = StartedWorkstreamSchema.safeParse(response);
    if (!parsed.success) throw new Error('Avalon returned an unreadable started work stream');
    void this.refresh();
    return parsed.data.workstream.id;
  }

  private forget(suggestionId: string): void {
    const suggestions = this.cached.suggestions.filter((item) => item.id !== suggestionId);
    if (suggestions.length === this.cached.suggestions.length) return;
    this.cached = { ...this.cached, suggestions };
    this.dependencies.onChange(this.cached);
  }
}
