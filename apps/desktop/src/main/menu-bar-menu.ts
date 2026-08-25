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

export type MenuBarAction =
  | 'new_meeting_note'
  | 'new_workstream'
  | 'new_automation'
  | 'suggested_work'
  | 'recent_workstream'
  | 'pinned_workstream'
  | 'open_avalon'
  | 'quit_avalon';

export interface MenuBarActions {
  /** Observational only: a reporting failure must not block the selected row. */
  readonly selected: (action: MenuBarAction) => void;
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
  readonly meetingRecordingAvailable?: boolean;
  readonly suggestedWorkAvailable?: boolean;
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

/**
 * Names the thing that has to happen for Avalon to have anything to suggest,
 * because with no connector there is nothing to suggest *from* and the section
 * would otherwise look broken rather than unstarted.
 *
 * The longest fixed string in the menu, and past the limit
 * {@link menuBarLabel} imposes on content. That limit exists to stop one
 * model-written title stretching the menu; this is our own copy, it has to read
 * in full, and it is the width of the menu only for an account with no
 * connectors — which is exactly the account it is written for.
 */
const SUGGESTIONS_EMPTY_LABEL = 'Connect platforms to get daily suggestions on work streams to create';

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
 * Cuts by what a reader sees rather than by UTF-16 code unit. A title can carry
 * an emoji, and slicing one of those in half leaves a lone surrogate that
 * renders as `�` immediately before the ellipsis. Locale-pinned so the same
 * label truncates the same way on every machine.
 */
const GRAPHEMES = new Intl.Segmenter('en', { granularity: 'grapheme' });

/**
 * Flattens a title or prompt to something a single menu row can hold.
 *
 * Both arrive model-written, so they carry newlines and runs of whitespace that
 * a menu renders as a stretched, ragged row, and either can be long enough to
 * set the width of the whole menu.
 */
export function menuBarLabel(rawLabel: string): string {
  const collapsed = rawLabel.replace(/\s+/gu, ' ').trim();
  // A string of no more code units than the limit cannot hold more graphemes
  // than it either, so the common case never pays for segmentation.
  if (collapsed.length <= MENU_BAR_LABEL_MAX_LENGTH) return collapsed;
  const graphemes = [...GRAPHEMES.segment(collapsed)].map((entry) => entry.segment);
  if (graphemes.length <= MENU_BAR_LABEL_MAX_LENGTH) return collapsed;
  // One short, so the ellipsis fits inside the limit rather than pushing the
  // row a character past it.
  const clipped = graphemes.slice(0, MENU_BAR_LABEL_MAX_LENGTH - 1);
  // Counted in graphemes for the same reason the cut is: a boundary measured
  // in code units moves as soon as anything above the basic plane appears.
  const lastBoundary = clipped.lastIndexOf(' ');
  const truncated = lastBoundary >= MENU_BAR_LABEL_WORD_BOUNDARY_FLOOR
    ? clipped.slice(0, lastBoundary)
    : clipped;
  return `${truncated.join('').replace(TRAILING_PUNCTUATION, '')}…`;
}

/**
 * Builds the status item's drop-down as a plain Electron template, so the whole
 * mapping from content to menu is testable without a display server.
 *
 * The order is the product contract: the three things a person can always
 * start, then a rule, then **Suggestions** with whatever Avalon is currently
 * suggesting, then a rule and **Recent** with the five most recent work streams,
 * then a rule and **Pinned** with the top five of the reader's own arrangement.
 * Each of the three renders whether or not it has anything in it; an empty one
 * says how it fills. The trailing group is not part of that contract but is what
 * makes the item usable at all — Avalon can be launched hidden at login, and
 * then this menu is the only way to open a window or quit.
 */
export function menuBarMenuTemplate(options: MenuBarMenuOptions): MenuItemConstructorOptions[] {
  const { actions, content } = options;
  const tracked = (action: MenuBarAction, invoke: () => void): (() => void) => () => {
    try {
      actions.selected(action);
    } catch {
      // Reporting is observational; the selected product action still runs.
    }
    invoke();
  };
  const template: MenuItemConstructorOptions[] = [
    ...(options.meetingRecordingAvailable !== false
      ? [{ label: 'New Meeting/Note', click: tracked('new_meeting_note', actions.newMeetingNote) }]
      : []),
    { label: 'New Work Stream', click: tracked('new_workstream', actions.newWorkstream) },
    { label: 'New Automation', click: tracked('new_automation', actions.newAutomation) },
  ];

  const openWorkstreamRow = (
    workstream: MenuBarWorkstream,
    action: 'recent_workstream' | 'pinned_workstream',
  ): MenuItemConstructorOptions => ({
    label: menuBarLabel(workstream.title),
    click: tracked(action, () => actions.openWorkstream(workstream.id)),
  });

  const pushGroup = (title: string, emptyLabel: string, rows: MenuItemConstructorOptions[]): void => {
    template.push(sectionHeader(title, options.sectionHeaders));
    if (rows.length > 0) template.push(...rows);
    else template.push({ label: emptyLabel, enabled: false });
  };

  template.push({ type: 'separator' });

  // Suggestions and Pinned are dropped whole when nobody is signed in: neither
  // has anything to say to a stranger, and the Recent row below already carries
  // the one message that state needs. Signed in, every group renders — an empty
  // one says how it fills instead of disappearing, because the people it is
  // empty for are exactly the ones who have not found the feature yet.
  if (options.signedIn && options.suggestedWorkAvailable !== false) {
    pushGroup(
      'Suggestions',
      SUGGESTIONS_EMPTY_LABEL,
      content.suggestions.map((suggestion) => ({
        label: menuBarLabel(suggestion.label),
        click: tracked('suggested_work', () => actions.startSuggestion(suggestion)),
      })),
    );
    template.push({ type: 'separator' });
  }

  pushGroup(
    'Recent',
    // A menu that silently loses its lower half reads as broken. Say which of
    // the two reasons it is: nothing to show, or nobody to show it to.
    options.signedIn ? 'No recent work streams' : 'Sign in to Avalon',
    content.recents.slice(0, MENU_BAR_RECENT_LIMIT)
      .map((workstream) => openWorkstreamRow(workstream, 'recent_workstream')),
  );

  // Below Recent, because a pin is a standing choice and the recent list is
  // what moved today.
  if (options.signedIn) {
    template.push({ type: 'separator' });
    pushGroup(
      'Pinned',
      'Pin a work stream to see it here',
      content.pinned.slice(0, MENU_BAR_PINNED_LIMIT)
        .map((workstream) => openWorkstreamRow(workstream, 'pinned_workstream')),
    );
  }

  template.push(
    { type: 'separator' },
    { label: `Open ${options.appName}`, click: tracked('open_avalon', actions.openAvalon) },
    { label: `Quit ${options.appName}`, click: tracked('quit_avalon', actions.quit) },
  );

  return template;
}
