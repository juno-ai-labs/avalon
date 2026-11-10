import type { CanvasSidekick } from '@rally/contracts';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { MenuActionItem } from '@rally/ui/components/menu-action-item';
import { TitleMenuSeparator } from '@rally/ui/components/title-pill';
import { useId } from 'react';

import { AutomationGlyph } from './workstream-glyph';

const STATE_LABEL: Record<CanvasSidekick['status'], string> = { draft: 'Draft', active: 'Active', paused: 'Paused' };

/** Why a row for a Sidekick this Canvas made opens nothing: its page is for the people it is shared with, and the Chat is how it is changed. */
export const SIDEKICK_NOT_SHARED_REASON = 'Ask in this Canvas’s chat to change it. Its creator can share it with you to open it.';
/** The same for one made elsewhere and attached here, which this Canvas's Chat does not change. */
export const ATTACHED_SIDEKICK_NOT_SHARED_REASON = 'Someone who manages this Sidekick can share it with you to open it.';

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
 * the Sidekick is shared with (`canOpen`); the page answers nobody else, so for
 * them the row stays focusable and says how to change it instead.
 * The menu archives none of them: a Sidekick this Canvas made is archived by
 * asking the Canvas's Chat, or with the Canvas. Draws nothing for a Canvas
 * with no Sidekicks.
 */
export function CanvasSidekicksSection({ onOpen, sidekicks }: {
  onOpen: (sidekick: CanvasSidekick) => void;
  sidekicks: readonly CanvasSidekick[];
}): React.JSX.Element | null {
  const labelId = useId();
  if (sidekicks.length === 0) return null;
  return <>
    <TitleMenuSeparator />
    <DropdownMenu.Group aria-labelledby={labelId} className="canvas-sidekicks">
      <DropdownMenu.Label className="menu-label workspace-menu-section" id={labelId}>Sidekicks</DropdownMenu.Label>
      {sidekicks.map((sidekick) => {
        const openable = sidekick.canOpen === true;
        return <MenuActionItem
            key={sidekick.id}
            className="menu-item title-menu-item title-menu-action canvas-sidekick-open"
            disabled={!openable}
            disabledReason={sidekick.madeHere ? SIDEKICK_NOT_SHARED_REASON : ATTACHED_SIDEKICK_NOT_SHARED_REASON}
            onSelect={() => onOpen(sidekick)}
            tooltipSide="right"
          >
            <span className="canvas-sidekick-mark"><AutomationGlyph {...(sidekick.appearance ? { appearance: sidekick.appearance } : {})} id={sidekick.id} /></span>
            <span className="title-menu-item-copy">{sidekick.name}</span>
            <span className="title-menu-level-meta">{STATE_LABEL[sidekick.status]}</span>
          </MenuActionItem>;
      })}
    </DropdownMenu.Group>
  </>;
}
