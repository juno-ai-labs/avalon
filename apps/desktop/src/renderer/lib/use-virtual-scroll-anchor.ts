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
 * Keeps the row under the reader's eye still when rows are inserted above it,
 * in the same commit, by holding that row's bottom edge. The mechanism and its
 * reasons are in `docs/transcript-scrolling.md#holding-the-row-on-screen`.
 *
 * Call after the virtualizer, in the component that renders the list's parent,
 * so the render half runs before the list reads its window. Change `layoutKey`
 * when what sits above the list changes, since that can happen without the list
 * changing. While `enabled` returns false (the transcript is following its end)
 * nothing is held: the two are exclusive, and the follow wins.
 */
export function useVirtualScrollAnchor(
  virtualizer: Virtualizer<HTMLElement, Element>,
  scrollRef: RefObject<HTMLElement | null>,
  scrollTo: (top: number) => void,
  { enabled, layoutKey }: { enabled: () => boolean; layoutKey: string },
): void {
  const committed = useRef<{ count: number; firstKey: Key | null; layoutKey: string } | null>(null);
  const pending = useRef<ScrollAnchor | null>(null);
  const { count, getItemKey } = virtualizer.options;
  const firstKey = count > 0 ? getItemKey(0) : null;
  const previous = committed.current;

  // Only a commit that changes the list's edges, or what sits above the list,
  // can move the reader's row; a streaming token changes neither, and pays
  // nothing here.
  pending.current = null;
  const scroll = scrollRef.current;
  const layoutChanged = previous !== null && previous.layoutKey !== layoutKey;
  // Writing `scrollOffset` during render is safe under a double render, since
  // both passes read the same pre-commit DOM. A render React discards would
  // leave the prediction in place until the next scroll event; nothing in this
  // subtree suspends or transitions today.
  if (scroll && previous && previous.count > 0 && count > 0 && enabled()
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
    if (!anchor || !element || !enabled()) return;
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
