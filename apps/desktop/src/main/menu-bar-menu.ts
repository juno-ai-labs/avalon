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
  /** In the reader's own hand-arranged order. See `workstream-pinning.md`. */
  readonly pinned: readonly MenuBarWorkstream[];
}

export const emptyMenuBarContent: MenuBarContent = { suggestions: [], recents: [], pinned: [] };

export interface MenuBarActions {
  readonly newMeetingNote: () => void;
  readonly newWorkstream: () => void;
  readonly newAutomation: () => void;
  readonly startSuggestion: (suggestion: MenuBarSuggestion) => void;
  readonly openWorkstream: (workstreamId: string) => void;
  readonly openAvalon: () => void;
  readonly quit: () => void;
}

export interface MenuBarMenuOptions {
  readonly appName: string;
  readonly content: MenuBarContent;
  readonly signedIn: boolean;
  /** Whether this macOS draws real section headers. See
   * {@link supportsSectionHeaders}. */
  readonly sectionHeaders: boolean;
  readonly actions: MenuBarActions;
}

/**
 * Whether `type: 'header'` is available, which macOS added in 14. Below that
 * Electron has no section-header item at all, so the label is drawn as a
 * disabled row — which is close to what a header looks like, and much closer
 * than the alternative of leaving the groups unlabelled.
 *
 * Takes the version string rather than reading it, both so the fallback is
 * testable and because `process.getSystemVersion` exists only in Electron's
 * main process.
 */
export function supportsSectionHeaders(systemVersion: string): boolean {
  const major = Number.parseInt(systemVersion.split('.')[0] ?? '', 10);
  return Number.isFinite(major) && major >= 14;
}

function sectionHeader(label: string, supported: boolean): MenuItemConstructorOptions {
  return supported ? { label, type: 'header' } : { label, enabled: false };
}

/** How many recent work streams the menu shows, per the product contract. */
export const MENU_BAR_RECENT_LIMIT = 5;
/**
 * How many pinned work streams the menu shows — the top of the reader's own
 * arrangement. This is a **display** limit for a menu that has to stay a menu,
 * not a cap on pinning: `workstream-pinning.md` records why nothing counts pins
 * against a limit, and nothing here starts.
 */
export const MENU_BAR_PINNED_LIMIT = 5;
/**
 * A macOS menu is as wide as its widest row, so one long label stretches every
 * other one. Both things this menu lists are model-written and allowed 180
 * characters by their contracts — a suggested prompt is a sentence, and a work
 * stream Avalon named itself can be nearly as long — so the limit is set by
 * what stays readable rather than by what arrives.
 */
const MENU_BAR_LABEL_MAX_LENGTH = 60;
/**
 * How far back a cut may reach for a word boundary. A label trimmed to the last
 * whole word reads as an abbreviation; one cut mid-word reads as a bug, and the
 * fragment left behind ("Prepare the Acme cli…") is worse than the missing
 * word. Below this the saving is not worth the blank space, so the cut is hard —
 * which is also what happens to a label with no spaces in it at all.
 */
const MENU_BAR_LABEL_WORD_BOUNDARY_FLOOR = 40;
/** Punctuation left dangling before an ellipsis reads as a typo. */
const TRAILING_PUNCTUATION = /[\s,;:.!?—–-]+$/u;

/**
 * Flattens a title or prompt to something a single menu row can hold.
 *
 * Both arrive model-written, so they carry newlines and runs of whitespace that
 * a menu renders as a stretched, ragged row, and either can be long enough to
 * set the width of the whole menu.
 */
export function menuBarLabel(rawLabel: string): string {
  const collapsed = rawLabel.replace(/\s+/gu, ' ').trim();
  if (collapsed.length <= MENU_BAR_LABEL_MAX_LENGTH) return collapsed;
  // One character short, so the ellipsis fits inside the limit rather than
  // pushing the row a character past it.
  const clipped = collapsed.slice(0, MENU_BAR_LABEL_MAX_LENGTH - 1);
  const lastBoundary = clipped.lastIndexOf(' ');
  const truncated = lastBoundary >= MENU_BAR_LABEL_WORD_BOUNDARY_FLOOR
    ? clipped.slice(0, lastBoundary)
    : clipped;
  return `${truncated.replace(TRAILING_PUNCTUATION, '')}…`;
}

/**
 * Builds the status item's drop-down as a plain Electron template, so the whole
 * mapping from content to menu is testable without a display server.
 *
 * The order is the product contract: the three things a person can always
 * start, then a rule, then **Suggestions** with whatever Avalon is currently
 * suggesting, then a rule and **Recent** with the five most recent work streams,
 * then a rule and **Pinned** with the top five of the reader's own arrangement.
 * The trailing group is not part of that contract but is what makes the item
 * usable at all — Avalon can be launched hidden at login, and then this menu is
 * the only way to open a window or quit.
 */
export function menuBarMenuTemplate(options: MenuBarMenuOptions): MenuItemConstructorOptions[] {
  const { actions, content } = options;
  const template: MenuItemConstructorOptions[] = [
    { label: 'New Meeting/Note', click: actions.newMeetingNote },
    { label: 'New Work Stream', click: actions.newWorkstream },
    { label: 'New Automation', click: actions.newAutomation },
  ];

  template.push({ type: 'separator' });

  // The suggestions sit in a group of their own, between what a person can
  // always start and what they have already started. Skipped entirely — header
  // and rule included — when Avalon is suggesting nothing, because the
  // alternative is two rules against each other with no group between them.
  if (content.suggestions.length > 0) {
    template.push(sectionHeader('Suggestions', options.sectionHeaders));
    for (const suggestion of content.suggestions) {
      template.push({
        label: menuBarLabel(suggestion.label),
        click: () => actions.startSuggestion(suggestion),
      });
    }
    template.push({ type: 'separator' });
  }

  // The Recent header stays even with nothing under it. The row below says why
  // the group is empty, and a header is what makes that row read as an answer
  // rather than as a stray disabled item.
  template.push(sectionHeader('Recent', options.sectionHeaders));
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

  // Below Recent, because a pin is a standing choice and the recent list is
  // what moved today. Omitted whole, header and rule included, when nothing is
  // pinned — most people never pin anything, and an empty section would cost
  // them two rows to say so.
  const pinned = content.pinned.slice(0, MENU_BAR_PINNED_LIMIT);
  if (pinned.length > 0) {
    template.push({ type: 'separator' }, sectionHeader('Pinned', options.sectionHeaders));
    for (const workstream of pinned) {
      template.push({
        label: menuBarLabel(workstream.title),
        click: () => actions.openWorkstream(workstream.id),
      });
    }
  }

  template.push(
    { type: 'separator' },
    { label: `Open ${options.appName}`, click: actions.openAvalon },
    { label: `Quit ${options.appName}`, click: actions.quit },
  );

  return template;
}
