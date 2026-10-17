import type { IconGroupAction } from '@rally/ui/components/icon-group';
import { IconArrowsDiagonal, IconArrowsDiagonalMinimize2 } from '@tabler/icons-react';

/**
 * The header action that expands a pane over the one beside it, or puts it
 * back: Expand while both are on screen, Collapse while it is expanded. One
 * builder for every level of the stack, a thread, a breakout and a panel, so
 * each draws the same control (`docs/pane-stack.md`).
 */
export function expandToggle(expanded: boolean, beside: boolean, setExpanded: (expanded: boolean) => void): IconGroupAction[] | undefined {
  if (expanded) {
    // One key for both states, so the button a keyboard pressed keeps focus.
    return [{
      key: 'expand',
      label: 'Collapse',
      icon: <IconArrowsDiagonalMinimize2 aria-hidden="true" size={16} stroke={1.9} />,
      onSelect: () => setExpanded(false),
    }];
  }
  if (!beside) return undefined;
  return [{
    key: 'expand',
    label: 'Expand',
    icon: <IconArrowsDiagonal aria-hidden="true" size={16} stroke={1.9} />,
    onSelect: () => setExpanded(true),
  }];
}
