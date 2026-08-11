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
    newAutomation: vi.fn(),
    startSuggestion: vi.fn(),
    openWorkstream: vi.fn(),
    openAvalon: vi.fn(),
    setLaunchAtLogin: vi.fn(),
    quit: vi.fn(),
  };
}

function template(
  content: MenuBarContent,
  overrides: { launchAtLogin?: boolean; signedIn?: boolean; actions?: MenuBarActions } = {},
): MenuItemConstructorOptions[] {
  return menuBarMenuTemplate({
    appName: 'Avalon',
    content,
    launchAtLogin: overrides.launchAtLogin ?? true,
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
      'Launch at login',
      '—',
      'Quit Avalon',
    ]);
  });

  it('shows no more than five recent work streams', () => {
    const items = template({ suggestions: [], recents: workstreams });
    const recentLabels = labels(items).filter((label) => label?.startsWith('Work stream'));
    expect(recentLabels).toHaveLength(MENU_BAR_RECENT_LIMIT);
  });

  it('keeps the rule and both fixed actions when Avalon has nothing to suggest', () => {
    const items = template({ suggestions: [], recents: workstreams.slice(0, 1) });
    expect(labels(items)).toEqual([
      'New Meeting/Note',
      'New Automation',
      '—',
      'Work stream 0',
      '—',
      'Open Avalon',
      'Launch at login',
      '—',
      'Quit Avalon',
    ]);
  });

  it('says why the lower half is empty rather than dropping it', () => {
    const signedIn = template(emptyMenuBarContent, { signedIn: true });
    expect(signedIn.find((item) => item.label === 'No recent work streams')?.enabled).toBe(false);

    const signedOut = template(emptyMenuBarContent, { signedIn: false });
    expect(signedOut.find((item) => item.label === 'Sign in to Avalon')?.enabled).toBe(false);
  });

  it('reflects and toggles whether Avalon opens at login', () => {
    const enabled = template(emptyMenuBarContent, { launchAtLogin: true });
    const enabledItem = enabled.find((item) => item.label === 'Launch at login');
    expect(enabledItem?.type).toBe('checkbox');
    expect(enabledItem?.checked).toBe(true);

    const menuActions = actions();
    const disabled = template(emptyMenuBarContent, { launchAtLogin: false, actions: menuActions });
    const disabledItem = disabled.find((item) => item.label === 'Launch at login');
    expect(disabledItem?.checked).toBe(false);
    activate(disabledItem);
    expect(menuActions.setLaunchAtLogin).toHaveBeenCalledWith(true);
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
    expect(menuBarLabel('x'.repeat(200))).toHaveLength(60);
    expect(menuBarLabel('x'.repeat(200)).endsWith('…')).toBe(true);
  });
});
