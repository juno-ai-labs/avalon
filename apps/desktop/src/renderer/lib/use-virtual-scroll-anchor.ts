import type { Virtualizer } from '@tanstack/react-virtual';
import { useLayoutEffect, useRef, type RefObject } from 'react';

type Key = string | number | bigint;

interface ScrollAnchor {
  key: Key;
  /** The anchor row's index in the list being rendered now. */
  index: number;
  /** The anchor row as it was mounted before this commit, if still mounted. */
  element: Element;
  /** How far below the viewport's top edge the anchor row's bottom sat. */
  bottomFromViewportTop: number;
}

/**
 * Keeps the row under the reader's eye still when rows are inserted above it.
 *
 * A windowed list positions its rows from offsets, so the browser's own scroll
 * anchoring cannot see an insertion above the viewport: the rows shift and the
 * reader is thrown to whatever now sits at their old offset. This picks the
 * first row on screen before the commit that changes the list, and after it
 * puts that row's bottom edge back where it was.
 *
 * Both halves happen inside the one commit, so the insertion is never painted
 * at the old position:
 *
 * - **Render.** The pre-commit DOM is still on screen. The anchor is read from
 *   it, and the virtualizer's own `scrollOffset` is moved to the predicted
 *   position before the feed asks it which rows to render. Without that the
 *   commit would render the rows at the *old* offset, which after a prepend
 *   are the new ones, and the anchor would be unmounted for a frame.
 * - **Layout effect.** Rows rendered in this commit have been measured by now,
 *   so the exact position is recomputed and written through `scrollTo`.
 *
 * The bottom edge, not the top, because the row the reader is looking at is
 * usually the old first row, and gaining a predecessor gives it a top gap
 * (`feedRowGap`). Anchored on its top, its content would move down by that gap.
 *
 * Content between the scroller's top and the list itself — a status row, an
 * origin card that appears once the first message is loaded — is accounted for,
 * because the list's own offset is read again after the commit. A commit that
 * changes only that content, such as a final page with no visible rows, leaves
 * the list alone; the caller says so by changing `layoutKey`.
 *
 * A row whose key does not survive the commit is skipped for the next one down.
 * Grouping derives some rows' keys from their first member, so a group spanning
 * the page seam is re-keyed when its earlier members load.
 *
 * Call after the virtualizer, in the component that renders the list's parent,
 * so the render half runs before the list reads its window.
 */
export function useVirtualScrollAnchor(
  virtualizer: Virtualizer<HTMLElement, Element>,
  scrollRef: RefObject<HTMLElement | null>,
  scrollTo: (top: number) => void,
  layoutKey: unknown = null,
): void {
  const committed = useRef<{ count: number; firstKey: Key | null; layoutKey: unknown } | null>(null);
  const pending = useRef<ScrollAnchor | null>(null);
  const { count, getItemKey } = virtualizer.options;
  const firstKey = count > 0 ? getItemKey(0) : null;
  const previous = committed.current;

  // Only a commit that changes the list's edges, or what sits above the list,
  // can move the reader's row; a streaming token changes neither, and pays
  // nothing here.
  pending.current = null;
  const scroll = scrollRef.current;
  const layoutChanged = previous !== null && !Object.is(previous.layoutKey, layoutKey);
  if (scroll && previous && previous.count > 0 && count > 0
    && (previous.count !== count || previous.firstKey !== firstKey || layoutChanged)) {
    const anchor = readAnchor(virtualizer, scroll, layoutChanged);
    if (anchor) {
      pending.current = anchor;
      const feedTop = contentOffset(anchor.element.parentElement, scroll);
      const item = measuredItem(virtualizer, anchor.index);
      if (feedTop !== null && item) {
        virtualizer.scrollOffset = Math.max(0, feedTop + item.end - anchor.bottomFromViewportTop);
      }
    }
  }

  useLayoutEffect(() => {
    committed.current = { count, firstKey, layoutKey };
    const anchor = pending.current;
    pending.current = null;
    const element = scrollRef.current;
    if (!anchor || !element) return;
    const item = measuredItem(virtualizer, anchor.index);
    if (!item || item.key !== anchor.key) return;
    const row = anchor.element.isConnected ? anchor.element : virtualizer.elementsCache.get(anchor.key);
    const feedTop = contentOffset(row?.parentElement ?? null, element);
    if (feedTop === null) return;
    // The live height, not the cached one: a row that gained a top gap in this
    // commit is re-measured only on the next frame.
    const height = row?.isConnected ? row.getBoundingClientRect().height : item.size;
    scrollTo(feedTop + item.start + height - anchor.bottomFromViewportTop);
    // The virtualizer learns of the write from its scroll event, a frame from
    // now; measurements before then must judge "above the fold" from here.
    virtualizer.scrollOffset = element.scrollTop;
  });
}

/** The first mounted row below the viewport's top edge that survives this commit. */
function readAnchor(
  virtualizer: Virtualizer<HTMLElement, Element>,
  scroll: HTMLElement,
  layoutChanged: boolean,
): ScrollAnchor | null {
  const viewportTop = scroll.getBoundingClientRect().top;
  const candidates: Array<{ key: Key; element: Element; top: number; bottom: number }> = [];
  for (const [key, element] of virtualizer.elementsCache) {
    if (!element.isConnected) continue;
    const rect = element.getBoundingClientRect();
    if (rect.bottom > viewportTop) candidates.push({ key, element, top: rect.top, bottom: rect.bottom });
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.top - b.top);
  const { count, getItemKey } = virtualizer.options;
  const indexes = new Map<Key, number>();
  for (let index = 0; index < count; index += 1) indexes.set(getItemKey(index), index);
  for (const candidate of candidates) {
    const index = indexes.get(candidate.key);
    if (index === undefined) continue;
    // Nothing inserted above it and nothing above the list changed: there is
    // nothing to hold.
    if (index === virtualizer.indexFromElement(candidate.element) && !layoutChanged) return null;
    return {
      key: candidate.key,
      index,
      element: candidate.element,
      bottomFromViewportTop: candidate.bottom - viewportTop,
    };
  }
  return null;
}

/** Where `element` starts inside the scroller's content, whatever it is scrolled to. */
function contentOffset(element: Element | null, scroll: HTMLElement): number | null {
  if (!element?.isConnected) return null;
  return element.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop;
}

function measuredItem(virtualizer: Virtualizer<HTMLElement, Element>, index: number) {
  // Refreshes the measurement ledger with any size recorded since it was built.
  virtualizer.getTotalSize();
  return virtualizer.measurementsCache[index];
}
