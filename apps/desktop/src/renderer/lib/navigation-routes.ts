import { createContext, useContext } from 'react';

import type { TitlePillLevel } from '@rally/ui/components/title-pill';

/**
 * Where the redesigned navigation goes. A **Channel** is a stored Space and a
 * **thread** a stored Channel (`docs/PRDs/2026-10-10_channels-threads-navigation/prd.md`);
 * the routes use the product words, the ids are the storage ones.
 *
 * A thread opened from a Channel lives under it, so the Channel stays on screen
 * to its left. A thread opened from anywhere else (the Threads tab, Activity, a
 * deep link) is still placed under a Channel it sits in when it has one, so the
 * Channel is always one step back; `/workstreams/:id` is left for a thread with
 * no Channel this person may see.
 */
export function channelRoute(channelId: string): string {
  return `/channels/${encodeURIComponent(channelId)}`;
}

export function threadRoute(threadId: string, channelId: string | null, substreamId?: string | null): string {
  const base = channelId === null
    ? `/workstreams/${encodeURIComponent(threadId)}`
    : `${channelRoute(channelId)}/threads/${encodeURIComponent(threadId)}`;
  return substreamId && substreamId !== '0' ? `${base}?substream=${encodeURIComponent(substreamId)}` : base;
}

/**
 * The Channel a thread is opened under: the one asked for when it holds the
 * thread, else the first one it sits in, else none.
 */
export function homeChannelId(spaceIds: readonly string[], preferred?: string | null): string | null {
  if (preferred && spaceIds.includes(preferred)) return preferred;
  return spaceIds[0] ?? null;
}

/**
 * The `location.state` a link passes to open its thread, or its breakout,
 * expanded: taking the whole window, with what it covers as its crumbs. The
 * sidebar opens everything this way; a link inside a pane does not, so what it
 * opens comes up beside it.
 */
export const OPEN_EXPANDED = { openExpanded: true } as const;

/**
 * The navigation that asked to open expanded, named by its location key so
 * each such open counts once, even one to the pane already open; null when it
 * did not ask.
 */
export function expandRequest(location: { key: string; state: unknown }): string | null {
  const { state } = location;
  return typeof state === 'object' && state !== null && 'openExpanded' in state && state.openExpanded === true
    ? location.key
    : null;
}

/**
 * What a thread pane needs from the Channel beside it: the Channel's pill, to
 * draw as the first breadcrumb once the thread has shifted into the Channel's
 * place, and a way to say when it has. Null outside a Channel route.
 */
export interface ChannelPaneContext {
  channelId: string;
  /** The Channel's pill as a breadcrumb; selecting it closes what the thread opened. */
  crumb: TitlePillLevel;
  /** Whether the Channel is off screen, so the thread's left header carries it. */
  shifted: boolean;
  /** The thread reports whether it is using two panes (a breakout or a panel). */
  setThreadUsesTwoPanes: (twoPanes: boolean) => void;
  /** Whether the reader expanded the thread to take the whole window. */
  expanded: boolean;
  /** Expand the thread over the Channel, or put it back beside it. */
  setExpanded: (expanded: boolean) => void;
}

export const ChannelPaneContextValue = createContext<ChannelPaneContext | null>(null);

export function useChannelPane(): ChannelPaneContext | null {
  return useContext(ChannelPaneContextValue);
}
