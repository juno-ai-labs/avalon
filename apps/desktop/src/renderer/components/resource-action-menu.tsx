import * as ContextMenu from '@radix-ui/react-context-menu';
import type { ReactElement } from 'react';

/** One thing a host lets a person do to a resource from its right-click menu. */
export interface ResourceAction {
  readonly id: string;
  readonly label: string;
  readonly disabled?: boolean;
  readonly onSelect: () => void;
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
              {action.label}
            </ContextMenu.Item>
          ))}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
