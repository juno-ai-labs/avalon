import type { MenuItemConstructorOptions } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import {
  emptyMenuBarContent,
  menuBarLabel,
  menuBarMenuTemplate,
  supportsSectionHeaders,
  MENU_BAR_PINNED_LIMIT,
  MENU_BAR_RECENT_LIMIT,
  type MenuBarActions,
  type MenuBarContent,
} from './menu-bar-menu';

function actions(): MenuBarActions {
  return {
    selected: vi.fn(),
    newMeetingNote: vi.fn(),
    newWorkstream: vi.fn(),
    newAutomation: vi.fn(),
    startSuggestion: vi.fn(),
    openWorkstream: vi.fn(),
    openAvalon: vi.fn(),
    quit: vi.fn(),
  };
}

function template(
  content: Partial<MenuBarContent>,
  overrides: { signedIn?: boolean; sectionHeaders?: boolean; actions?: MenuBarActions; meetingRecordingAvailable?: boolean; suggestedWorkAvailable?: boolean } = {},
): MenuItemConstructorOptions[] {
  return menuBarMenuTemplate({
    appName: 'Avalon',
    content: { ...emptyMenuBarContent, ...content },
    signedIn: overrides.signedIn ?? true,
    meetingRecordingAvailable: overrides.meetingRecordingAvailable ?? true,
    suggestedWorkAvailable: overrides.suggestedWorkAvailable ?? true,
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
  title: `Work stream ${index}`,
}));

describe('menu bar menu', () => {
  it('removes the meeting action when Meeting Recording Enabled is false', () => {
    const items = template(emptyMenuBarContent, { meetingRecordingAvailable: false });

    expect(labels(items)).not.toContain('New Meeting/Note');
    expect(labels(items)).toContain('New Work Stream');
  });

  it('removes the Suggestions section when Suggested Work Enabled is false', () => {
    const items = template({
      suggestions: [{ id: 'opportunity-1', version: 1, label: 'Prepare the brief' }],
    }, { suggestedWorkAvailable: false });

    expect(labels(items)).not.toContain('Suggestions');
    expect(labels(items)).not.toContain('Prepare the brief');
    expect(labels(items)).toContain('Recent');
  });

  it('orders the drop-down as the product contract describes it', () => {
    const items = template({
      suggestions: [
        { id: 'opportunity-1', version: 3, label: 'Reply to the Acme renewal thread' },
        { id: 'opportunity-2', version: 1, label: 'Summarize yesterday’s standup' },
      ],
      recents: workstreams,
      pinned: [{ id: 'pinned-a', title: 'Acme renewal' }, { id: 'pinned-b', title: 'Board deck' }],
    });

    expect(labels(items)).toEqual([
      'New Meeting/Note',
      'New Work Stream',
      'New Automation',
      '—',
      'Suggestions',
      'Reply to the Acme renewal thread',
      'Summarize yesterday’s standup',
      '—',
      'Recent',
      'Work stream 0',
      'Work stream 1',
      'Work stream 2',
      'Work stream 3',
      'Work stream 4',
      '—',
      'Pinned',
      'Acme renewal',
      'Board deck',
      '—',
      'Open Avalon',
      'Quit Avalon',
    ]);
  });

  it('shows the top five of the reader’s own pinned arrangement, in that order', () => {
    const pinned = Array.from({ length: 8 }, (_value, index) => ({
      id: `pinned-${index}`,
      title: `Pinned ${index}`,
    }));
    const items = template({ pinned });
    const pinnedLabels = labels(items).filter((label) => label?.startsWith('Pinned '));

    // Sliced, never re-sorted: the arrangement is the person's, and the store
    // hands it over already ordered.
    expect(pinnedLabels).toEqual(['Pinned 0', 'Pinned 1', 'Pinned 2', 'Pinned 3', 'Pinned 4']);
    expect(pinnedLabels).toHaveLength(MENU_BAR_PINNED_LIMIT);
  });

  it('says how the Pinned section gets filled rather than hiding it', () => {
    const items = template({ recents: workstreams });
    const empty = items.find((item) => item.label === 'Pin a work stream to see it here');

    // A section that is simply absent teaches nobody about a feature they have
    // not found yet.
    expect(items.some((item) => item.label === 'Pinned')).toBe(true);
    expect(empty?.enabled).toBe(false);
    expect(empty?.click).toBeUndefined();
  });

  it('drops Suggestions and Pinned entirely when nobody is signed in', () => {
    const items = template(emptyMenuBarContent, { signedIn: false });

    // Neither has anything to say to a stranger, and the one message that state
    // needs is already on the Recent row.
    expect(labels(items)).toEqual([
      'New Meeting/Note',
      'New Work Stream',
      'New Automation',
      '—',
      'Recent',
      'Sign in to Avalon',
      '—',
      'Open Avalon',
      'Quit Avalon',
    ]);
  });

  it('opens a pinned row the same way a recent one opens', () => {
    const menuActions = actions();
    const items = template({ pinned: [{ id: 'pinned-a', title: 'Acme renewal' }] }, { actions: menuActions });
    activate(items.find((item) => item.label === 'Acme renewal'));

    expect(menuActions.openWorkstream).toHaveBeenCalledWith('pinned-a');
  });

  it('shows no more than five recent work streams', () => {
    const items = template({ suggestions: [], recents: workstreams });
    const recentLabels = labels(items).filter((label) => label?.startsWith('Work stream'));
    expect(recentLabels).toHaveLength(MENU_BAR_RECENT_LIMIT);
  });

  it('renders every group whether or not it has anything in it', () => {
    const items = template({ suggestions: [], recents: workstreams.slice(0, 1) });
    expect(labels(items)).toEqual([
      'New Meeting/Note',
      'New Work Stream',
      'New Automation',
      '—',
      'Suggestions',
      'Connect platforms to get daily suggestions on work streams to create',
      '—',
      'Recent',
      'Work stream 0',
      '—',
      'Pinned',
      'Pin a work stream to see it here',
      '—',
      'Open Avalon',
      'Quit Avalon',
    ]);
  });

  it('names what has to happen before Avalon can suggest anything', () => {
    const empty = template(emptyMenuBarContent)
      .find((item) => item.label === 'Connect platforms to get daily suggestions on work streams to create');

    // With no connector there is nothing to suggest from, so the row says that
    // rather than leaving the section looking broken.
    expect(empty?.enabled).toBe(false);
    expect(empty?.click).toBeUndefined();
  });

  it('heads every group, and puts each empty state directly under its header', () => {
    const items = template(emptyMenuBarContent);

    for (const [title, empty] of [
      ['Suggestions', 'Connect platforms to get daily suggestions on work streams to create'],
      ['Recent', 'No recent work streams'],
      ['Pinned', 'Pin a work stream to see it here'],
    ]) {
      expect(items.find((item) => item.label === title)?.type).toBe('header');
      expect(labels(items).indexOf(title!)).toBe(labels(items).indexOf(empty!) - 1);
    }
  });

  it('falls back to a disabled row where macOS has no section headers', () => {
    const items = template(
      { suggestions: [{ id: 'o1', version: 1, label: 'Reply to Dana' }], recents: workstreams },
      { sectionHeaders: false },
    );

    for (const label of ['Suggestions', 'Recent']) {
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
      { suggestions: [], recents: workstreams },
      { suggestions: [{ id: 'o1', version: 1, label: 'Reply to Dana' }], recents: [] },
      { suggestions: [{ id: 'o1', version: 1, label: 'Reply to Dana' }], recents: workstreams },
      { pinned: [{ id: 'p', title: 'Acme renewal' }] },
      { recents: workstreams, pinned: [{ id: 'p', title: 'Acme renewal' }] },
    ]) {
      const drawn = labels(template(content));
      expect(drawn.some((label, index) => label === '—' && drawn[index + 1] === '—')).toBe(false);
      expect(drawn.at(0)).not.toBe('—');
      expect(drawn.at(-1)).not.toBe('—');
    }
  });

  it('says why the lower half is empty rather than dropping it', () => {
    const signedIn = template(emptyMenuBarContent, { signedIn: true });
    expect(signedIn.find((item) => item.label === 'No recent work streams')?.enabled).toBe(false);

    const signedOut = template(emptyMenuBarContent, { signedIn: false });
    expect(signedOut.find((item) => item.label === 'Sign in to Avalon')?.enabled).toBe(false);
  });

  it('offers no login-item control: that preference lives in Settings', () => {
    const items = template(emptyMenuBarContent);
    // A menu rebuilt only when its content moves cannot be trusted to show a
    // checkbox for state the operating system can change behind it. Settings
    // reads the value fresh every time it opens.
    expect(items.some((item) => item.type === 'checkbox')).toBe(false);
    expect(labels(items).some((label) => label?.toLowerCase().includes('login'))).toBe(false);
  });

  it('routes each row to its action, carrying the suggestion version with it', () => {
    const menuActions = actions();
    const suggestion = { id: 'opportunity-1', version: 4, label: 'Draft the release note' };
    const items = template(
      { suggestions: [suggestion], recents: [workstreams[0]!] },
      { actions: menuActions },
    );
    for (const item of items) activate(item);

    // Headers carry no handler, so activating everything must not produce a
    // stray call.
    expect(items.filter((item) => item.click).length).toBe(7);
    expect(menuActions.newMeetingNote).toHaveBeenCalledTimes(1);
    expect(menuActions.newWorkstream).toHaveBeenCalledTimes(1);
    expect(menuActions.newAutomation).toHaveBeenCalledTimes(1);
    // The version is what the service checks the start against, so it has to
    // travel with the click rather than be re-read from a later refresh.
    expect(menuActions.startSuggestion).toHaveBeenCalledWith(suggestion);
    expect(menuActions.openWorkstream).toHaveBeenCalledWith('workstream-0');
    expect(menuActions.openAvalon).toHaveBeenCalledTimes(1);
    expect(menuActions.quit).toHaveBeenCalledTimes(1);
    expect(vi.mocked(menuActions.selected).mock.calls.map(([action]) => action)).toEqual([
      'new_meeting_note',
      'new_workstream',
      'new_automation',
      'suggested_work',
      'recent_workstream',
      'open_avalon',
      'quit_avalon',
    ]);
  });

  it('does not let failed selection reporting block the menu action', () => {
    const menuActions = actions();
    vi.mocked(menuActions.selected).mockImplementation(() => { throw new Error('telemetry unavailable'); });
    const items = template(emptyMenuBarContent, { actions: menuActions });

    activate(items.find((item) => item.label === 'New Work Stream'));

    expect(menuActions.newWorkstream).toHaveBeenCalledOnce();
  });

  it('reads the macOS version that decides whether section headers exist', () => {
    // macOS 14 introduced them; Avalon targets 26 and 27, where they are the
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
    // 180 characters is what both contracts allow, and a suggested prompt
    // routinely uses them.
    const prompt = 'Prepare the Acme client follow-up and capture every promised action with an owner';
    const truncated = menuBarLabel(prompt);

    expect(truncated).toBe('Prepare the Acme client follow-up and capture every…');
    expect(truncated.length).toBeLessThanOrEqual(60);
    expect(prompt.startsWith(truncated.slice(0, -1))).toBe(true);
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
    expect(label).not.toContain('\uFFFD');
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
