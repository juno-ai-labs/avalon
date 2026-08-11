import type { MenuItemConstructorOptions } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import {
  emptyMenuBarContent,
  menuBarLabel,
  menuBarMenuTemplate,
  MENU_BAR_RECENT_LIMIT,
  type MenuBarActions,
  type MenuBarContent,
} from './menu-bar-menu';

function actions(): MenuBarActions {
  return {
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
  content: MenuBarContent,
  overrides: { signedIn?: boolean; actions?: MenuBarActions } = {},
): MenuItemConstructorOptions[] {
  return menuBarMenuTemplate({
    appName: 'Avalon',
    content,
    signedIn: overrides.signedIn ?? true,
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
  it('orders the drop-down as the product contract describes it', () => {
    const items = template({
      suggestions: [
        { id: 'opportunity-1', version: 3, label: 'Reply to the Acme renewal thread' },
        { id: 'opportunity-2', version: 1, label: 'Summarize yesterday’s standup' },
      ],
      recents: workstreams,
    });

    expect(labels(items)).toEqual([
      'New Meeting/Note',
      'New Work Stream',
      'New Automation',
      'Reply to the Acme renewal thread',
      'Summarize yesterday’s standup',
      '—',
      'Work stream 0',
      'Work stream 1',
      'Work stream 2',
      'Work stream 3',
      'Work stream 4',
      '—',
      'Open Avalon',
      'Quit Avalon',
    ]);
  });

  it('shows no more than five recent work streams', () => {
    const items = template({ suggestions: [], recents: workstreams });
    const recentLabels = labels(items).filter((label) => label?.startsWith('Work stream'));
    expect(recentLabels).toHaveLength(MENU_BAR_RECENT_LIMIT);
  });

  it('keeps the rule and all three fixed actions when Avalon has nothing to suggest', () => {
    const items = template({ suggestions: [], recents: workstreams.slice(0, 1) });
    expect(labels(items)).toEqual([
      'New Meeting/Note',
      'New Work Stream',
      'New Automation',
      '—',
      'Work stream 0',
      '—',
      'Open Avalon',
      'Quit Avalon',
    ]);
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

    expect(menuActions.newMeetingNote).toHaveBeenCalledTimes(1);
    expect(menuActions.newWorkstream).toHaveBeenCalledTimes(1);
    expect(menuActions.newAutomation).toHaveBeenCalledTimes(1);
    // The version is what the service checks the start against, so it has to
    // travel with the click rather than be re-read from a later refresh.
    expect(menuActions.startSuggestion).toHaveBeenCalledWith(suggestion);
    expect(menuActions.openWorkstream).toHaveBeenCalledWith('workstream-0');
    expect(menuActions.openAvalon).toHaveBeenCalledTimes(1);
    expect(menuActions.quit).toHaveBeenCalledTimes(1);
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

  it('cuts hard when trimming to a word would leave a stub', () => {
    // One long word, or a boundary too near the start: the space saved is worth
    // less than the label it would throw away.
    const single = menuBarLabel('x'.repeat(200));
    expect(single).toHaveLength(60);
    expect(single.endsWith('…')).toBe(true);

    expect(menuBarLabel(`Acme ${'y'.repeat(120)}`)).toBe(`Acme ${'y'.repeat(54)}…`);
  });
});
