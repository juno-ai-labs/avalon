import type { MenuItemConstructorOptions } from 'electron';

/** One suggested work stream, as `GET /work-opportunities` describes it. */
export interface MenuBarSuggestion {
  readonly id: string;
  readonly version: number;
  readonly label: string;
}

export interface MenuBarWorkstream {
  readonly id: string;
  readonly title: string;
}

export interface MenuBarContent {
  readonly suggestions: readonly MenuBarSuggestion[];
  readonly recents: readonly MenuBarWorkstream[];
}

export const emptyMenuBarContent: MenuBarContent = { suggestions: [], recents: [] };

export interface MenuBarActions {
  readonly newMeetingNote: () => void;
  readonly newAutomation: () => void;
  readonly startSuggestion: (suggestion: MenuBarSuggestion) => void;
  readonly openWorkstream: (workstreamId: string) => void;
  readonly openAvalon: () => void;
  readonly setLaunchAtLogin: (enabled: boolean) => void;
  readonly quit: () => void;
}

export interface MenuBarMenuOptions {
  readonly appName: string;
  readonly content: MenuBarContent;
  readonly launchAtLogin: boolean;
  readonly signedIn: boolean;
  readonly actions: MenuBarActions;
}

/** How many recent work streams the menu shows, per the product contract. */
export const MENU_BAR_RECENT_LIMIT = 5;
/** A menu item that runs past this is unreadable at the menu bar's width. */
const MENU_BAR_LABEL_MAX_LENGTH = 60;

/**
 * Flattens a title to something a single menu row can hold. Work-stream titles
 * and suggested prompts are model-written, so they arrive with newlines and
 * runs of whitespace that a menu renders as a stretched, ragged row.
 */
export function menuBarLabel(rawLabel: string): string {
  const collapsed = rawLabel.replace(/\s+/gu, ' ').trim();
  if (collapsed.length <= MENU_BAR_LABEL_MAX_LENGTH) return collapsed;
  return `${collapsed.slice(0, MENU_BAR_LABEL_MAX_LENGTH - 1).trimEnd()}…`;
}

/**
 * Builds the status item's drop-down as a plain Electron template, so the whole
 * mapping from content to menu is testable without a display server.
 *
 * The order is the product contract: the two things a person can always start,
 * then whatever Avalon is currently suggesting, then a rule and the five most
 * recent work streams. The trailing group is not part of that contract but is
 * what makes the item usable at all — Avalon can be launched hidden at login,
 * and then this menu is the only way to open a window or quit.
 */
export function menuBarMenuTemplate(options: MenuBarMenuOptions): MenuItemConstructorOptions[] {
  const { actions, content } = options;
  const template: MenuItemConstructorOptions[] = [
    { label: 'New Meeting/Note', click: actions.newMeetingNote },
    { label: 'New Automation', click: actions.newAutomation },
  ];

  for (const suggestion of content.suggestions) {
    template.push({
      label: menuBarLabel(suggestion.label),
      click: () => actions.startSuggestion(suggestion),
    });
  }

  template.push({ type: 'separator' });

  const recents = content.recents.slice(0, MENU_BAR_RECENT_LIMIT);
  if (recents.length > 0) {
    for (const workstream of recents) {
      template.push({
        label: menuBarLabel(workstream.title),
        click: () => actions.openWorkstream(workstream.id),
      });
    }
  } else {
    // A menu that silently loses its lower half reads as broken. Say which of
    // the two reasons it is: nothing to show, or nobody to show it to.
    template.push({
      label: options.signedIn ? 'No recent work streams' : 'Sign in to Avalon',
      enabled: false,
    });
  }

  template.push(
    { type: 'separator' },
    { label: `Open ${options.appName}`, click: actions.openAvalon },
    {
      label: 'Launch at login',
      type: 'checkbox',
      checked: options.launchAtLogin,
      click: () => actions.setLaunchAtLogin(!options.launchAtLogin),
    },
    { type: 'separator' },
    { label: `Quit ${options.appName}`, click: actions.quit },
  );

  return template;
}
