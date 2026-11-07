import { canvasNeedsAttention, sidekickNeedsAttention } from '../common/sidebar-attention';
import type { SidebarListsSnapshot } from './sidebar-lists-watch';
import type { MenuBarContent, MenuBarRow } from './menu-bar-menu';

/** Shown for a Canvas or Sidekick with no title yet; a menu row cannot draw a skeleton. */
const UNTITLED_LABEL = 'Untitled';

function label(title: string): string {
  return title.trim().length > 0 ? title : UNTITLED_LABEL;
}

/**
 * The menu's content, from the two lists the main process holds:
 *
 * - **Needs attention** is what the rail counts, by the rail's own predicates
 *   (`common/sidebar-attention.ts`), in the order the sidebar draws it: each
 *   Sidekick that needs input, then each Sidekick and each Canvas holding
 *   something unread. Its length is the count beside the icon, so the menu,
 *   the rail and the dock never disagree.
 * - **Recent Canvases** is every Canvas re-sorted by `updatedAt`, newest
 *   first, with the id breaking a tie so equal times keep one order.
 */
export function menuBarContent(lists: SidebarListsSnapshot): MenuBarContent {
  const sidekicks = lists.sidekicks ?? [];
  const canvases = lists.canvases ?? [];
  const sidekickRow = (sidekick: (typeof sidekicks)[number], detail: string): MenuBarRow => ({
    key: `sidekick:${sidekick.id}`, kind: 'sidekick', id: sidekick.id, title: label(sidekick.name), detail,
  });
  const canvasRow = (canvas: (typeof canvases)[number], detail: string | null): MenuBarRow => ({
    key: `canvas:${canvas.id}`, kind: 'canvas', id: canvas.id, title: label(canvas.title), detail,
  });
  const waiting = sidekicks.filter((sidekick) => sidekickNeedsAttention(sidekick));
  return {
    attention: [
      ...waiting.filter((sidekick) => sidekick.needsInput).map((sidekick) => sidekickRow(sidekick, 'Needs input')),
      ...waiting.filter((sidekick) => !sidekick.needsInput).map((sidekick) => sidekickRow(sidekick, 'Unread')),
      ...canvases.filter((canvas) => canvasNeedsAttention(canvas)).map((canvas) => canvasRow(canvas, 'Unread')),
    ],
    attentionComplete: lists.sidekicks !== null && lists.canvases !== null,
    recents: [...canvases]
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt) || left.id.localeCompare(right.id))
      .map((canvas) => canvasRow(canvas, null)),
    recentsComplete: lists.canvases !== null,
  };
}
