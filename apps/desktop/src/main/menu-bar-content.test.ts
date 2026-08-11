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

function workstreamPage(titles: { id: string; title: string; titleStatus?: string }[]): unknown {
  return {
    items: titles.map((entry) => ({
      id: entry.id,
      title: entry.title,
      titleStatus: entry.titleStatus ?? 'settled',
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
      suggestions: [{ id: 'o1', version: 2, label: 'Reply to Dana' }],
    });
    expect(subject.onChange).toHaveBeenCalledTimes(1);
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

    expect(subject.store.content()).toEqual({ recents: [], suggestions: [] });
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
