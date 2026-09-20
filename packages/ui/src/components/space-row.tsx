import { IconLock, IconTriangle } from '@tabler/icons-react';
import * as ContextMenu from '@radix-ui/react-context-menu';
import type { SpaceColorKey, SpaceIconKey, SpaceScope } from '@rally/contracts';
import clsx from 'clsx';
import type { DragEvent, KeyboardEvent, ReactNode } from 'react';

import { SpaceIcon } from './space-appearance-picker';

/**
 * The part of a Space a row draws. Deliberately not `SpaceSummary`: a row does
 * not read a revision, a channel count or a participant list, and taking the
 * whole wire shape would make every field the socket adds a field this
 * component could start depending on.
 */
export interface SpaceRowSpace {
  id: string;
  name: string;
  iconKey: SpaceIconKey;
  colorKey: SpaceColorKey;
  scope: SpaceScope;
}

/**
 * The row's own contents, inside whatever navigation element the host draws.
 *
 * Split out the way `NavigationRowContent` is, and for the same reason: the
 * link is the host's — routing is a host decision under the PRD's design
 * decision 9 — and everything inside it is presentation this package owns.
 */
export function SpaceRowContent({ space }: { space: SpaceRowSpace }): React.JSX.Element {
  return (
    <>
      <span className="space-row-icon"><SpaceIcon space={space} /></span>
      <span>{space.name}</span>
      {/* A personal Space is the only one whose audience a reader cannot infer
          from where it is: an Organization-wide Space is what the section is
          mostly full of. The lock is the exception, so only the exception
          wears one. */}
      {space.scope === 'personal' && <IconLock aria-label="Private space" size={12} stroke={1.8} />}
      <span />
    </>
  );
}

/**
 * What a row does with a drag, supplied by the host that knows what a drop
 * means.
 *
 * One handler set rather than two, because the row is both a reorder source and
 * a Channel drop target and the two are told apart by what the transfer
 * carries, not by which element it landed on.
 */
export interface SpaceRowDrag {
  /** `cancelled` is a drag backed out of rather than dropped on the list. */
  onDragEnd: (cancelled: boolean) => void;
  onDragEnter: (event: DragEvent<HTMLDivElement>) => void;
  onDragStart: (event: DragEvent<HTMLDivElement>) => void;
  onDrop: (event: DragEvent<HTMLDivElement>) => void;
}

/**
 * One Space in a navigation list: its mark, its name, its placements, and the
 * actions a row carries.
 *
 * Presentational. Expansion, activity, drag semantics and navigation are all
 * the host's; what lives here is the geometry, the accordion control, the
 * motion keys — `space:<id>` on the row, so a Space
 * reordered past another glides with the placements under it.
 *
 * **The context menu is optional.** A person who reaches a Space only because
 * they can read a Channel placed in it is shown its mark and name so that
 * Channel has somewhere to be drawn, but may write nothing on the Space —
 * archiving it included. A control that can only fail is omitted.
 */
export function SpaceRow({
  active,
  children,
  contextMenu,
  drag,
  expanded,
  link,
  onRowKeyDown,
  onToggleExpanded,
  space,
}: {
  active: boolean;
  /** The placements under this Space, drawn by the host from its own rows. */
  children?: ReactNode;
  /** Host-owned actions for the visual row. Omitted when the host offers none. */
  contextMenu?: ReactNode;
  /** Both a reorder source and a Channel drop target; see {@link SpaceRowDrag}. */
  drag: SpaceRowDrag;
  expanded: boolean;
  /** The host's navigation element, wrapping {@link SpaceRowContent}. */
  link: ReactNode;
  onRowKeyDown?: ((event: KeyboardEvent<HTMLDivElement>) => void) | undefined;
  onToggleExpanded: () => void;
  space: SpaceRowSpace;
}): React.JSX.Element {
  const visualRow = (
    <div
      className={clsx('sidebar-row space-sidebar-row', active && 'is-active')}
      data-motion-hold=""
      data-motion-key={`space:${space.id}`}
      onKeyDown={onRowKeyDown}
    >
      <button
        aria-expanded={expanded}
        aria-label={`${expanded ? 'Collapse' : 'Expand'} ${space.name}`}
        className="space-accordion-control"
        onClick={onToggleExpanded}
        type="button"
      >
        <IconTriangle className={clsx(expanded && 'is-expanded')} size={10} stroke={1.8} />
      </button>
      {link}
    </div>
  );
  return (
    <div
      className="space-sidebar-item"
      draggable
      // A drag nothing accepted reports `none`. Treated as cancelled when the
      // browser gives no `dataTransfer` at all, because a drop the list handled
      // always leaves one behind. The same reading as the Channel row's and the
      // Breakout rail's, so all three lists tell Escape from a drop one way.
      onDragEnd={(event) => drag.onDragEnd((event.dataTransfer?.dropEffect ?? 'none') === 'none')}
      onDragEnter={drag.onDragEnter}
      onDragOver={(event) => event.preventDefault()}
      onDragStart={drag.onDragStart}
      onDrop={drag.onDrop}
    >
      {/* Held: a Space reordered past another glides with its expanded
          placements rather than jumping while they slide. The row rather than
          the item carries it, because the placements animate themselves and a
          moving item would carry them a second time. See `useListMotion`. */}
      {contextMenu === undefined ? visualRow : (
        <ContextMenu.Root>
          <ContextMenu.Trigger asChild>{visualRow}</ContextMenu.Trigger>
          <ContextMenu.Portal>
            <ContextMenu.Content className="menu-content sidebar-context-menu" collisionPadding={8}>
              {contextMenu}
            </ContextMenu.Content>
          </ContextMenu.Portal>
        </ContextMenu.Root>
      )}
      {children}
    </div>
  );
}

/**
 * The placements under an expanded Space.
 *
 * Its own motion scope: a placement is the same row the recent list shows, and
 * the sidebar's motion would otherwise take a Channel listed under two Spaces
 * for one row in two places.
 */
export function SpacePlacementList({ children, spaceId }: {
  children: ReactNode;
  spaceId: string;
}): React.JSX.Element {
  return (
    <div
      className="space-sidebar-workstreams"
      // The rows inside are the slots a drag within this list is measured
      // against. Marked rather than named by class, because the pinned list is
      // the other one arranged the same way and neither should have to know
      // the other's markup.
      data-reorder-list=""
      data-motion-scope={`space:${spaceId}`}
    >
      {children}
    </div>
  );
}
