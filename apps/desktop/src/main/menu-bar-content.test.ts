import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MenuBarContentStore } from './menu-bar-content';
import type { MenuBarContent } from './menu-bar-menu';

interface Harness {
  store: MenuBarContentStore;
  requestJson: ReturnType<typeof vi.fn>;
  onChange: ReturnType<typeof vi.fn>;
  logWarning: ReturnType<typeof vi.fn>;
  advance: (milliseconds: number) => void;
}

function workstreamPage(
  titles: { id: string; title: string; titleStatus?: string; pinPosition?: number }[],
): unknown {
  return {
    items: titles.map((entry) => ({
      id: entry.id,
      title: entry.title,
      titleStatus: entry.titleStatus ?? 'settled',
      pinPosition: entry.pinPosition ?? null,
      // A field the menu never reads. Present so the narrow schema is shown to
      // ignore what it does not need rather than reject it.
      harnessStatus: 'idle',
    })),
  };
}

function harness(): Harness {
  let now = 1_000_000;
  const requestJson = vi.fn();
  const onChange = vi.fn();
  const logWarning = vi.fn();
  const store = new MenuBarContentStore({
    requestJson: requestJson as unknown as (path: string) => Promise<unknown>,
    onChange,
    logWarning,
    now: () => now,
  });
  return {
    store,
    requestJson,
    onChange,
    logWarning,
    advance: (milliseconds) => {
      now += milliseconds;
    },
  };
}

function respond(requestJson: ReturnType<typeof vi.fn>, responses: Record<string, unknown>): void {
  requestJson.mockImplementation((path: string) => {
    const match = Object.entries(responses).find(([prefix]) => path.startsWith(prefix));
    if (!match) return Promise.reject(new Error(`Unexpected request: ${path}`));
    const [, response] = match;
    return response instanceof Error ? Promise.reject(response) : Promise.resolve(response);
  });
}

let subject: Harness;

beforeEach(() => {
  subject = harness();
});

describe('menu bar content', () => {
  it('reads the five most recent work streams and everything Avalon suggests', async () => {
    respond(subject.requestJson, {
      '/workstreams': workstreamPage([
        { id: 'a', title: 'Acme renewal' },
        { id: 'b', title: 'Quarterly report' },
      ]),
      '/work-opportunities': {
        items: [{ id: 'o1', version: 2, displayPrompt: 'Reply to Dana', icon: 'sparkles', sourceLabel: 'Gmail' }],
      },
    });

    await subject.store.refresh();

    expect(subject.requestJson).toHaveBeenCalledWith('/workstreams?limit=5');
    expect(subject.store.content()).toEqual<MenuBarContent>({
      recents: [{ id: 'a', title: 'Acme renewal' }, { id: 'b', title: 'Quarterly report' }],
      pinned: [],
      suggestions: [{ id: 'o1', version: 2, label: 'Reply to Dana' }],
    });
    expect(subject.onChange).toHaveBeenCalledTimes(1);
  });

  it('splits the one page into the recent list and the pinned arrangement', async () => {
    // `GET /workstreams` leaves pins out of the recency order and appends the
    // whole pinned list to the first page, in no contractually fixed order.
    respond(subject.requestJson, {
      '/workstreams': workstreamPage([
        { id: 'r1', title: 'Quarterly report' },
        { id: 'r2', title: 'Investigate ENG-142' },
        { id: 'p2', title: 'Board deck', pinPosition: 1 },
        { id: 'p1', title: 'Acme renewal', pinPosition: 0 },
      ]),
      '/work-opportunities': { items: [] },
    });

    await subject.store.refresh();

    expect(subject.store.content().recents).toEqual([
      { id: 'r1', title: 'Quarterly report' },
      { id: 'r2', title: 'Investigate ENG-142' },
    ]);
    expect(subject.store.content().pinned).toEqual([
      { id: 'p1', title: 'Acme renewal' },
      { id: 'p2', title: 'Board deck' },
    ]);
  });

  it('shows at most five pins without capping how many exist', async () => {
    respond(subject.requestJson, {
      '/workstreams': workstreamPage(
        Array.from({ length: 9 }, (_value, index) => ({
          id: `p${index}`,
          title: `Pinned ${index}`,
          pinPosition: 8 - index,
        })),
      ),
      '/work-opportunities': { items: [] },
    });

    await subject.store.refresh();

    // The top of the arrangement, by position — not the first five the server
    // happened to append.
    expect(subject.store.content().pinned.map((workstream) => workstream.title))
      .toEqual(['Pinned 8', 'Pinned 7', 'Pinned 6', 'Pinned 5', 'Pinned 4']);
    expect(subject.store.content().recents).toEqual([]);
  });

  it('names a work stream Avalon has not finished titling', async () => {
    respond(subject.requestJson, {
      '/workstreams': workstreamPage([{ id: 'a', title: 'placeholder', titleStatus: 'naming' }]),
      '/work-opportunities': { items: [] },
    });

    await subject.store.refresh();

    expect(subject.store.content().recents).toEqual([{ id: 'a', title: 'Untitled work stream' }]);
  });

  it('keeps the half that answered when the other fails', async () => {
    respond(subject.requestJson, {
      '/workstreams': workstreamPage([{ id: 'a', title: 'Acme renewal' }]),
      '/work-opportunities': { items: [{ id: 'o1', version: 1, displayPrompt: 'Reply to Dana' }] },
    });
    await subject.store.refresh();

    subject.advance(60_000);
    respond(subject.requestJson, {
      '/workstreams': workstreamPage([{ id: 'b', title: 'Quarterly report' }]),
      '/work-opportunities': new Error('offline'),
    });
    await subject.store.refresh();

    // The recent list is what a person navigates with. A failing suggestion
    // poll must not take it down with it.
    expect(subject.store.content().recents).toEqual([{ id: 'b', title: 'Quarterly report' }]);
    expect(subject.store.content().suggestions).toEqual([{ id: 'o1', version: 1, label: 'Reply to Dana' }]);
    expect(subject.logWarning).toHaveBeenCalledTimes(1);
  });

  it('drops an answer that arrives after sign-out', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    subject.requestJson.mockImplementation((path: string) => held.then(() =>
      path.startsWith('/workstreams')
        ? workstreamPage([{ id: 'a', title: 'Acme renewal' }])
        : { items: [] }));

    const inFlight = subject.store.refresh();
    subject.store.clear();
    release();
    await inFlight;

    // The whole point of clearing: the previous account's titles must not come
    // back through a request that was already on the wire when they signed out.
    expect(subject.store.content()).toEqual({ recents: [], pinned: [], suggestions: [] });
  });

  it('does not hand a sign-out-era request back to the account that follows', async () => {
    respond(subject.requestJson, {
      '/workstreams': workstreamPage([{ id: 'a', title: 'Acme renewal' }]),
      '/work-opportunities': { items: [] },
    });
    const abandoned = subject.store.refresh();
    subject.store.clear();

    const reissued = subject.store.refresh();
    expect(reissued).not.toBe(abandoned);
    await Promise.all([abandoned, reissued]);
    expect(subject.store.content().recents).toEqual([{ id: 'a', title: 'Acme renewal' }]);
  });

  it('does not let a refresh already in flight put a started suggestion back', async () => {
    let releaseStale: () => void = () => undefined;
    const stalePage = new Promise<void>((resolve) => {
      releaseStale = resolve;
    });
    let started = false;
    subject.requestJson.mockImplementation((path: string) => {
      if (path.includes('/start')) {
        started = true;
        return Promise.resolve({ workstream: { id: 'created' } });
      }
      // The poll already on the wire still carries the suggestion; by the one
      // issued after the start, the service has consumed it.
      const body = path.startsWith('/work-opportunities')
        ? { items: started ? [] : [{ id: 'o1', version: 5, displayPrompt: 'Reply to Dana' }] }
        : workstreamPage([]);
      return started ? Promise.resolve(body) : stalePage.then(() => body);
    });

    const stale = subject.store.refresh();
    await subject.store.startSuggestion({ id: 'o1', version: 5, label: 'Reply to Dana' });
    await subject.store.refresh();
    releaseStale();
    await stale;

    // Starting consumes it. A second click would be refused by the version
    // check with nothing on screen explaining why.
    expect(subject.store.content().suggestions).toEqual([]);
  });

  it('coalesces overlapping refreshes', async () => {
    respond(subject.requestJson, {
      '/workstreams': workstreamPage([{ id: 'a', title: 'Acme renewal' }]),
      '/work-opportunities': { items: [] },
    });

    await Promise.all([subject.store.refresh(), subject.store.refresh(), subject.store.refresh()]);

    expect(subject.requestJson).toHaveBeenCalledTimes(2);
  });

  it('serves the cache until it is stale', async () => {
    respond(subject.requestJson, {
      '/workstreams': workstreamPage([{ id: 'a', title: 'Acme renewal' }]),
      '/work-opportunities': { items: [] },
    });

    await subject.store.refreshIfStale(15_000);
    subject.advance(14_999);
    await subject.store.refreshIfStale(15_000);
    expect(subject.requestJson).toHaveBeenCalledTimes(2);

    subject.advance(2);
    await subject.store.refreshIfStale(15_000);
    expect(subject.requestJson).toHaveBeenCalledTimes(4);
  });

  it('drops everything the previous account could see on sign-out', async () => {
    respond(subject.requestJson, {
      '/workstreams': workstreamPage([{ id: 'a', title: 'Acme renewal' }]),
      '/work-opportunities': { items: [] },
    });
    await subject.store.refresh();
    subject.onChange.mockClear();

    subject.store.clear();

    expect(subject.store.content()).toEqual({ recents: [], pinned: [], suggestions: [] });
    expect(subject.onChange).toHaveBeenCalledTimes(1);
    // The staleness window is cleared with it, so the next account's menu is
    // not held on an empty cache for another fifteen seconds.
    await subject.store.refreshIfStale(15_000);
    expect(subject.requestJson).toHaveBeenCalledTimes(4);
  });

  it('starts a suggestion, forgets it, and returns the work stream to open', async () => {
    respond(subject.requestJson, {
      '/workstreams': workstreamPage([]),
      '/work-opportunities/o1/start': { workstream: { id: 'created' } },
      '/work-opportunities': { items: [{ id: 'o1', version: 5, displayPrompt: 'Reply to Dana' }] },
    });
    await subject.store.refresh();

    const started = await subject.store.startSuggestion({ id: 'o1', version: 5, label: 'Reply to Dana' });

    expect(started).toBe('created');
    expect(subject.requestJson).toHaveBeenCalledWith(
      '/work-opportunities/o1/start',
      expect.objectContaining({ method: 'POST', body: expect.objectContaining({ version: 5 }) }),
    );
    // Starting consumes the suggestion. A second click would be refused by the
    // version check with nothing on screen to explain it.
    expect(subject.store.content().suggestions).toEqual([]);
  });

  it('reports the suggestions the menu shows, once per set', async () => {
    respond(subject.requestJson, {
      '/workstreams': workstreamPage([]),
      '/work-opportunities/impressions': {},
      '/work-opportunities': { items: [{ id: 'o1', version: 2, displayPrompt: 'Reply to Dana' }] },
    });
    await subject.store.refresh();
    subject.requestJson.mockClear();

    await subject.store.recordImpressions();
    await subject.store.recordImpressions();

    // Seeing the same four twice is one impression, which is what the home
    // screen records: its effect is keyed on the ids and versions.
    expect(subject.requestJson).toHaveBeenCalledTimes(1);
    expect(subject.requestJson).toHaveBeenCalledWith('/work-opportunities/impressions', {
      method: 'POST',
      body: { opportunityIds: ['o1'] },
    });
  });

  it('reports nothing when the menu is showing no suggestions', async () => {
    await subject.store.recordImpressions();
    expect(subject.requestJson).not.toHaveBeenCalled();
  });

  it('tries again after a failed report rather than treating it as delivered', async () => {
    respond(subject.requestJson, {
      '/workstreams': workstreamPage([]),
      '/work-opportunities/impressions': new Error('offline'),
      '/work-opportunities': { items: [{ id: 'o1', version: 2, displayPrompt: 'Reply to Dana' }] },
    });
    await subject.store.refresh();
    subject.requestJson.mockClear();

    await subject.store.recordImpressions();
    await subject.store.recordImpressions();

    expect(subject.requestJson).toHaveBeenCalledTimes(2);
    expect(subject.logWarning).toHaveBeenCalledTimes(2);
  });

  it('rejects an unreadable response rather than emptying the menu', async () => {
    respond(subject.requestJson, {
      '/workstreams': { items: [{ id: 'a' }] },
      '/work-opportunities': { items: [] },
    });

    await subject.store.refresh();

    expect(subject.logWarning).toHaveBeenCalledTimes(1);
    expect(subject.store.content().recents).toEqual([]);
  });
});
