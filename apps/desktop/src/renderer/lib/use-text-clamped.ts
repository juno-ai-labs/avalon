import { useEffect, useState } from 'react';

/**
 * Whether `node` is hiding lines that a line clamp cut off.
 *
 * The vertical counterpart to `useTextClipped`: a block capped at a few lines
 * with `overflow: hidden` shows nothing to say that more text exists, so a
 * caller has to know when to offer a control that reveals it. Offering that
 * control unconditionally is worse than not having one — most system messages
 * are a single line, and a "more" beside a sentence that is already whole reads
 * as a bug.
 *
 * `clampApplied` is the caller's own collapsed state, and measurement stops
 * when it is false. Expanding the block removes the clamp, at which point the
 * box can no longer answer the question — `scrollHeight` and `clientHeight`
 * agree, and a hook that kept measuring would retract the control the reader
 * just used and strand them in the expanded text. The last answer taken while
 * the clamp was applied stands until it is applied again.
 *
 * `text` is a dependency because longer text can overflow a box that never
 * changed size, and nothing else here would fire for that.
 */
export function useTextClamped(node: HTMLElement | null, text: string, clampApplied: boolean): boolean {
  const [clamped, setClamped] = useState(false);

  useEffect(() => {
    if (!node || !clampApplied) return undefined;
    // Both measurements are integers taken from a box whose line height is
    // usually fractional, so five clamped lines can report a scroll height a
    // pixel over the client height with no sixth line behind it. A whole line
    // of tolerance is what distinguishes hidden text from that rounding.
    const measure = (): void => setClamped(node.scrollHeight - node.clientHeight > 4);
    measure();
    // The element's own size rather than the window's: the transcript column is
    // resized by the right rail opening with the window perfectly still, and a
    // narrower column pushes text past the clamp that fitted before it.
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [clampApplied, node, text]);

  return clamped;
}
