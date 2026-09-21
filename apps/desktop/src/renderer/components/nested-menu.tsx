import * as ContextMenu from '@radix-ui/react-context-menu';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Check, ChevronRight } from 'lucide-react';
import type { ReactElement, ReactNode } from 'react';

import { Tip } from './primitives';

export interface NestedMenuOption {
  id: string;
  label: string;
  icon?: ReactNode;
  selected?: boolean;
  disabled?: boolean;
  disabledReason?: ReactNode;
  onSelect?: () => void;
}

interface NestedMenuProps {
  label: string;
  icon?: ReactNode;
  options: readonly NestedMenuOption[];
}

function TriggerContents({ icon, label }: Pick<NestedMenuProps, 'icon' | 'label'>): React.JSX.Element {
  return <>{icon}<span>{label}</span><ChevronRight aria-hidden="true" className="nested-menu-arrow" size={14} /></>;
}

function OptionContents({ option }: { option: NestedMenuOption }): React.JSX.Element {
  return <>{option.icon ?? <span />}<span>{option.label}</span>{option.selected ? <Check aria-hidden="true" className="nested-menu-check" size={15} /> : <span />}</>;
}

/** Keep a disabled choice visible while putting the reason on the choice itself. */
function ExplainedOption({ children, option }: {
  children: ReactElement;
  option: NestedMenuOption;
}): React.JSX.Element {
  if (!option.disabled || option.disabledReason === undefined) return children;
  return <Tip label={option.disabledReason} side="right" sideOffset={8}>{children}</Tip>;
}

/** A consistently positioned right-hand submenu for a Radix context menu. */
export function ContextNestedMenu({ icon, label, options }: NestedMenuProps): React.JSX.Element {
  return (
    <ContextMenu.Sub>
      <ContextMenu.SubTrigger className="menu-item nested-menu-trigger">
        <TriggerContents icon={icon} label={label} />
      </ContextMenu.SubTrigger>
      <ContextMenu.Portal>
        <ContextMenu.SubContent alignOffset={-5} className="menu-content nested-menu-content" sideOffset={3}>
          {options.map((option) => (
            <ExplainedOption key={option.id} option={option}>
              <ContextMenu.Item
                aria-current={option.selected ? 'true' : undefined}
                className="menu-item nested-menu-option"
                disabled={option.disabled}
                onSelect={option.onSelect}
              >
                <OptionContents option={option} />
              </ContextMenu.Item>
            </ExplainedOption>
          ))}
        </ContextMenu.SubContent>
      </ContextMenu.Portal>
    </ContextMenu.Sub>
  );
}

/** The same interaction and geometry inside an ordinary Radix dropdown menu. */
export function DropdownNestedMenu({ icon, label, options }: NestedMenuProps): React.JSX.Element {
  return (
    <DropdownMenu.Sub>
      <DropdownMenu.SubTrigger className="menu-item nested-menu-trigger">
        <TriggerContents icon={icon} label={label} />
      </DropdownMenu.SubTrigger>
      <DropdownMenu.Portal>
        <DropdownMenu.SubContent alignOffset={-5} className="menu-content nested-menu-content" sideOffset={3}>
          {options.map((option) => (
            <ExplainedOption key={option.id} option={option}>
              <DropdownMenu.Item
                aria-current={option.selected ? 'true' : undefined}
                className="menu-item nested-menu-option"
                disabled={option.disabled}
                onSelect={option.onSelect}
              >
                <OptionContents option={option} />
              </DropdownMenu.Item>
            </ExplainedOption>
          ))}
        </DropdownMenu.SubContent>
      </DropdownMenu.Portal>
    </DropdownMenu.Sub>
  );
}
