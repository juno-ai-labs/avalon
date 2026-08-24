import { type KeyboardEvent, useEffect, useState } from 'react';

export interface MentionNavigation {
  /** The option Enter would choose, or `-1` while the popover holds nothing. */
  activeIndex: number;
  /** Moves the highlight under the pointer so hover and the keyboard agree. */
  setActiveIndex: (index: number) => void;
  /**
   * Attach to the active option only. Keeps the highlight inside the
   * popover's scroll box as the arrows walk past its bottom edge.
   */
  activeOptionRef: (element: HTMLElement | null) => void;
  /**
   * Call first from the composer's own key handler: it consumes the arrows and
   * Enter while the popover is open and returns whether it did, so a caller
   * can leave the rest of its handler untouched.
   */
  handleKeyDown: (event: KeyboardEvent) => boolean;
}

/**
 * Arrow-key and Enter selection for an `@` popover.
 *
 * The popover floats above a textarea that keeps focus throughout — moving
 * focus onto the options would take the caret out of the draft — so there is no
 * focus ring to follow and the highlight is state rather than the browser's.
 *
 * That state is the highlighted option's **key**, not its index. The list is
 * refiltered on every keystroke, and an index would slide onto whichever
 * candidate happened to inherit the slot: typing a further letter after
 * arrowing down to someone would hand Enter to a different person than the one
 * under the highlight. A key follows its own row while it survives the filter,
 * and falls back to the top of the list once it does not.
 *
 * @param optionKeys Keys of the visible options, in the order they render.
 *   Empty means the popover is closed, which also resets the highlight to the
 *   top for the next time it opens.
 * @param onSelect Chooses the option at an index — what Enter commits.
 */
export function useMentionNavigation(
  optionKeys: readonly string[],
  onSelect: (index: number) => void,
): MentionNavigation {
  const [activeKey, setActiveKey] = useState<string | null>(null);
  // Length rather than the array: the caller rebuilds it every render, and the
  // only transition worth reacting to is the popover closing.
  useEffect(() => {
    if (optionKeys.length === 0) setActiveKey(null);
  }, [optionKeys.length]);
  const activeIndex = optionKeys.length === 0
    ? -1
    // A key the filter has dropped reads as -1, which is the top of the list.
    : Math.max(activeKey === null ? 0 : optionKeys.indexOf(activeKey), 0);

  return {
    activeIndex,
    setActiveIndex: (index) => setActiveKey(optionKeys[index] ?? null),
    activeOptionRef: (element) => {
      // Optional call because jsdom leaves `scrollIntoView` undefined, and the
      // component tests render this popover.
      element?.scrollIntoView?.({ block: 'nearest' });
    },
    handleKeyDown: (event) => {
      if (optionKeys.length === 0) return false;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        // Wraps, so holding one arrow reaches every option without knowing
        // which end the list is at.
        const next = (activeIndex + (event.key === 'ArrowDown' ? 1 : -1) + optionKeys.length) % optionKeys.length;
        setActiveKey(optionKeys[next] ?? null);
        // Both keys otherwise move the caret out of the mention being typed.
        event.preventDefault();
        return true;
      }
      if (event.key === 'Enter' && !event.shiftKey) {
        // Also what stops the composer submitting the half-typed mention: it
        // checks `defaultPrevented` before sending.
        event.preventDefault();
        onSelect(activeIndex);
        return true;
      }
      return false;
    },
  };
}
