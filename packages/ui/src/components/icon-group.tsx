import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { IconCheck, IconDots } from '@tabler/icons-react';
import clsx from 'clsx';
import { useRef, type ReactNode } from 'react';
import { IconButton } from './primitives';

/** One action an `IconGroup` shows as an icon button, or as a row of its menu at phone width. */
export interface IconGroupAction {
  key: string;
  label: string;
  icon: ReactNode;
  onSelect: () => void;
  disabled?: boolean;
  /** Set for a toggle: the button carries `aria-pressed`, its menu row a check. */
  pressed?: boolean;
  /** Where the button's tooltip opens; `bottom` unless the host's content would cover it. */
  tooltipSide?: 'top' | 'right' | 'bottom' | 'left';
}

/**
 * A row of icon buttons with the spacing between them built in, so a header
 * or toolbar never sets its own gap or lets two round controls touch.
 *
 * `actions` are icon buttons on a wide window and collapse into one "More"
 * button with a dropdown at phone width, where a row of them crowds the title
 * beside it. `children` always stay as they are: the control that closes the
 * pane belongs at the edge, not one tap deeper. An element with no content
 * takes no space, so an empty slot leaves no stray gap.
 *
 * `folded` folds them at any width, for a host that has measured the row as
 * crowding its neighbour (`TitlePillHeader` does).
 */
export function IconGroup({ actions = [], buttonClassName, children, className, folded = false, moreLabel = 'More actions' }: {
  actions?: readonly IconGroupAction[];
  folded?: boolean;
  /** The look every button in the group shares, the "More" button included. */
  buttonClassName?: string;
  children?: ReactNode;
  className?: string;
  moreLabel?: string;
}): React.JSX.Element {
  const moreRef = useRef<HTMLButtonElement>(null);
  return <div className={clsx('icon-group', folded && 'is-folded', className)}>
    {actions.length > 0 && <>
      <span className="icon-group-actions">
        {actions.map((action) => <IconButton
          aria-pressed={action.pressed}
          className={clsx(buttonClassName, action.pressed !== undefined && 'icon-button-toggle')}
          disabled={action.disabled}
          key={action.key}
          label={action.label}
          onClick={action.onSelect}
          tooltipSide={action.tooltipSide}
        >
          {action.icon}
        </IconButton>)}
      </span>
      <DropdownMenu.Root modal={false}>
        <DropdownMenu.Trigger asChild>
          <IconButton className={clsx('icon-group-more', buttonClassName)} label={moreLabel} ref={moreRef}>
            <IconDots aria-hidden="true" size={16} stroke={1.9} />
          </IconButton>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content align="end" className="menu-content icon-group-menu" collisionPadding={12} sideOffset={8}>
            {actions.map((action) => {
              const common = {
                className: 'menu-item',
                disabled: action.disabled,
                onSelect: () => {
                  // The item is about to unmount with its menu. An action that
                  // remembers where focus was (Expand, to return to it) should
                  // find the "More" button, which stays.
                  moreRef.current?.focus();
                  action.onSelect();
                },
              };
              return action.pressed === undefined
                ? <DropdownMenu.Item {...common} key={action.key}>{action.icon}{action.label}</DropdownMenu.Item>
                : <DropdownMenu.CheckboxItem {...common} checked={action.pressed} key={action.key}>
                  {action.icon}{action.label}
                  {/* At the end, so the row keeps the icon its button shows. */}
                  <DropdownMenu.ItemIndicator className="icon-group-menu-check">
                    <IconCheck aria-hidden="true" size={15} stroke={1.9} />
                  </DropdownMenu.ItemIndicator>
                </DropdownMenu.CheckboxItem>;
            })}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </>}
    {children}
  </div>;
}

