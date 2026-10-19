import type { MenuItemConstructorOptions } from 'electron';
import { macosMajorVersion } from './macos-version';

export interface MenuBarWorkstream {
  readonly id: string;
  readonly title: string;
  /** The Breakout the row opens, for a Channel listed to this reader only through one; null opens Main. */
  readonly substreamId: string | null;
}

/** One unread Activity row: what happened, in a thread's Main or a Breakout in it. */
export interface MenuBarAttentionRow {
  readonly key: string;
  readonly workstreamId: string;
  /** Null for Main. */
  readonly substreamId: string | null;
  /** The thread's title, or the Breakout's. */
  readonly title: string;
  /** What happened, and the thread for a Breakout: "Rally finished", "Ana mentioned you in Pricing". */
  readonly detail: string;
  /** A thread's merge opens the Channel it landed in, not the thread. */
  readonly channelId?: string;
}

/** A request to join a Channel or Breakout, waiting on this person. */
export interface MenuBarAccessRequestRow {
  readonly id: string;
  readonly requesterName: string;
  readonly title: string;
}

export interface MenuBarContent {
  /** Access requests waiting on this person, newest first; listed above the conversations and counted with them. */
  readonly accessRequests: readonly MenuBarAccessRequestRow[];
  /** Every unread Activity row, newest first. The menu draws the first few; the count is all of them. */
  readonly attention: readonly MenuBarAttentionRow[];
  /** False until Activity has been read once, so an empty list is not yet "nothing". */
  readonly attentionComplete: boolean;
  /** Channels in the sidebar's Recent order under All. */
  readonly recents: readonly MenuBarWorkstream[];
  /** False until the first walk of every Space has finished, so an empty list is not yet "none". */
  readonly recentsComplete: boolean;
}

export const emptyMenuBarContent: MenuBarContent = {
  accessRequests: [], attention: [], attentionComplete: false, recents: [], recentsComplete: false,
};

export type MenuBarAction =
  | 'attention_conversation'
  | 'access_request'
  | 'recent_workstream'
  | 'open_rally'
  | 'quit_rally';

export interface MenuBarActions {
  /** Observational only: a reporting failure must not block the selected row. */
  readonly selected: (action: MenuBarAction) => void;
  /** `substreamId` names a Breakout; null opens Main. */
  readonly openConversation: (workstreamId: string, substreamId: string | null) => void;
  /** Opens a Channel. */
  readonly openChannel: (channelId: string) => void;
  /** Opens the main window on this request's approve-or-decline dialog. */
  readonly openAccessRequest: (requestId: string) => void;
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
  readonly actions: MenuBarActions;
}

/**
 * Whether `type: 'header'` is available, which macOS added in 14. Below that
 * Electron has no section-header item at all, so the label is drawn as a
 * disabled row — which is close to what a header looks like, and much closer
 * than the alternative of leaving the groups unlabelled.
 */
export function supportsSectionHeaders(systemVersion: string): boolean {
  return macosMajorVersion(systemVersion) >= 14;
}

function sectionHeader(label: string, supported: boolean): MenuItemConstructorOptions {
  return supported ? { label, type: 'header' } : { label, enabled: false };
}

/** How many rows each section draws, per the product contract. */
export const MENU_BAR_SECTION_LIMIT = 5;

/**
 * The status item's title: the number of rows Needs attention holds, capped
 * as the sidebar caps its badge. Empty when nothing is waiting, which leaves
 * the icon alone.
 */
export function menuBarTitle(count: number): string {
  if (count <= 0) return '';
  return count > 99 ? '99+' : String(count);
}

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

const ATTENTION_HEADER = 'Needs attention';
const RECENT_HEADER = 'Most recent';

/**
 * Builds the status item's drop-down as a plain Electron template, so the whole
 * mapping from content to menu is testable without a display server.
 *
 * Two sections, each the top of a list the sidebar also draws: **Needs
 * attention**, the Activity tab's unread rows in its order, and **Most
 * recent**, the Channels in the sidebar's Recent order under All. The menu has
 * no selected Space, so neither section filters by one or shows a pin.
 *
 * Nothing here starts anything. Every row reopens something that already
 * exists, which is the one thing this surface can do that no window can —
 * Rally can be launched hidden at login, and then the menu is the whole
 * application. The trailing group is what makes the item usable at all: it is
 * the only way to open a window or quit.
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

  // Only between sections. A menu that opens on a rule looks like it failed to
  // draw its first item.
  const pushSeparator = (): void => {
    if (template.length > 0) template.push({ type: 'separator' });
  };

  /**
   * Draws one titled section, and owns the rule above it. A section with no
   * rows says why in a disabled line rather than leaving a bare header, which
   * reads as a menu that failed to draw rather than as an answer.
   */
  const pushSection = (title: string, rows: MenuItemConstructorOptions[], trailing: string | null): void => {
    pushSeparator();
    template.push(sectionHeader(title, options.sectionHeaders), ...rows);
    if (trailing !== null) template.push({ label: trailing, enabled: false });
  };

  // Signed out there is nothing to list in either section; say so once.
  if (!options.signedIn) {
    pushSection(ATTENTION_HEADER, [], 'Sign in to Rally');
  } else {
    // Requests first: each is somebody waiting on this person, and the menu
    // cannot approve in place, so a row opens the decision in the main window.
    const requests = content.accessRequests.slice(0, MENU_BAR_SECTION_LIMIT).map((row): MenuItemConstructorOptions => ({
      label: menuBarLabel(`${row.requesterName} asked to join ${row.title}`),
      sublabel: 'Access request',
      click: tracked('access_request', () => actions.openAccessRequest(row.id)),
    }));
    const conversations = content.attention.slice(0, Math.max(0, MENU_BAR_SECTION_LIMIT - requests.length)).map((row): MenuItemConstructorOptions => ({
      label: menuBarLabel(row.title),
      sublabel: menuBarLabel(row.detail),
      click: tracked('attention_conversation', () => (row.channelId
        ? actions.openChannel(row.channelId)
        : actions.openConversation(row.workstreamId, row.substreamId))),
    }));
    // "Nothing" only once Activity has been read, and "still loading" before.
    const attention = [...requests, ...conversations];
    const attentionTrailing = !content.attentionComplete
      ? 'Still loading activity'
      : attention.length === 0 ? 'Nothing needs your attention' : null;
    pushSection(ATTENTION_HEADER, attention, attentionTrailing);

    const recents = content.recents.slice(0, MENU_BAR_SECTION_LIMIT).map((workstream): MenuItemConstructorOptions => ({
      label: menuBarLabel(workstream.title),
      click: tracked('recent_workstream', () => actions.openConversation(workstream.id, workstream.substreamId)),
    }));
    // An empty list is "none" only once every Space has been walked.
    const recentsTrailing = recents.length > 0 ? null
      : content.recentsComplete ? 'No recent threads' : 'Still loading threads';
    pushSection(RECENT_HEADER, recents, recentsTrailing);
  }

  pushSeparator();
  template.push(
    { label: `Open ${options.appName}`, click: tracked('open_rally', actions.openRally) },
    { label: `Quit ${options.appName}`, click: tracked('quit_rally', actions.quit) },
  );

  return template;
}
