import { useEffect, useState } from 'react';

/**
 * Whether `node` is showing an ellipsis in place of text it could not fit.
 *
 * For a single-line box that truncates — `overflow: hidden` with
 * `text-overflow: ellipsis` — the hidden characters exist nowhere else on the
 * screen, so a caller has to know when to offer them somewhere: a tooltip, an
 * expanded row, a title attribute.
 *
 * `text` is what the box contains, and is a dependency because a longer string
 * can overflow a box that never changed size — a renamed record, or a generated
 * name replacing a provisional one. Nothing else here would fire for that.
 */
export function useTextClipped(node: HTMLElement | null, text: string): boolean {
  const [clipped, setClipped] = useState(false);

  useEffect(() => {
    if (!node) return undefined;
    // Any overflow at all counts. Both measurements are integers taken from a
    // box that is usually fractional, so a tolerance is tempting — but a box a
    // fraction of a pixel short still renders the ellipsis, and making room for
    // that ellipsis costs several pixels of real characters. The two errors are
    // not worth the same: over-reporting offers text the reader can already
    // see, while under-reporting hides text they cannot.
    const measure = (): void => setClipped(node.scrollWidth > node.clientWidth);
    measure();
    // The element's own size rather than the window's: a surrounding panel can
    // open, close, or animate its width with the window perfectly still, and a
    // `resize` listener would miss every one of those.
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [node, text]);

  return clipped;
}
