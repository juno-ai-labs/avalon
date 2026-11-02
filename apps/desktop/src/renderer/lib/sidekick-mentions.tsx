import { createContext, useContext, useMemo, type PropsWithChildren } from 'react';

import { SIDEBAR_LIST_QUERY_KEYS, useSocketOwnedList } from './sidebar-list-store';
import type { AutomationSummary } from './types';

/**
 * What a Sidekick mention needs: the list offers it, the chip draws it. A
 * conversation's attachment carries only the name and description, so the
 * glyph falls back to the id-derived mark and the status is unknown.
 */
export type SidekickMentionTarget = Pick<AutomationSummary, 'id' | 'name' | 'description'>
  & Partial<Pick<AutomationSummary, 'appearance' | 'status'>>;

export interface SidekickMentionDirectory {
  /** The composer's mention list, in order. */
  readonly list: readonly SidekickMentionTarget[];
  /** Keyed by lower-case id, for the transcript's `sidekick://` chips. */
  readonly byId: ReadonlyMap<string, SidekickMentionTarget>;
}

const EMPTY: SidekickMentionDirectory = { list: [], byId: new Map() };

/**
 * One entry per id, first occurrence first. A later copy only fills what the
 * first lacked, which is how an attachment of an Organization-wide Sidekick
 * keeps the glyph its library row carries.
 */
export function sidekickMentionDirectory(sidekicks: readonly SidekickMentionTarget[]): SidekickMentionDirectory {
  if (sidekicks.length === 0) return EMPTY;
  const byId = new Map<string, SidekickMentionTarget>();
  for (const sidekick of sidekicks) {
    const key = sidekick.id.toLowerCase();
    const seen = byId.get(key);
    byId.set(key, seen ? { ...sidekick, ...seen, appearance: seen.appearance ?? sidekick.appearance } : sidekick);
  }
  return { list: [...byId.values()], byId };
}

/**
 * The Sidekicks a reader can name with `@` here, and whose `sidekick://`
 * links draw as chips. Empty outside a provider, which leaves the list
 * without a Sidekicks group and every such link as its label text.
 */
export const SidekickMentionContext = createContext<SidekickMentionDirectory>(EMPTY);

/**
 * The Organization-wide Sidekicks, provided once under the Organization
 * socket, which pushes them (the sidebar's `automations`). A personal
 * Sidekick is left out: it is one person's tool, so naming it is offered only
 * where a conversation has it attached (`SidekickMentionScope`).
 */
export function SidekickMentionProvider({ children }: PropsWithChildren): React.JSX.Element {
  const sidekicks = useSocketOwnedList<AutomationSummary>(SIDEBAR_LIST_QUERY_KEYS.automations).data;
  const directory = useMemo(
    () => sidekickMentionDirectory((sidekicks ?? []).filter((sidekick) => sidekick.scope === 'workspace')),
    [sidekicks],
  );
  return <SidekickMentionContext.Provider value={directory}>{children}</SidekickMentionContext.Provider>;
}

/**
 * Adds one conversation's own Sidekicks (those it owns and those attached to
 * it) ahead of the Organization's, for everything rendered inside it.
 */
export function SidekickMentionScope({ children, sidekicks }: PropsWithChildren<{
  sidekicks: readonly SidekickMentionTarget[];
}>): React.JSX.Element {
  const inherited = useContext(SidekickMentionContext);
  const directory = useMemo(
    () => sidekicks.length === 0 ? inherited : sidekickMentionDirectory([...sidekicks, ...inherited.list]),
    [inherited, sidekicks],
  );
  return <SidekickMentionContext.Provider value={directory}>{children}</SidekickMentionContext.Provider>;
}

export function useSidekickMentions(): SidekickMentionDirectory {
  return useContext(SidekickMentionContext);
}
