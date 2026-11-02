import { createContext, useContext, useMemo, type PropsWithChildren } from 'react';

import { SIDEBAR_LIST_QUERY_KEYS, useSocketOwnedList } from './sidebar-list-store';
import type { AutomationSummary } from './types';

/** What a Sidekick mention needs: the list offers it, the chip draws it. */
export type SidekickMentionTarget = Pick<AutomationSummary, 'id' | 'name' | 'description' | 'appearance' | 'status'>;

export interface SidekickMentionDirectory {
  /** In the sidebar's order, for the composer's mention list. */
  readonly list: readonly SidekickMentionTarget[];
  /** Keyed by lower-case id, for the transcript's `sidekick://` chips. */
  readonly byId: ReadonlyMap<string, SidekickMentionTarget>;
}

const EMPTY: SidekickMentionDirectory = { list: [], byId: new Map() };

export function sidekickMentionDirectory(sidekicks: readonly SidekickMentionTarget[]): SidekickMentionDirectory {
  if (sidekicks.length === 0) return EMPTY;
  return { list: sidekicks, byId: new Map(sidekicks.map((sidekick) => [sidekick.id.toLowerCase(), sidekick])) };
}

/**
 * The Sidekicks this reader can see, for naming one with `@` and drawing the
 * chip a `sidekick://` link becomes. Empty outside a provider, which leaves
 * the list without a Sidekicks group and every such link as its label text.
 */
export const SidekickMentionContext = createContext<SidekickMentionDirectory>(EMPTY);

/**
 * Provided once under the Organization socket, because that socket is what
 * pushes the list (the sidebar's `automations`), so every composer and feed in
 * the window reads the same rows without each host fetching or passing them.
 */
export function SidekickMentionProvider({ children }: PropsWithChildren): React.JSX.Element {
  const sidekicks = useSocketOwnedList<AutomationSummary>(SIDEBAR_LIST_QUERY_KEYS.automations).data;
  const directory = useMemo(() => sidekickMentionDirectory(sidekicks ?? []), [sidekicks]);
  return <SidekickMentionContext.Provider value={directory}>{children}</SidekickMentionContext.Provider>;
}

export function useSidekickMentions(): SidekickMentionDirectory {
  return useContext(SidekickMentionContext);
}
