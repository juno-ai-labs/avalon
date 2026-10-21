import type { WorkstreamAppearance } from '@rally/contracts';
import * as ContextMenu from '@radix-ui/react-context-menu';
import { IconCarambola } from '@tabler/icons-react';
import { AutomationGlyph } from './workstream-glyph';
import { ErrorNotice, Tip } from './primitives';
import { SidebarHorizontalLine, SidebarRow } from './resizable-sidebar';
import { SidebarNavigationRowContent } from './navigation';
import { SidebarRefreshRow } from './sidebar-refresh-row';
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
  /** What `onRemove` is called on screen; a breakout's list is the default. */
  removeLabel?: string | undefined;
  onRemoveRecommendation?: (() => void) | undefined;
  onRecommend?: (() => void) | undefined;
}

export type SidekickSectionFailure = 'load' | 'remove' | 'recommend' | 'unrecommend';

const sidekickSectionFailureCopy: Record<Exclude<SidekickSectionFailure, 'load'>, string> = {
  remove: 'That Sidekick couldn’t be removed.',
  recommend: 'That Sidekick couldn’t be recommended.',
  unrecommend: 'That Sidekick recommendation couldn’t be removed.',
};

/**
 * The rail's **Sidekicks** section.
 *
 * Its heading is stable while `items` is `undefined` — the answer is still on
 * its way — and for `[]`, the settled answer to an empty section. Sidekicks are
 * a standing kind of participant in a room, so this label remains beside the
 * always-visible Participants section even when there are no rows beneath it.
 * The two item states stay apart in the caller because only `[]` may be turned
 * into a claim about what the room contains.
 *
 * A failed read keeps the rows that did arrive and offers a normal Refresh row;
 * it never writes warning copy into the rail. Alone — nothing arrived — the
 * refresh action sits beneath the same stable heading.
 *
 * The state is a closed semantic union. A transport or provider message is
 * diagnostic data, not product copy; accepting only the failed operation keeps
 * arbitrary API responses out of the sidebar and leaves this shared
 * presentation boundary responsible for the words a person sees.
 */
export function SidekickSection({ items, failure, onOpen, onMenuOpen, onRefresh, layoutId }: {
  items?: SidekickRow[] | undefined;
  failure?: SidekickSectionFailure | undefined;
  onOpen?: (id: string) => void; onMenuOpen?: () => void; onRefresh?: () => void;
  layoutId?: string;
}): React.JSX.Element {
  const Row = onOpen ? 'button' : 'div';
  if (!items?.length) {
    return <section aria-label="Sidekicks" className="workstream-context-section sidekick-section" data-layout-id={layoutId}><SidebarHorizontalLine /><h2>Sidekicks</h2>
      {failure === 'load' && onRefresh && <SidebarRefreshRow onRefresh={onRefresh} />}
    </section>;
  }
  return <section aria-label="Sidekicks" className="workstream-context-section sidekick-section" data-layout-id={layoutId}><SidebarHorizontalLine /><h2>Sidekicks</h2>
    {failure === 'load' ? onRefresh && <SidebarRefreshRow onRefresh={onRefresh} />
      : failure && <ErrorNotice>{sidekickSectionFailureCopy[failure]}</ErrorNotice>}
    <ul className="sidekick-section-list">{items.map((item) => <ContextMenu.Root key={item.id} onOpenChange={(open) => { if (open) onMenuOpen?.(); }}><li data-layout-id={`sidekick:${item.id}`}>
      {/* The rail's own tooltip rather than the platform's, as the artifact
          rows above take it: a name this rail truncates — or hides outright
          when compact — is the whole reason the row carries one. The note
          rides along because compact hides the copy underneath, and a row
          nobody can read is the one place **Paused** is worth saying twice. */}
      <Tip label={item.note ? `${item.name} · ${item.note}` : item.name} side="right">
        <ContextMenu.Trigger asChild disabled={!item.managementPending && !item.onRemove && !item.onRemoveRecommendation && !item.onRecommend}>
        <SidebarRow as={Row} className="workstream-context-row" {...(onOpen ? { type: "button" as const } : { tabIndex: 0 })} aria-label={item.name} aria-description={item.recommended ? 'Recommended Sidekick' : undefined} onClick={() => onOpen?.(item.id)}>
          {/* The library's own hexagon, at the rail's size: compact drops every
              title in this rail, and a Sidekick row without its mark collapses
              to an empty square there. */}
          <SidebarNavigationRowContent
            activity={item.note ? `${item.note} · ${item.description}` : item.description}
            icon={<span className="workstream-context-sidekick-glyph">
              <AutomationGlyph id={item.id} {...(item.appearance ? { appearance: item.appearance } : {})} />
            </span>}
            title={item.name}
          />
        </SidebarRow>
        </ContextMenu.Trigger>
      </Tip>
      {item.recommended && <Tip className="sidekick-recommendation-tooltip" label="Recommended for every breakout in this thread. Agents can load it when relevant; it isn’t automatically loaded." side="right">
        <span className="sidekick-recommendation" role="img" aria-label="Recommended Sidekick" tabIndex={0}>
          <IconCarambola size={14} stroke={1.5} aria-hidden="true" />
        </span>
      </Tip>}
      {(item.managementPending || item.onRemove || item.onRemoveRecommendation || item.onRecommend) && <ContextMenu.Portal>
        <ContextMenu.Content className="menu-content">
          {item.managementPending && <ContextMenu.Label className="menu-label">Loading Sidekick options…</ContextMenu.Label>}
          {item.onRemove && <ContextMenu.Item className="menu-item" onSelect={item.onRemove}>{item.removeLabel ?? 'Remove from this breakout'}</ContextMenu.Item>}
          {item.onRemoveRecommendation && <ContextMenu.Item className="menu-item" onSelect={item.onRemoveRecommendation}>Remove thread recommendation</ContextMenu.Item>}
          {item.onRecommend && <ContextMenu.Item className="menu-item" onSelect={item.onRecommend}>Recommend for this thread</ContextMenu.Item>}
        </ContextMenu.Content>
      </ContextMenu.Portal>}
    </li></ContextMenu.Root>)}</ul>
  </section>;
}
