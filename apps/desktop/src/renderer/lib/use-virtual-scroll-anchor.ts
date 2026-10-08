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
 * because the list's own offset is read again after the commit.
 *
 * Call after the virtualizer, in the component that renders the list's parent,
 * so the render half runs before the list reads its window.
 */
export function useVirtualScrollAnchor(
  virtualizer: Virtualizer<HTMLElement, Element>,
  scrollRef: RefObject<HTMLElement | null>,
  scrollTo: (top: number) => void,
): void {
  const committed = useRef<{ count: number; firstKey: Key | null } | null>(null);
  const pending = useRef<ScrollAnchor | null>(null);
  const { count, getItemKey } = virtualizer.options;
  const firstKey = count > 0 ? getItemKey(0) : null;
  const previous = committed.current;

  // Only a commit that changes the list's edges can have inserted above the
  // viewport; a streaming token changes neither, and pays nothing here.
  pending.current = null;
  const scroll = scrollRef.current;
  if (scroll && previous && previous.count > 0 && count > 0
    && (previous.count !== count || previous.firstKey !== firstKey)) {
    const anchor = readAnchor(virtualizer, scroll);
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
    committed.current = { count, firstKey };
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

/** The first mounted row whose bottom is below the viewport's top edge. */
function readAnchor(
  virtualizer: Virtualizer<HTMLElement, Element>,
  scroll: HTMLElement,
): ScrollAnchor | null {
  const viewportTop = scroll.getBoundingClientRect().top;
  let first: { key: Key; element: Element; top: number; bottom: number } | null = null;
  for (const [key, element] of virtualizer.elementsCache) {
    if (!element.isConnected) continue;
    const rect = element.getBoundingClientRect();
    if (rect.bottom <= viewportTop) continue;
    if (!first || rect.top < first.top) first = { key, element, top: rect.top, bottom: rect.bottom };
  }
  if (!first) return null;
  const previousIndex = virtualizer.indexFromElement(first.element);
  const { count, getItemKey } = virtualizer.options;
  let index = -1;
  for (let candidate = 0; candidate < count; candidate += 1) {
    if (getItemKey(candidate) === first.key) {
      index = candidate;
      break;
    }
  }
  // Nothing inserted above it, or it is gone: there is nothing to hold.
  if (index < 0 || index === previousIndex) return null;
  return { key: first.key, index, element: first.element, bottomFromViewportTop: first.bottom - viewportTop };
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
