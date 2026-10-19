import type { MenuItemConstructorOptions } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import {
  emptyMenuBarContent,
  menuBarLabel,
  menuBarMenuTemplate,
  menuBarTitle,
  supportsSectionHeaders,
  type MenuBarActions,
  type MenuBarAttentionRow,
  type MenuBarContent,
} from './menu-bar-menu';

function actions(): MenuBarActions {
  return {
    selected: vi.fn(),
    openConversation: vi.fn(),
    openChannel: vi.fn(),
    openAccessRequest: vi.fn(),
    openRally: vi.fn(),
    quit: vi.fn(),
  };
}

function template(
  content: Partial<MenuBarContent>,
  overrides: {
    signedIn?: boolean;
    sectionHeaders?: boolean;
    actions?: MenuBarActions;
  } = {},
): MenuItemConstructorOptions[] {
  return menuBarMenuTemplate({
    appName: 'Rally',
    content: { ...emptyMenuBarContent, attentionComplete: true, recentsComplete: true, ...content },
    signedIn: overrides.signedIn ?? true,
    sectionHeaders: overrides.sectionHeaders ?? true,
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

const workstreams = Array.from({ length: 7 }, (_value, index) => ({
  id: `workstream-${index}`,
  title: `Channel ${index}`,
  substreamId: null,
}));

function main(id: string, title: string, detail = 'Rally finished'): MenuBarAttentionRow {
  return { key: id, workstreamId: id, substreamId: null, title, detail };
}

const waiting = Array.from({ length: 7 }, (_value, index) => main(`waiting-${index}`, `Waiting ${index}`));

describe('menu bar menu', () => {
  it('draws Needs attention, then Most recent, then the app controls', () => {
    const items = template({
      attention: [
        main('a', 'Acme renewal', 'Ana Ruiz mentioned you'),
        {
          key: 'b:s',
          workstreamId: 'b',
          substreamId: 's',
          title: 'Pricing breakout',
          detail: 'Rally finished in Pricing',
        },
      ],
      recents: [{ id: 'c', title: 'Hiring loop', substreamId: null }, { id: 'a', title: 'Acme renewal', substreamId: null }],
    });

    expect(labels(items)).toEqual([
      'Needs attention',
      'Acme renewal',
      'Pricing breakout',
      '—',
      'Most recent',
      'Hiring loop',
      'Acme renewal',
      '—',
      'Open Rally',
      'Quit Rally',
    ]);
    // What happened, as the Activity tab says it.
    expect(items[1]?.sublabel).toBe('Ana Ruiz mentioned you');
    expect(items[2]?.sublabel).toBe('Rally finished in Pricing');
  });

  it('lists access requests first, counts them, and opens one in the main window', () => {
    const subject = actions();
    const items = template({
      accessRequests: [{ id: 'r1', requesterName: 'Samantha Lee', title: 'Hiring plan' }],
      attention: [main('a', 'Acme renewal')],
    }, { actions: subject });

    expect(labels(items).slice(0, 3)).toEqual(['Needs attention', 'Samantha Lee asked to join Hiring plan', 'Acme renewal']);
    expect(items[1]?.sublabel).toBe('Access request');
    activate(items[1]);
    expect(subject.openAccessRequest).toHaveBeenCalledWith('r1');
    expect(subject.selected).toHaveBeenCalledWith('access_request');
    expect(subject.openConversation).not.toHaveBeenCalled();
  });

  it('keeps the section to five rows when requests and conversations share it', () => {
    const drawn = labels(template({
      accessRequests: [0, 1].map((index) => ({ id: `r${index}`, requesterName: `Person ${index}`, title: 'Plan' })),
      attention: waiting,
    }));
    expect(drawn.filter((label) => label?.startsWith('Person') || label?.startsWith('Waiting'))).toEqual([
      'Person 0 asked to join Plan', 'Person 1 asked to join Plan', 'Waiting 0', 'Waiting 1', 'Waiting 2',
    ]);
  });

  it('starts nothing', () => {
    const drawn = labels(template({ attention: waiting, recents: workstreams }));

    for (const label of ['New Meeting/Note', 'New Channel', 'New Automation', 'Suggestions']) {
      expect(drawn).not.toContain(label);
    }
    expect(drawn.at(0)).toBe('Needs attention');
  });

  it('lists at most five rows in each section, in the order given', () => {
    const drawn = labels(template({ attention: waiting, recents: workstreams }));

    expect(drawn.filter((label) => label?.startsWith('Waiting'))).toEqual([
      'Waiting 0', 'Waiting 1', 'Waiting 2', 'Waiting 3', 'Waiting 4',
    ]);
    expect(drawn.filter((label) => label?.startsWith('Channel'))).toEqual([
      'Channel 0', 'Channel 1', 'Channel 2', 'Channel 3', 'Channel 4',
    ]);
  });

  it('says why a section is empty, in the sidebar\'s words', () => {
    const quiet = template({ attention: [], recents: [] });
    expect(labels(quiet)).toEqual([
      'Needs attention',
      'Nothing needs your attention',
      '—',
      'Most recent',
      'No recent threads',
      '—',
      'Open Rally',
      'Quit Rally',
    ]);
    expect(quiet.find((item) => item.label === 'Nothing needs your attention')?.enabled).toBe(false);
  });

  it('never claims nothing is waiting before Activity has been read', () => {
    const loading = labels(template({ attention: [], attentionComplete: false }));
    expect(loading).not.toContain('Nothing needs your attention');
    expect(loading).toContain('Still loading activity');

    // Rows read so far are real, and the line under them says they may not be all.
    const partial = labels(template({ attention: [main('a', 'Acme')], attentionComplete: false }));
    expect(partial.slice(0, 3)).toEqual(['Needs attention', 'Acme', 'Still loading activity']);
  });

  it('never claims there are no recent threads before every Space has been walked', () => {
    const loading = labels(template({ recents: [], recentsComplete: false }));
    expect(loading).not.toContain('No recent threads');
    expect(loading.slice(loading.indexOf('Most recent'), loading.indexOf('Most recent') + 2))
      .toEqual(['Most recent', 'Still loading threads']);

    // Rows already walked are drawn as they are, with no line under them.
    const partial = labels(template({ recents: [workstreams[0]!], recentsComplete: false }));
    expect(partial).toContain('Channel 0');
    expect(partial).not.toContain('Still loading threads');
  });

  it('shows the signed-out state once, with nothing to list', () => {
    expect(labels(template({ attention: waiting, recents: workstreams }, { signedIn: false }))).toEqual([
      'Needs attention',
      'Sign in to Rally',
      '—',
      'Open Rally',
      'Quit Rally',
    ]);
  });

  it('heads both sections, and falls back to a disabled row where macOS has no section headers', () => {
    const items = template({ attention: waiting, recents: workstreams });
    for (const label of ['Needs attention', 'Most recent']) {
      expect(items.find((item) => item.label === label)?.type).toBe('header');
    }

    const old = template({ attention: waiting, recents: workstreams }, { sectionHeaders: false });
    for (const label of ['Needs attention', 'Most recent']) {
      const header = old.find((item) => item.label === label);
      expect(header?.type).toBeUndefined();
      // Still unclickable: a header that could be activated is a menu row that
      // does nothing, which is worse than an unstyled one.
      expect(header?.enabled).toBe(false);
      expect(header?.click).toBeUndefined();
    }
  });

  it('never draws two rules in a row, or a rule at either end', () => {
    for (const content of [{}, { attention: waiting }, { recents: workstreams }, { attentionComplete: false }]) {
      for (const overrides of [{}, { signedIn: false }]) {
        const drawn = labels(template(content, overrides));
        expect(drawn.some((label, index) => label === '—' && drawn[index + 1] === '—')).toBe(false);
        expect(drawn.at(0)).not.toBe('—');
        expect(drawn.at(-1)).not.toBe('—');
      }
    }
  });

  it('offers no login-item control: that preference lives in Settings', () => {
    const items = template({});
    expect(items.some((item) => item.type === 'checkbox')).toBe(false);
    expect(labels(items).some((label) => label?.toLowerCase().includes('login'))).toBe(false);
  });

  it('routes each row to its conversation', () => {
    const menuActions = actions();
    const items = template(
      {
        attention: [{
          key: 'b:s', workstreamId: 'b', substreamId: 's', title: 'Breakout', detail: 'New breakout in Pricing',
        }],
        recents: [{ id: 'workstream-0', title: 'Renewal thread', substreamId: null }],
      },
      { actions: menuActions },
    );
    for (const item of items) activate(item);

    // Headers carry no handler, so activating everything must not produce a
    // stray call.
    expect(items.filter((item) => item.click).length).toBe(4);
    expect(vi.mocked(menuActions.openConversation).mock.calls).toEqual([['b', 's'], ['workstream-0', null]]);
    expect(menuActions.openRally).toHaveBeenCalledTimes(1);
    expect(menuActions.quit).toHaveBeenCalledTimes(1);
    expect(vi.mocked(menuActions.selected).mock.calls.map(([action]) => action)).toEqual([
      'attention_conversation',
      'recent_workstream',
      'open_rally',
      'quit_rally',
    ]);
  });

  it('does not let failed selection reporting block the menu action', () => {
    const menuActions = actions();
    vi.mocked(menuActions.selected).mockImplementation(() => { throw new Error('telemetry unavailable'); });
    const items = template({}, { actions: menuActions });

    activate(items.find((item) => item.label === 'Open Rally'));

    expect(menuActions.openRally).toHaveBeenCalledOnce();
  });

  it('writes the count beside the icon the way the sidebar button does', () => {
    expect(menuBarTitle(0)).toBe('');
    expect(menuBarTitle(1)).toBe('1');
    expect(menuBarTitle(99)).toBe('99');
    expect(menuBarTitle(100)).toBe('99+');
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
