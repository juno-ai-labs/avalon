import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { MenuBarContentStore, type MenuBarContentDependencies } from './menu-bar-content';
import type { MenuBarContent } from './menu-bar-menu';

type RequestJsonMock = Mock<MenuBarContentDependencies['requestJson']>;

interface Harness {
  store: MenuBarContentStore;
  requestJson: RequestJsonMock;
  onChange: ReturnType<typeof vi.fn>;
  logWarning: ReturnType<typeof vi.fn>;
  advance: (milliseconds: number) => void;
}

const LAST_ACTIVITY = '2026-09-10T18:00:00.000Z';

function workstreamPage(
  titles: {
    id: string;
    title: string;
    titleStatus?: string;
    pinPosition?: number;
    lastActivityAt?: string;
    createdAt?: string;
    lastAccessedAt?: string | null;
  }[],
): unknown {
  return {
    items: titles.map((entry) => ({
      id: entry.id,
      title: entry.title,
      titleStatus: entry.titleStatus ?? 'settled',
      pinPosition: entry.pinPosition ?? null,
      lastActivityAt: entry.lastActivityAt ?? LAST_ACTIVITY,
      ...(entry.createdAt === undefined ? {} : { createdAt: entry.createdAt }),
      ...(entry.lastAccessedAt === undefined ? {} : { lastAccessedAt: entry.lastAccessedAt }),
      // A field the menu never reads. Present so the narrow schema is shown to
      // ignore what it does not need rather than reject it.
      harnessStatus: 'idle',
    })),
  };
}

function entry(id: string, title: string, lastActivityAt = LAST_ACTIVITY): MenuBarContent['recents'][number] {
  return { id, title, lastActivityAt };
}

function harness(): Harness {
  let now = 1_000_000;
  const requestJson = vi.fn<MenuBarContentDependencies['requestJson']>();
  const onChange = vi.fn();
  const logWarning = vi.fn();
  const store = new MenuBarContentStore({
    requestJson,
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

function respond(requestJson: RequestJsonMock, responses: Record<string, unknown>): void {
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
  it('asks for one page of ten and nothing else', async () => {
    respond(subject.requestJson, {
      '/workstreams': workstreamPage([
        { id: 'a', title: 'Acme renewal' },
        { id: 'b', title: 'Quarterly report' },
      ]),
    });

    await subject.store.refresh();

    // One request answers both sections, and the suggestion poll is gone with
    // the section it fed.
    expect(subject.requestJson).toHaveBeenCalledTimes(1);
    expect(subject.requestJson).toHaveBeenCalledWith('/workstreams?limit=10');
    expect(subject.store.content()).toEqual<MenuBarContent>({
      recents: [entry('a', 'Acme renewal'), entry('b', 'Quarterly report')],
      pinned: [],
    });
    expect(subject.onChange).toHaveBeenCalledTimes(1);
  });

  it('carries the recency the sidebar groups by, not merely the last message', async () => {
    respond(subject.requestJson, {
      '/workstreams': workstreamPage([
        // Visited long after the last message: the menu has to group it by the
        // visit, the way the sidebar does, or the same work stream sits under
        // two different headings on the two surfaces.
        {
          id: 'visited',
          title: 'Acme renewal',
          lastActivityAt: '2026-09-01T09:00:00.000Z',
          lastAccessedAt: '2026-09-10T21:55:00.000Z',
        },
        // Never visited: creation, rather than somebody else's message.
        {
          id: 'unvisited',
          title: 'Quarterly report',
          lastActivityAt: '2026-09-01T09:00:00.000Z',
          createdAt: '2026-09-09T08:00:00.000Z',
          lastAccessedAt: null,
        },
        // An older server that does not report visits at all.
        { id: 'legacy', title: 'Hiring loop', lastActivityAt: '2026-09-02T07:00:00.000Z' },
      ]),
    });

    await subject.store.refresh();

    expect(subject.store.content().recents).toEqual([
      entry('visited', 'Acme renewal', '2026-09-10T21:55:00.000Z'),
      entry('unvisited', 'Quarterly report', '2026-09-09T08:00:00.000Z'),
      entry('legacy', 'Hiring loop', '2026-09-02T07:00:00.000Z'),
    ]);
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
    });

    await subject.store.refresh();

    expect(subject.store.content().recents).toEqual([
      entry('r1', 'Quarterly report'),
      entry('r2', 'Investigate ENG-142'),
    ]);
    expect(subject.store.content().pinned).toEqual([
      entry('p1', 'Acme renewal'),
      entry('p2', 'Board deck'),
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
    });

    await subject.store.refresh();

    // The top of the arrangement, by position — not the first five the server
    // happened to append.
    expect(subject.store.content().pinned.map((workstream) => workstream.title))
      .toEqual(['Pinned 8', 'Pinned 7', 'Pinned 6', 'Pinned 5', 'Pinned 4']);
    expect(subject.store.content().recents).toEqual([]);
  });

  it('names a work stream Rally has not finished titling', async () => {
    respond(subject.requestJson, {
      '/workstreams': workstreamPage([{ id: 'a', title: 'placeholder', titleStatus: 'naming' }]),
    });

    await subject.store.refresh();

    expect(subject.store.content().recents).toEqual([entry('a', 'Untitled work stream')]);
  });

  it('keeps the last good menu when a refresh fails', async () => {
    respond(subject.requestJson, {
      '/workstreams': workstreamPage([{ id: 'a', title: 'Acme renewal' }]),
    });
    await subject.store.refresh();

    subject.advance(60_000);
    respond(subject.requestJson, { '/workstreams': new Error('offline') });
    await subject.store.refresh();

    // The recent list is what a person navigates with. A menu emptied by one
    // bad response is worse than one that is a minute out of date.
    expect(subject.store.content().recents).toEqual([entry('a', 'Acme renewal')]);
    expect(subject.logWarning).toHaveBeenCalledTimes(1);
  });

  it('drops an answer that arrives after sign-out', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    subject.requestJson.mockImplementation(() => held.then(() =>
      workstreamPage([{ id: 'a', title: 'Acme renewal' }])));

    const inFlight = subject.store.refresh();
    subject.store.clear();
    release();
    await inFlight;

    // The whole point of clearing: the previous account's titles must not come
    // back through a request that was already on the wire when they signed out.
    expect(subject.store.content()).toEqual({ recents: [], pinned: [] });
  });

  it('does not hand a sign-out-era request back to the account that follows', async () => {
    respond(subject.requestJson, {
      '/workstreams': workstreamPage([{ id: 'a', title: 'Acme renewal' }]),
    });
    const abandoned = subject.store.refresh();
    subject.store.clear();

    const reissued = subject.store.refresh();
    expect(reissued).not.toBe(abandoned);
    await Promise.all([abandoned, reissued]);
    expect(subject.store.content().recents).toEqual([entry('a', 'Acme renewal')]);
  });

  it('coalesces overlapping refreshes', async () => {
    respond(subject.requestJson, {
      '/workstreams': workstreamPage([{ id: 'a', title: 'Acme renewal' }]),
    });

    await Promise.all([subject.store.refresh(), subject.store.refresh(), subject.store.refresh()]);

    expect(subject.requestJson).toHaveBeenCalledTimes(1);
  });

  it('serves the cache until it is stale', async () => {
    respond(subject.requestJson, {
      '/workstreams': workstreamPage([{ id: 'a', title: 'Acme renewal' }]),
    });

    await subject.store.refreshIfStale(15_000);
    subject.advance(14_999);
    await subject.store.refreshIfStale(15_000);
    expect(subject.requestJson).toHaveBeenCalledTimes(1);

    subject.advance(2);
    await subject.store.refreshIfStale(15_000);
    expect(subject.requestJson).toHaveBeenCalledTimes(2);
  });

  it('drops everything the previous account could see on sign-out', async () => {
    respond(subject.requestJson, {
      '/workstreams': workstreamPage([{ id: 'a', title: 'Acme renewal' }]),
    });
    await subject.store.refresh();
    subject.onChange.mockClear();

    subject.store.clear();

    expect(subject.store.content()).toEqual({ recents: [], pinned: [] });
    expect(subject.onChange).toHaveBeenCalledTimes(1);
    // The staleness window is cleared with it, so the next account's menu is
    // not held on an empty cache for another fifteen seconds.
    await subject.store.refreshIfStale(15_000);
    expect(subject.requestJson).toHaveBeenCalledTimes(2);
  });

  it('rejects an unreadable response rather than emptying the menu', async () => {
    respond(subject.requestJson, { '/workstreams': { items: [{ id: 'a' }] } });

    await subject.store.refresh();

    expect(subject.logWarning).toHaveBeenCalledTimes(1);
    expect(subject.store.content().recents).toEqual([]);
  });
});
