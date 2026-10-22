import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import type { ReactNode } from 'react';
import { Tip } from './primitives';

/** Explained disabled actions stay in the menu's keyboard path without selecting. */
export function MenuActionItem({ children, className = 'menu-item', disabled = false, disabledReason, onSelect, tooltipSide = 'bottom' }: {
  children: ReactNode;
  className?: string;
  disabled?: boolean | undefined;
  disabledReason?: string | undefined;
  onSelect: () => void;
  tooltipSide?: 'top' | 'right' | 'bottom' | 'left';
}): React.JSX.Element {
  const explained = disabled && Boolean(disabledReason);
  const row = <DropdownMenu.Item
    aria-disabled={disabled || undefined}
    className={className}
    data-disabled={disabled ? '' : undefined}
    disabled={disabled && !explained}
    onSelect={(event) => {
      if (disabled) event.preventDefault();
      else onSelect();
    }}
  >{children}</DropdownMenu.Item>;
  return explained ? <Tip label={disabledReason} side={tooltipSide}>{row}</Tip> : row;
}
