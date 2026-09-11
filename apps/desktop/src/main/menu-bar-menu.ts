import type { MenuItemConstructorOptions } from 'electron';
import { groupActivityItems, type RecencyGroup } from '../common/recency-groups';

export interface MenuBarWorkstream {
  readonly id: string;
  readonly title: string;
  /** The recency the sidebar sorts and groups this row by — a visit where the
   * server reports one, otherwise the last message. See `workstreamRecencyAt`. */
  readonly lastActivityAt: string;
}

export interface MenuBarContent {
  readonly recents: readonly MenuBarWorkstream[];
  /** In the reader's own hand-arranged order. See `workstream-pinning.md`. */
  readonly pinned: readonly MenuBarWorkstream[];
}

export const emptyMenuBarContent: MenuBarContent = { recents: [], pinned: [] };

export type MenuBarAction =
  | 'recent_workstream'
  | 'pinned_workstream'
  | 'open_rally'
  | 'quit_rally';

export interface MenuBarActions {
  /** Observational only: a reporting failure must not block the selected row. */
  readonly selected: (action: MenuBarAction) => void;
  readonly openWorkstream: (workstreamId: string) => void;
  readonly openRally: () => void;
  readonly quit: () => void;
}

export interface MenuBarMenuOptions {
  readonly appName: string;
  readonly content: MenuBarContent;
  readonly signedIn: boolean;
  /** Whether this macOS draws real section headers. See
   * {@link supportsSectionHeaders}. */
  readonly sectionHeaders: boolean;
  /** Injected so the recency headings can be driven in tests. */
  readonly now?: Date;
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
 * How many recent work streams the menu shows, per the product contract. Read
 * as a page size too: `GET /workstreams` returns this many *unpinned* rows plus
 * the whole pinned list, which is exactly what the two sections need.
 */
export const MENU_BAR_RECENT_LIMIT = 10;
/**
 * How many pinned work streams the menu shows — the top of the reader's own
 * arrangement. This is a **display** limit for a menu that has to stay a menu,
 * not a cap on pinning: `workstream-pinning.md` records why nothing counts pins
 * against a limit, and nothing here starts.
 */
export const MENU_BAR_PINNED_LIMIT = 5;
/**
 * A macOS menu is as wide as its widest row, so one long label stretches every
 * other one. Work-stream titles are model-written and allowed 180 characters by
 * their contract — a work stream Rally named itself can run most of that — so
 * the limit is set by what stays readable rather than by what arrives.
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
 * Flattens a title to something a single menu row can hold.
 *
 * Titles arrive model-written, so they carry newlines and runs of whitespace
 * that a menu renders as a stretched, ragged row, and one can be long enough to
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
 * The heading the recent list falls back to when it has nothing under it.
 *
 * With rows, the recent list carries the sidebar's own recency headings and no
 * heading of its own — the two surfaces list the same work streams and should
 * not label them differently. With no rows there is no recency to name, and a
 * bare disabled sentence at the bottom of the menu reads as a stray broken item
 * rather than as an answer, so the section names itself instead.
 */
const RECENT_EMPTY_HEADER = 'Recent';

/**
 * Builds the status item's drop-down as a plain Electron template, so the whole
 * mapping from content to menu is testable without a display server.
 *
 * The order is the product contract: **Pinned** with the top of the reader's own
 * arrangement, then a rule and the recent work streams under the same recency
 * headings the sidebar uses. Pinned sits above Recent because a pin is a
 * standing choice and belongs where it can be found without reading past
 * whatever moved today — the recent list is ten rows now, and a section
 * underneath a list that long is a section nobody scans to. Both sections render
 * whether or not they have anything in them; an empty one says how it fills.
 *
 * Nothing above them starts anything. Every row here reopens something that
 * already exists, which is the one thing this surface can do that no window can
 * — Rally can be launched hidden at login, and then the menu is the whole
 * application. The trailing group is not part of the contract but is what makes
 * the item usable at all: it is the only way to open a window or quit.
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
  const template: MenuItemConstructorOptions[] = [];

  const openWorkstreamRow = (
    workstream: MenuBarWorkstream,
    action: 'recent_workstream' | 'pinned_workstream',
  ): MenuItemConstructorOptions => ({
    label: menuBarLabel(workstream.title),
    click: tracked(action, () => actions.openWorkstream(workstream.id)),
  });

  // Only between rows. The first section is always the top of the menu now, and
  // a menu that opens on a rule looks like it failed to draw its first item.
  const pushSeparator = (): void => {
    if (template.length > 0) template.push({ type: 'separator' });
  };

  const pushGroup = (
    title: RecencyGroup | string,
    rows: MenuItemConstructorOptions[],
  ): void => {
    template.push(sectionHeader(title, options.sectionHeaders));
    template.push(...rows);
  };

  // Pinned is dropped whole when nobody is signed in: it has nothing to say to
  // a stranger, and the Recent row below already carries the one message that
  // state needs. Signed in it renders even when empty — an empty section says
  // how it fills instead of disappearing, because the people it is empty for are
  // exactly the ones who have not found pinning yet.
  if (options.signedIn) {
    pushSeparator();
    pushGroup(
      'Pinned',
      content.pinned.length > 0
        ? content.pinned.slice(0, MENU_BAR_PINNED_LIMIT)
            .map((workstream) => openWorkstreamRow(workstream, 'pinned_workstream'))
        : [{ label: 'Pin a work stream to see it here', enabled: false }],
    );
  }

  // The same grouping the sidebar draws, from the same function, so a heading
  // never means one thing in the window and another in the menu. Recency is
  // taken at build time rather than at open, which is also when the menu is
  // rebuilt — a heading can therefore be an hour stale on a menu nobody has
  // touched, and the refresh the pointer triggers is what corrects it.
  const recents = content.recents.slice(0, MENU_BAR_RECENT_LIMIT);
  if (recents.length > 0) {
    for (const group of groupActivityItems(recents, options.now ?? new Date())) {
      pushSeparator();
      pushGroup(
        group.label,
        group.streams.map((workstream) => openWorkstreamRow(workstream, 'recent_workstream')),
      );
    }
  } else {
    pushSeparator();
    pushGroup(RECENT_EMPTY_HEADER, [{
      // A menu that silently loses its lower half reads as broken. Say which of
      // the two reasons it is: nothing to show, or nobody to show it to.
      label: options.signedIn ? 'No recent work streams' : 'Sign in to Rally',
      enabled: false,
    }]);
  }

  pushSeparator();
  template.push(
    { label: `Open ${options.appName}`, click: tracked('open_rally', actions.openRally) },
    { label: `Quit ${options.appName}`, click: tracked('quit_rally', actions.quit) },
  );

  return template;
}
