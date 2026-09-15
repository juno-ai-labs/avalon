import { Tip } from "./primitives";
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import type { ReactElement } from 'react';
import { NavLink } from 'react-router-dom';

/** Shared creation choices for the expanded sidebar and compact rail. */
export function NewWorkstreamMenu({ children, returnTo, onStart, tooltipSide = "bottom" }: {
  children: ReactElement;
  tooltipSide?: "bottom" | "right";
  returnTo?: string | undefined;
  onStart: () => void;
}): React.JSX.Element {
  return <DropdownMenu.Root>
    <Tip describesTrigger={false} label="New work stream" side={tooltipSide}><DropdownMenu.Trigger asChild>{children}</DropdownMenu.Trigger></Tip>
    <DropdownMenu.Portal>
      <DropdownMenu.Content className="menu-content" align="start" sideOffset={6}>
        <DropdownMenu.Item asChild>
          <NavLink className="menu-item" to="/workstreams/new" state={returnTo ? { returnTo } : undefined} onClick={onStart}>
            start new work stream
          </NavLink>
        </DropdownMenu.Item>
        <DropdownMenu.Item asChild>
          <NavLink className="menu-item" to="/workstreams/new?import=session" state={returnTo ? { returnTo } : undefined}>
            import from ChatGPT or Claude
          </NavLink>
        </DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  </DropdownMenu.Root>;
}
