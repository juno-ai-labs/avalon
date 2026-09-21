import type { MenuItemConstructorOptions } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import {
  emptyMenuBarContent,
  menuBarLabel,
  menuBarMenuTemplate,
  supportsSectionHeaders,
  MENU_BAR_RECENT_LIMIT,
  type MenuBarActions,
  type MenuBarContent,
} from './menu-bar-menu';

function actions(): MenuBarActions {
  return {
    selected: vi.fn(),
    openWorkstream: vi.fn(),
    openRally: vi.fn(),
    quit: vi.fn(),
  };
}

/** Pinned to a Thursday so every recency heading has a reachable timestamp:
 * Sunday-start means "This week" needs a day between Monday and Tuesday here. */
const NOW = new Date('2026-09-10T22:21:00');

function at(offsetMs: number): string {
  return new Date(NOW.getTime() - offsetMs).toISOString();
}

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

function template(
  content: Partial<MenuBarContent>,
  overrides: {
    signedIn?: boolean;
    sectionHeaders?: boolean;
    actions?: MenuBarActions;
    now?: Date;
  } = {},
): MenuItemConstructorOptions[] {
  return menuBarMenuTemplate({
    appName: 'Rally',
    content: { ...emptyMenuBarContent, ...content },
    signedIn: overrides.signedIn ?? true,
    sectionHeaders: overrides.sectionHeaders ?? true,
    now: overrides.now ?? NOW,
    actions: overrides.actions ?? actions(),
  });
}

/** `click` is declared with the menu item, window, and event AppKit passes; the
 * template's own handlers ignore all three. */
function activate(item: MenuItemConstructorOptions | undefined): void {
  (item?.click as (() => void) | undefined)?.();
}

function labels(items: MenuItemConstructorOptions[]): (string | undefined)[] {
  return items.map((item) => (item.type === 'separator' ? '—' : item.label));
}

/** Twelve work streams, each half an hour older than the last, so the whole set
 * lands inside "Last hour" and "Today" and the recent limit is what cuts it. */
const workstreams = Array.from({ length: 12 }, (_value, index) => ({
  id: `workstream-${index}`,
  title: `Channel ${index}`,
  lastActivityAt: at(index * 30 * MINUTE),
}));

describe('menu bar menu', () => {
  it('starts nothing: the menu opens straight on its first section', () => {
    // Every row that started something is gone — a meeting or note, a work
    // stream, an automation. This surface reopens what already exists; starting
    // belongs in the app, which the last two rows open.
    const drawn = labels(template({ recents: workstreams }));

    for (const label of ['New Meeting/Note', 'New Channel', 'New Automation']) {
      expect(drawn).not.toContain(label);
    }
    // Nothing precedes the first header, so the leading rule has to be
    // suppressed rather than drawn against nothing.
    expect(drawn.at(0)).toBe('Last hour');
  });

  it('offers nothing to do with suggested work', () => {
    // The Suggestions section is gone whole, header and empty state with it.
    const drawn = labels(template({ recents: workstreams }));

    expect(drawn).not.toContain('Suggestions');
    expect(drawn.some((label) => label?.includes('suggestions'))).toBe(false);
  });

  it('orders the drop-down as the product contract describes it', () => {
    const items = template({
      recents: [
        { id: 'recent-a', title: 'Renewal thread', lastActivityAt: at(5 * MINUTE) },
        { id: 'recent-b', title: 'Standup notes', lastActivityAt: at(4 * HOUR) },
        { id: 'recent-c', title: 'Hiring loop', lastActivityAt: at(DAY) },
        { id: 'recent-d', title: 'Pricing model', lastActivityAt: at(3 * DAY) },
        { id: 'recent-e', title: 'Offsite plan', lastActivityAt: at(7 * DAY) },
        { id: 'recent-f', title: 'Series A memo', lastActivityAt: at(200 * DAY) },
      ],
    });

    // The recent list uses the sidebar's own headings rather than one flat
    // "Recent" block. This surface has no selected Space, so it has no pins.
    expect(labels(items)).toEqual([
      'Last hour',
      'Renewal thread',
      '—',
      'Today',
      'Standup notes',
      '—',
      'Yesterday',
      'Hiring loop',
      '—',
      'This week',
      'Pricing model',
      '—',
      'This month',
      'Offsite plan',
      '—',
      'Before this month',
      'Series A memo',
      '—',
      'Open Rally',
      'Quit Rally',
    ]);
  });

  it('groups the recent channels the way the sidebar groups them', () => {
    const items = template({
      recents: [
        { id: 'a', title: 'Just now', lastActivityAt: at(MINUTE) },
        { id: 'b', title: 'Earlier today', lastActivityAt: at(6 * HOUR) },
        { id: 'c', title: 'Also earlier today', lastActivityAt: at(8 * HOUR) },
      ],
    });

    expect(labels(items)).toEqual([
      'Last hour',
      'Just now',
      '—',
      'Today',
      'Earlier today',
      'Also earlier today',
      '—',
      'Open Rally',
      'Quit Rally',
    ]);
  });

  it('orders the recent rows newest first, whatever order they arrive in', () => {
    const items = template({
      recents: [
        { id: 'c', title: 'Oldest', lastActivityAt: at(9 * HOUR) },
        { id: 'a', title: 'Newest', lastActivityAt: at(2 * HOUR) },
        { id: 'b', title: 'Middle', lastActivityAt: at(5 * HOUR) },
      ],
    });

    expect(labels(items).filter((label) => ['Newest', 'Middle', 'Oldest'].includes(label ?? '')))
      .toEqual(['Newest', 'Middle', 'Oldest']);
  });

  it('shows the signed-out empty state', () => {
    const items = template(emptyMenuBarContent, { signedIn: false });

    // It has nothing to say to a stranger, and the one message that state needs
    // is already on the Recent row.
    expect(labels(items)).toEqual([
      'Recent',
      'Sign in to Rally',
      '—',
      'Open Rally',
      'Quit Rally',
    ]);
  });

  it('shows no more than ten recent channels', () => {
    const items = template({ recents: workstreams });
    const recentLabels = labels(items).filter((label) => label?.startsWith('Channel'));

    expect(recentLabels).toHaveLength(MENU_BAR_RECENT_LIMIT);
    expect(MENU_BAR_RECENT_LIMIT).toBe(10);
    // Cut from the end of the recency order, so it is the oldest two that go.
    expect(recentLabels).not.toContain('Channel 10');
    expect(recentLabels).not.toContain('Channel 11');
  });

  it('names the recent section only when it has nothing to head', () => {
    // With rows, the recency headings name themselves and a second "Recent"
    // above them would label the same list twice. With none there is no
    // recency to name, and a bare disabled sentence reads as a broken item.
    expect(labels(template({ recents: workstreams }))).not.toContain('Recent');
    expect(labels(template(emptyMenuBarContent))).toContain('Recent');
  });

  it('draws no header without rows under it, whatever a caller passes', () => {
    // The guarantee `pushGroup` exists to hold: a header with a rule on either
    // side and nothing between them reads as a menu that failed to draw.
    for (const content of [
      emptyMenuBarContent,
      { recents: workstreams },
    ]) {
      for (const overrides of [{}, { signedIn: false }]) {
        const items = template(content, overrides);
        items.forEach((item, index) => {
          if (item.type !== 'header') return;
          const next = items[index + 1];
          expect(next).toBeDefined();
          expect(next?.type).not.toBe('separator');
          expect(next?.type).not.toBe('header');
        });
      }
    }
  });

  it('heads every group, and puts each empty state directly under its header', () => {
    const items = template(emptyMenuBarContent);

    expect(items.find((item) => item.label === 'Recent')?.type).toBe('header');
    expect(labels(items).indexOf('Recent')).toBe(labels(items).indexOf('No recent channels') - 1);
  });

  it('heads every recency group it draws', () => {
    const items = template({ recents: workstreams });

    for (const label of ['Last hour', 'Today']) {
      expect(items.find((item) => item.label === label)?.type).toBe('header');
    }
  });

  it('falls back to a disabled row where macOS has no section headers', () => {
    const items = template({ recents: workstreams }, { sectionHeaders: false });

    for (const label of ['Last hour']) {
      const header = items.find((item) => item.label === label);
      expect(header?.type).toBeUndefined();
      // Still unclickable: a header that could be activated is a menu row that
      // does nothing, which is worse than an unstyled one.
      expect(header?.enabled).toBe(false);
      expect(header?.click).toBeUndefined();
    }
  });

  it('never draws two rules in a row, whatever the content is', () => {
    for (const content of [
      emptyMenuBarContent,
      { recents: workstreams },
      { recents: [{ id: 'a', title: 'Old', lastActivityAt: at(400 * DAY) }] },
    ]) {
      for (const overrides of [{}, { signedIn: false }]) {
        const drawn = labels(template(content, overrides));
        expect(drawn.some((label, index) => label === '—' && drawn[index + 1] === '—')).toBe(false);
        expect(drawn.at(0)).not.toBe('—');
        expect(drawn.at(-1)).not.toBe('—');
      }
    }
  });

  it('says why the lower half is empty rather than dropping it', () => {
    const signedIn = template(emptyMenuBarContent, { signedIn: true });
    expect(signedIn.find((item) => item.label === 'No recent channels')?.enabled).toBe(false);

    const signedOut = template(emptyMenuBarContent, { signedIn: false });
    expect(signedOut.find((item) => item.label === 'Sign in to Rally')?.enabled).toBe(false);
  });

  it('offers no login-item control: that preference lives in Settings', () => {
    const items = template(emptyMenuBarContent);
    // A menu rebuilt only when its content moves cannot be trusted to show a
    // checkbox for state the operating system can change behind it. Settings
    // reads the value fresh every time it opens.
    expect(items.some((item) => item.type === 'checkbox')).toBe(false);
    expect(labels(items).some((label) => label?.toLowerCase().includes('login'))).toBe(false);
  });

  it('routes each row to its action', () => {
    const menuActions = actions();
    const items = template(
      {
        recents: [{ id: 'workstream-0', title: 'Renewal thread', lastActivityAt: at(MINUTE) }],
      },
      { actions: menuActions },
    );
    for (const item of items) activate(item);

    // Headers carry no handler, so activating everything must not produce a
    // stray call.
    expect(items.filter((item) => item.click).length).toBe(3);
    expect(menuActions.openWorkstream).toHaveBeenCalledWith('workstream-0');
    expect(menuActions.openRally).toHaveBeenCalledTimes(1);
    expect(menuActions.quit).toHaveBeenCalledTimes(1);
    expect(vi.mocked(menuActions.selected).mock.calls.map(([action]) => action)).toEqual([
      'recent_workstream',
      'open_rally',
      'quit_rally',
    ]);
  });

  it('does not let failed selection reporting block the menu action', () => {
    const menuActions = actions();
    vi.mocked(menuActions.selected).mockImplementation(() => { throw new Error('telemetry unavailable'); });
    const items = template(emptyMenuBarContent, { actions: menuActions });

    activate(items.find((item) => item.label === 'Open Rally'));

    expect(menuActions.openRally).toHaveBeenCalledOnce();
  });

  it('reads the macOS version that decides whether section headers exist', () => {
    // macOS 14 introduced them; Rally targets 26 and 27, where they are the
    // native treatment.
    expect(supportsSectionHeaders('26.1')).toBe(true);
    expect(supportsSectionHeaders('14.0.0')).toBe(true);
    expect(supportsSectionHeaders('13.6.1')).toBe(false);
    expect(supportsSectionHeaders('')).toBe(false);
  });

  it('flattens a model-written title into one readable row', () => {
    expect(menuBarLabel('  Reply to\n  the Acme  thread ')).toBe('Reply to the Acme thread');
    expect(menuBarLabel('Reply to Dana')).toBe('Reply to Dana');
  });

  it('truncates a long label at a word boundary, never mid-word', () => {
    // 180 characters is what the work-stream contract allows, and a title Rally
    // wrote itself can run most of them.
    const title = 'Prepare the Acme client follow-up and capture every promised action with an owner';
    const truncated = menuBarLabel(title);

    expect(truncated).toBe('Prepare the Acme client follow-up and capture every…');
    expect(truncated.length).toBeLessThanOrEqual(60);
    expect(title.startsWith(truncated.slice(0, -1))).toBe(true);
  });

  it('drops punctuation left dangling by the cut', () => {
    expect(menuBarLabel('Investigate ENG-142, ENG-143, and the retry storm behind both of them'))
      .toBe('Investigate ENG-142, ENG-143, and the retry storm behind…');
  });

  it('cuts between characters a reader sees, never through one', () => {
    // 70 visible characters, 140 code units, and no space to retreat to — so
    // the cut is hard and lands where a code-unit slice would split a pair.
    const label = menuBarLabel('🎯'.repeat(70));

    // A slice by code unit lands inside a surrogate pair and renders as `�`
    // immediately before the ellipsis.
    expect(label).not.toContain('�');
    expect([...label].every((character) => character !== '\uD83C' && character !== '\uDFAF')).toBe(true);
    expect(label.endsWith('…')).toBe(true);
    expect([...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(label)].length)
      .toBeLessThanOrEqual(60);
  });

  it('cuts hard when trimming to a word would leave a stub', () => {
    // One long word, or a boundary too near the start: the space saved is worth
    // less than the label it would throw away.
    const single = menuBarLabel('x'.repeat(200));
    expect(single).toHaveLength(60);
    expect(single.endsWith('…')).toBe(true);

    expect(menuBarLabel(`Acme ${'y'.repeat(120)}`)).toBe(`Acme ${'y'.repeat(54)}…`);
  });
});
