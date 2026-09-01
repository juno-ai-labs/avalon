import { z } from 'zod/v3';
import {
  emptyMenuBarContent,
  MENU_BAR_PINNED_LIMIT,
  MENU_BAR_RECENT_LIMIT,
  type MenuBarContent,
  type MenuBarSuggestion,
  type MenuBarWorkstream,
} from './menu-bar-menu';

/**
 * Deliberately narrower than `@rally/contracts` describes these responses. The
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
    pinPosition: z.number().int().safe().nonnegative().nullable().default(null),
  })),
});

const MenuBarOpportunityPageSchema = z.object({
  items: z.array(z.object({
    id: z.string().min(1),
    version: z.number().int().safe().positive(),
    displayPrompt: z.string().min(1),
  })),
});

const StartedWorkstreamSchema = z.object({
  workstream: z.object({ id: z.string().min(1) }),
});

/** Shown for a work stream Rally has not finished naming. The renderer draws a
 * skeleton in that state; a menu row cannot, and the placeholder title on the
 * wire is not written to be read. */
const UNNAMED_WORKSTREAM_LABEL = 'Untitled work stream';

export interface MenuBarContentDependencies {
  /** Performs an authorized request against the account's regional API and
   * returns the decoded JSON body. Rejects when nobody is signed in. */
  readonly requestJson: (path: string, init?: { method: 'POST'; body: unknown }) => Promise<unknown>;
  readonly onChange: (content: MenuBarContent) => void;
  readonly logWarning: (message: string, error: unknown) => void;
  readonly suggestedWorkAvailable: () => boolean;
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
  /** The suggestion set last reported as seen, so opening the menu twice on the
   * same four suggestions is one impression rather than two. */
  private recordedImpressions: string | null = null;
  /**
   * Which account, and which state of it, the cache describes. Every request
   * carries the generation it was issued under and publishes only if that is
   * still current, so an answer already on the wire when the account changed —
   * or when the thing it describes was used up — is dropped rather than written
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
    this.recordedImpressions = null;
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
   * Refreshes both halves.
   *
   * Coalesced, because the pointer reaching the status item and a sign-in can
   * ask within moments of each other, and two overlapping refreshes would race
   * to publish and could leave the older answer in place. Only a request issued
   * under the *current* generation is reused: after a sign-out or a consumed
   * suggestion, the answer already in flight describes a state that no longer
   * exists, and handing it back would report it as fresh.
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
    // Each half is independent: a failing suggestion poll must not blank the
    // recent list, which is the part a person actually navigates with.
    // One request answers both work-stream sections. `GET /workstreams` leaves
    // pins out of the recency order and appends every one of them to the first
    // page, so a page of five carries the five most recent *unpinned* streams
    // and the whole pinned list behind them.
    const [page, suggestions] = await Promise.all([
      this.load('recent work streams', `/workstreams?limit=${MENU_BAR_RECENT_LIMIT}`, MenuBarWorkstreamPageSchema),
      !this.dependencies.suggestedWorkAvailable()
        ? Promise.resolve({ items: [] })
        : this.load('suggested work streams', '/work-opportunities?limit=4', MenuBarOpportunityPageSchema),
    ]);
    if (!page && !suggestions) return;
    // Sign-out, or a suggestion consumed, while this was on the wire. What came
    // back describes a state that no longer exists.
    if (generation !== this.generation) return;
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
      if (!parsed.success) throw new Error(`Rally returned an unreadable ${description} response`);
      return parsed.data;
    } catch (error) {
      this.dependencies.logWarning(`could not read ${description} for the menu bar`, error);
      return null;
    }
  }

  /**
   * Reports the suggestions the drop-down is showing.
   *
   * This is what keeps them moving. The ranking treats an impression as
   * evidence a suggestion was put in front of someone and passed over, and it
   * asks for a re-rank on the strength of it — see `suggested-work.md`. A
   * surface that displays suggestions without reporting them is a free rider:
   * whoever uses only that surface sees the same four indefinitely.
   *
   * Called when the menu opens, never when its content is fetched. The fetch
   * happens as the pointer reaches the status item, and reporting there would
   * count suggestions that were never on screen — pushing the ranking away from
   * work nobody has actually declined.
   *
   * Reported once per distinct set, which is what the home screen does: its
   * effect is keyed on the ids and versions, not on each render.
   */
  async recordImpressions(): Promise<void> {
    if (!this.dependencies.suggestedWorkAvailable()) return;
    const shown = this.cached.suggestions;
    if (shown.length === 0) return;
    const impressions = shown.map((suggestion) => `${suggestion.id}:${suggestion.version}`).join('|');
    if (impressions === this.recordedImpressions) return;
    this.recordedImpressions = impressions;
    try {
      await this.dependencies.requestJson('/work-opportunities/impressions', {
        method: 'POST',
        body: { opportunityIds: shown.map((suggestion) => suggestion.id), surface: 'menu_bar' },
      });
    } catch (error) {
      // Nothing on screen waits on this. Forgetting that it was reported is the
      // point of the reset: the next open tries again rather than treating a
      // failed report as delivered for as long as the set holds.
      //
      // Only if nothing has been reported since. A newer set can be recorded
      // while this POST is still on the wire — the content refreshes and the
      // menu is opened again — and clearing that would report the newer set a
      // second time, which is the invariant this whole field exists to hold.
      if (this.recordedImpressions === impressions) this.recordedImpressions = null;
      this.dependencies.logWarning('could not record menu bar suggestion impressions', error);
    }
  }

  /**
   * Starts a suggested work stream and returns its identifier so the caller can
   * open it. The suggestion is dropped from the cached menu first: starting one
   * consumes it, and a second click would be rejected by the version check with
   * nothing on screen explaining why.
   */
  async startSuggestion(suggestion: MenuBarSuggestion): Promise<string> {
    const position = this.cached.suggestions.findIndex((item) => item.id === suggestion.id) + 1;
    this.forget(suggestion.id);
    const response = await this.dependencies.requestJson(
      `/work-opportunities/${encodeURIComponent(suggestion.id)}/start`,
      {
        method: 'POST',
        body: {
          version: suggestion.version,
          surface: 'menu_bar',
          position,
          // Bounded to this click. A retry after a failure is a new attempt by
          // a person who watched nothing happen, not a duplicate delivery.
          idempotencyKey: crypto.randomUUID(),
        },
      },
    );
    const parsed = StartedWorkstreamSchema.safeParse(response);
    if (!parsed.success) throw new Error('Rally returned an unreadable started work stream');
    // Again, because the service consumed the suggestion only just now. The
    // bump before the POST covers the cache; it cannot cover a refresh issued
    // while the POST was in flight, which asked before the start had happened
    // and so comes back still carrying the suggestion. Moving the generation
    // here discards that answer — and, because `refresh` only reuses a request
    // issued under the current generation, makes the call below a new one
    // rather than a subscription to the stale one.
    this.forget(suggestion.id);
    void this.refresh();
    return parsed.data.workstream.id;
  }

  private forget(suggestionId: string): void {
    // Bumped whether or not the suggestion was cached: a refresh already in
    // flight was issued before the start and would put the consumed suggestion
    // back, where a second click is refused by the version check with nothing on
    // screen explaining why.
    this.generation += 1;
    const suggestions = this.cached.suggestions.filter((item) => item.id !== suggestionId);
    if (suggestions.length === this.cached.suggestions.length) return;
    this.cached = { ...this.cached, suggestions };
    this.dependencies.onChange(this.cached);
  }
}
