import type { WorkstreamAppearance } from '@rally/contracts';
import * as ContextMenu from '@radix-ui/react-context-menu';
import { IconCarambola } from '@tabler/icons-react';
import { AutomationGlyph } from './workstream-glyph';
import { InlineError, Tip } from './primitives';
export interface SidekickRow {
  recommended?: boolean;
  /** Management options have not arrived for this non-owned row yet. */
  managementPending?: boolean;
  id: string;
  name: string;
  description: string;
  /**
   * What is true of this Sidekick beyond its description — `Draft`, `Paused`,
   * `Unavailable`. Read before the description rather than instead of it, so
   * the row still says which Sidekick it is.
   */
  note?: string | undefined;
  appearance?: WorkstreamAppearance | undefined;
  /** Present only where the caller may detach it; a room's own row has none. */
  onRemove?: (() => void) | undefined;
  onRemoveRecommendation?: (() => void) | undefined;
  onRecommend?: (() => void) | undefined;
}

export type SidekickSectionFailure = 'load' | 'remove';

const sidekickSectionFailureCopy: Record<SidekickSectionFailure, string> = {
  load: 'Some Sidekick information may be out of date.',
  remove: 'That Sidekick couldn’t be removed.',
};

/**
 * The rail's **Sidekicks** section, or nothing.
 *
 * Absent while `items` is `undefined` — the answer is still on its way — and
 * absent again for `[]`, which is the rail's settled answer to an empty
 * section: a heading over nothing reads as a load failure, and the artifact
 * section beside this one drops itself for the same reason. The two states are
 * still kept apart in the caller, because only one of them may ever be turned
 * into a claim about the room.
 *
 * A failure sits *beside* the rows rather than replacing them. A failed removal
 * is an action failure, while a failed read says only that the rows which did
 * arrive may be incomplete. Alone — nothing arrived — only a read failure can
 * take the section's heading with it, because then the reader is being told
 * about this section rather than about a row in it.
 *
 * The state is a closed semantic union. A transport or provider message is
 * diagnostic data, not product copy; accepting only the failed operation keeps
 * arbitrary API responses out of the sidebar and leaves this shared
 * presentation boundary responsible for the words a person sees.
 */
export function SidekickSection({ items, failure, onOpen, onMenuOpen }: {
  items?: SidekickRow[] | undefined;
  failure?: SidekickSectionFailure | undefined;
  onOpen?: (id: string) => void; onMenuOpen?: () => void;
}): React.JSX.Element | null {
  const Row = onOpen ? 'button' : 'div';
  if (!items?.length) {
    return failure === 'load'
      ? <section aria-label="Sidekicks" className="workstream-context-section sidekick-section"><h2>Sidekicks</h2>
        <InlineError>Sidekicks couldn’t be loaded.</InlineError>
      </section>
      : null;
  }
  return <section aria-label="Sidekicks" className="workstream-context-section sidekick-section"><h2>Sidekicks</h2>
    {failure && <InlineError>{sidekickSectionFailureCopy[failure]}</InlineError>}
    <ul className="sidekick-section-list">{items.map((item) => <ContextMenu.Root key={item.id} onOpenChange={(open) => { if (open) onMenuOpen?.(); }}><li>
      {/* The rail's own tooltip rather than the platform's, as the artifact
          rows above take it: a name this rail truncates — or hides outright
          when compact — is the whole reason the row carries one. The note
          rides along because compact hides the copy underneath, and a row
          nobody can read is the one place **Paused** is worth saying twice. */}
      <Tip label={item.note ? `${item.name} · ${item.note}` : item.name} side="right">
        <ContextMenu.Trigger asChild disabled={!item.managementPending && !item.onRemove && !item.onRemoveRecommendation && !item.onRecommend}>
        <Row className="workstream-context-row" {...(onOpen ? { type: "button" as const } : { tabIndex: 0 })} aria-label={item.name} aria-description={item.recommended ? 'Recommended Sidekick' : undefined} onClick={() => onOpen?.(item.id)}>
          {/* The library's own hexagon, at the rail's size: compact drops every
              title in this rail, and a Sidekick row without its mark collapses
              to an empty square there. */}
          <span aria-hidden="true" className="workstream-context-mark"><span className="workstream-context-sidekick-glyph">
            <AutomationGlyph id={item.id} {...(item.appearance ? { appearance: item.appearance } : {})} />
          </span></span>
          <span className="workstream-context-copy"><span>{item.name}</span>
            <small>{item.note ? `${item.note} · ${item.description}` : item.description}</small></span>
        </Row>
        </ContextMenu.Trigger>
      </Tip>
      {item.recommended && <Tip className="sidekick-recommendation-tooltip" label="Recommended for every substream in this work stream. Agents can load it when relevant; it isn’t automatically loaded." side="right">
        <span className="sidekick-recommendation" role="img" aria-label="Recommended Sidekick" tabIndex={0}>
          <IconCarambola size={14} stroke={1.5} aria-hidden="true" />
        </span>
      </Tip>}
      {(item.managementPending || item.onRemove || item.onRemoveRecommendation || item.onRecommend) && <ContextMenu.Portal>
        <ContextMenu.Content className="menu-content">
          {item.managementPending && <ContextMenu.Label className="menu-label">Loading Sidekick options…</ContextMenu.Label>}
          {item.onRemove && <ContextMenu.Item className="menu-item" onSelect={item.onRemove}>Remove from this substream</ContextMenu.Item>}
          {item.onRemoveRecommendation && <ContextMenu.Item className="menu-item" onSelect={item.onRemoveRecommendation}>Remove work stream recommendation</ContextMenu.Item>}
          {item.onRecommend && <ContextMenu.Item className="menu-item" onSelect={item.onRecommend}>Recommend for this work stream</ContextMenu.Item>}
        </ContextMenu.Content>
      </ContextMenu.Portal>}
    </li></ContextMenu.Root>)}</ul>
  </section>;
}
