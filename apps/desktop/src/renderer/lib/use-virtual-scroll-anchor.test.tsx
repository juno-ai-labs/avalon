import type { Virtualizer } from '@tanstack/react-virtual';
import { render } from '@testing-library/react';
import { useLayoutEffect, useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useVirtualScrollAnchor } from './use-virtual-scroll-anchor';

/**
 * jsdom lays nothing out, so the scroller, the feed and each row report
 * rectangles computed from `layout`. A render sees the layout before the
 * commit; `Commit`, a child whose layout effect runs before the hook's, swaps
 * in the layout after it, the way the browser's DOM is current by then.
 */
interface Layout {
  keys: string[];
  /** Measured row heights the virtualizer has cached. */
  sizes: Record<string, number>;
  /** Live row heights, where a row's DOM differs from the cache. */
  live: Record<string, number>;
  /** Where the feed starts inside the scroller's content. */
  feedOffset: number;
}

let layout: Layout;
let next: Layout;
let scrollTop: number;
let scroller: HTMLDivElement;
let feed: HTMLDivElement;
let rows: Map<string, HTMLDivElement>;
let virtualizer: Virtualizer<HTMLElement, Element>;
let scrollTo: ReturnType<typeof vi.fn>;

function rect(top: number, height: number): DOMRect {
  return { top, bottom: top + height, height, left: 0, right: 0, width: 0, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
}

function start(state: Layout, key: string): number {
  let offset = 0;
  for (const candidate of state.keys) {
    if (candidate === key) return offset;
    offset += state.sizes[candidate] ?? 100;
  }
  return Number.NaN;
}

function row(key: string): HTMLDivElement {
  let element = rows.get(key);
  if (!element) {
    element = document.createElement('div');
    element.getBoundingClientRect = () => {
      const height = layout.live[key] ?? layout.sizes[key] ?? 100;
      return rect(layout.feedOffset + start(layout, key) - scrollTop, height);
    };
    rows.set(key, element);
  }
  return element;
}

/** Mount the rows of `state` with their indexes, as the feed would. */
function mount(state: Layout): void {
  feed.replaceChildren();
  virtualizer.elementsCache.clear();
  state.keys.forEach((key, index) => {
    const element = row(key);
    element.dataset.index = String(index);
    feed.append(element);
    virtualizer.elementsCache.set(key, element);
  });
}

function fakeVirtualizer(): Virtualizer<HTMLElement, Element> {
  const fake = {
    options: { count: 0, getItemKey: (index: number) => layout.keys[index] ?? index },
    elementsCache: new Map<string, Element>(),
    measurementsCache: [] as Array<{ key: string; index: number; start: number; size: number; end: number; lane: number }>,
    scrollOffset: 0 as number | null,
    indexFromElement: (element: Element) => Number((element as HTMLElement).dataset.index),
    getTotalSize: () => {
      fake.measurementsCache = layout.keys.map((key, index) => {
        const size = layout.sizes[key] ?? 100;
        const offset = start(layout, key);
        return { key, index, start: offset, size, end: offset + size, lane: 0 };
      });
      return layout.keys.reduce((total, key) => total + (layout.sizes[key] ?? 100), 0);
    },
  };
  return fake as unknown as Virtualizer<HTMLElement, Element>;
}

function Commit(): null {
  useLayoutEffect(() => {
    layout = next;
    mount(layout);
  });
  return null;
}

function Feed({ layoutKey = 'a', following = false }: { layoutKey?: string; following?: boolean }): React.JSX.Element {
  const scrollRef = useRef<HTMLElement | null>(scroller);
  // The surface's virtualizer reads its count during render, from the list
  // about to be committed.
  virtualizer.options.count = next.keys.length;
  virtualizer.options.getItemKey = (index: number) => next.keys[index] ?? index;
  useVirtualScrollAnchor(virtualizer, scrollRef, scrollTo as (top: number) => void, {
    enabled: () => !following,
    layoutKey,
  });
  return <Commit />;
}

function commit(state: Partial<Layout>, props: { layoutKey?: string; following?: boolean } = {}): void {
  next = { ...layout, ...state };
  view.rerender(<Feed {...props} />);
}

let view: ReturnType<typeof render>;

beforeEach(() => {
  scroller = document.createElement('div');
  scroller.getBoundingClientRect = () => rect(0, 600);
  Object.defineProperty(scroller, 'scrollTop', {
    configurable: true,
    get: () => scrollTop,
    set: (value: number) => { scrollTop = value; },
  });
  feed = document.createElement('div');
  feed.getBoundingClientRect = () => rect(layout.feedOffset - scrollTop, 0);
  scroller.append(feed);
  document.body.append(scroller);
  rows = new Map();
  scrollTo = vi.fn((top: number) => { scrollTop = top; });
  virtualizer = fakeVirtualizer();
  // Rows a, b, c of 100px; the viewport's top edge sits 50px into b.
  layout = { keys: ['a', 'b', 'c'], sizes: {}, live: {}, feedOffset: 0 };
  next = layout;
  scrollTop = 150;
  mount(layout);
  view = render(<Feed />);
});

afterEach(() => {
  view.unmount();
  scroller.remove();
});

describe('useVirtualScrollAnchor', () => {
  it('holds the bottom edge of the row on screen when rows are prepended above it', () => {
    // b gains a predecessor, and with it a 20px top gap the cache has not seen.
    commit({ keys: ['x', 'y', 'a', 'b', 'c'], live: { b: 120 } });

    // b starts at 300 and is 120 tall; its bottom was 50px below the viewport top.
    expect(scrollTo).toHaveBeenCalledExactlyOnceWith(370);
    expect(virtualizer.scrollOffset).toBe(370);
  });

  it('leaves the viewport alone when rows are only appended', () => {
    commit({ keys: ['a', 'b', 'c', 'd'] });

    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('leaves the viewport alone when no mounted row survives the commit', () => {
    commit({ keys: ['p', 'q'] });

    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('falls through to the next surviving row when the one on screen is re-keyed', () => {
    // a and b are regrouped under a new key as earlier members load above them.
    commit({ keys: ['x', 'y', 'group', 'c'] });

    // c starts at 300; its bottom was 150px below the viewport top.
    expect(scrollTo).toHaveBeenCalledExactlyOnceWith(250);
  });

  it('holds the row when only what sits above the list changes', () => {
    commit({ feedOffset: 52 }, { layoutKey: 'a' });
    scrollTo.mockClear();
    scrollTop = 202;

    // The 52px status row above the feed goes away; the list is unchanged.
    commit({ feedOffset: 0 }, { layoutKey: 'b' });

    expect(scrollTo).toHaveBeenCalledExactlyOnceWith(150);
  });

  it('leaves the viewport to the follow while the transcript is following', () => {
    commit({ keys: ['x', 'y', 'a', 'b', 'c'] }, { following: true });

    expect(scrollTo).not.toHaveBeenCalled();
  });
});
