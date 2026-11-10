import type { CanvasSidekick } from '@rally/contracts';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { MenuActionItem } from '@rally/ui/components/menu-action-item';
import { TitleMenuSeparator } from '@rally/ui/components/title-pill';
import { IconArchive } from '@tabler/icons-react';

import { Tip } from './primitives';
import { AutomationGlyph } from './workstream-glyph';

const STATE_LABEL: Record<CanvasSidekick['status'], string> = { draft: 'Draft', active: 'Active', paused: 'Paused' };

/** Why a Sidekick's row opens nothing: its own page is for the people it is shared with. */
export const SIDEKICK_NOT_SHARED_REASON = 'Ask in this Canvas’s chat to change it. Its creator can share it with you to open it.';

/**
 * What Archive canvas adds to its confirmation for the Sidekicks this Canvas's
 * Chat made, which the server archives with it. Nothing for a Canvas that
 * made none: an attached Sidekick somebody made elsewhere is left alone.
 */
export function madeSidekicksArchiveCopy(sidekicks: readonly CanvasSidekick[]): string | null {
  const made = sidekicks.filter((sidekick) => sidekick.madeHere).length;
  if (made === 0) return null;
  return made === 1
    ? 'Archiving also archives the Sidekick this Canvas made.'
    : `Archiving also archives the ${made} Sidekicks this Canvas made.`;
}

/**
 * The Canvas menu's Sidekicks section: one row per attached Sidekick, with its
 * hexagon, name and state. A row opens the Sidekick's page only for someone
 * whose own Sidekicks list holds it (`openableIds`); the page answers nobody
 * else, so for them the row stays focusable and says how to change it instead.
 * A Sidekick this Canvas made carries Archive beside its row, which everyone in
 * the Canvas may do. Draws nothing for a Canvas with no Sidekicks.
 */
export function CanvasSidekicksSection({ onArchive, onOpen, openableIds, sidekicks }: {
  onArchive: (sidekick: CanvasSidekick) => void;
  onOpen: (sidekick: CanvasSidekick) => void;
  openableIds: ReadonlySet<string>;
  sidekicks: readonly CanvasSidekick[];
}): React.JSX.Element | null {
  if (sidekicks.length === 0) return null;
  return <>
    <TitleMenuSeparator />
    <DropdownMenu.Group className="canvas-sidekicks">
      <DropdownMenu.Label className="menu-label workspace-menu-section">Sidekicks</DropdownMenu.Label>
      {sidekicks.map((sidekick) => {
        const openable = openableIds.has(sidekick.id);
        return <div className="canvas-sidekick-row" key={sidekick.id}>
          <MenuActionItem
            className="menu-item title-menu-item title-menu-action canvas-sidekick-open"
            disabled={!openable}
            disabledReason={SIDEKICK_NOT_SHARED_REASON}
            onSelect={() => onOpen(sidekick)}
            tooltipSide="right"
          >
            <span className="canvas-sidekick-mark"><AutomationGlyph {...(sidekick.appearance ? { appearance: sidekick.appearance } : {})} id={sidekick.id} /></span>
            <span className="title-menu-item-copy">{sidekick.name}</span>
            <span className="title-menu-level-meta">{STATE_LABEL[sidekick.status]}</span>
          </MenuActionItem>
          {sidekick.madeHere && <Tip label="Archive Sidekick" side="right">
            <DropdownMenu.Item
              aria-label={`Archive Sidekick: ${sidekick.name}`}
              className="menu-item menu-item-danger canvas-sidekick-archive"
              onSelect={() => onArchive(sidekick)}
            >
              <IconArchive aria-hidden="true" size={16} stroke={1.8} />
            </DropdownMenu.Item>
          </Tip>}
        </div>;
      })}
    </DropdownMenu.Group>
  </>;
}
