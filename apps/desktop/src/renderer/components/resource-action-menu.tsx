import * as ContextMenu from '@radix-ui/react-context-menu';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { IconDots, IconPin, IconPinnedOff } from '@tabler/icons-react';
import clsx from 'clsx';
import { useState, type ReactElement } from 'react';

export type ResourceActionIcon = 'pin' | 'unpin';

/** One thing a host lets a person do to a resource from its menus. */
export interface ResourceAction {
  readonly id: string;
  readonly label: string;
  /** A mark drawn before the label, from the few the menus share. */
  readonly icon?: ResourceActionIcon;
  readonly disabled?: boolean;
  readonly onSelect: () => void;
}

function ActionIcon({ icon }: { icon: ResourceActionIcon | undefined }): React.JSX.Element | null {
  if (icon === 'pin') return <IconPin aria-hidden="true" size={15} stroke={1.8} />;
  if (icon === 'unpin') return <IconPinnedOff aria-hidden="true" size={15} stroke={1.8} />;
  return null;
}

/**
 * A right-click menu over any resource presentation.
 *
 * The host decides which actions a resource has; this only draws them. With no
 * actions the child renders untouched, so a surface that offers none keeps the
 * browser's own behaviour and pays for no menu. Radix's trigger prevents the
 * event's default, which is what stops a surrounding message menu from opening
 * over this one.
 */
export function ResourceActionMenu({ actions, children }: {
  actions: readonly ResourceAction[] | undefined;
  children: ReactElement;
}): React.JSX.Element {
  if (!actions || actions.length === 0) return children;
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="menu-content sidebar-context-menu" collisionPadding={8}>
          {actions.map((action) => (
            <ContextMenu.Item
              className="menu-item"
              disabled={action.disabled}
              key={action.id}
              onSelect={action.onSelect}
            >
              <ActionIcon icon={action.icon} />
              {action.label}
            </ContextMenu.Item>
          ))}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

/**
 * The same actions behind a `⋯` button that shows while the card is hovered or
 * focused, for a person who would not think to right-click. The button sits
 * beside the card rather than in it, because the card is itself a button.
 * `placement` puts it at the end of a file card's row, or in the corner of an
 * image. With no actions the card renders alone, as the right-click menu does.
 */
export function ResourceMoreMenu({ actions, children, label, placement }: {
  actions: readonly ResourceAction[] | undefined;
  children: ReactElement;
  label: string;
  placement: 'row' | 'corner';
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  if (!actions || actions.length === 0) return children;
  return (
    <span className={clsx('resource-more-shell', `is-${placement}`, open && 'is-open')}>
      {children}
      <DropdownMenu.Root modal={false} onOpenChange={setOpen} open={open}>
        <DropdownMenu.Trigger aria-label={`More for ${label}`} className="resource-more-button">
          <IconDots aria-hidden="true" size={16} stroke={2} />
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content align={placement === 'corner' ? 'start' : 'end'} className="menu-content" collisionPadding={8} sideOffset={4}>
            {actions.map((action) => (
              <DropdownMenu.Item
                className="menu-item"
                disabled={action.disabled}
                key={action.id}
                onSelect={action.onSelect}
              >
                <ActionIcon icon={action.icon} />
                {action.label}
              </DropdownMenu.Item>
            ))}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </span>
  );
}
