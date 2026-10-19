import { createContext, useCallback, useContext, useState } from 'react';
import { useLocation } from 'react-router-dom';

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

/** An artifact a merge shared with a Channel, open in the Channel's panel. */
export function channelArtifactRoute(channelId: string, resourceId: string): string {
  return `${channelRoute(channelId)}/artifacts/${encodeURIComponent(resourceId)}`;
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
 * expanded: taking the whole window, with what it covers as its crumbs. A link
 * without it opens its pane beside the one it was followed from.
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
 * A navigation that opens a thread onto one of its artifacts: the thread's
 * Main pane opens that artifact's panel once it is on screen.
 */
export function openThreadResourceState(threadId: string, resourceId: string): {
  openExpanded: true; openResource: { threadId: string; resourceId: string };
} {
  return { ...OPEN_EXPANDED, openResource: { threadId, resourceId } };
}

/** The artifact a navigation asked a thread to open, or null when it asked for none. */
export function openResourceRequest(state: unknown): { threadId: string; resourceId: string } | null {
  if (typeof state !== 'object' || state === null || !('openResource' in state)) return null;
  const request = state.openResource;
  return typeof request === 'object' && request !== null
    && 'threadId' in request && typeof request.threadId === 'string'
    && 'resourceId' in request && typeof request.resourceId === 'string'
    ? { threadId: request.threadId, resourceId: request.resourceId }
    : null;
}

/**
 * A navigation that opens a Channel onto one of its messages. By default the
 * message was just posted (a merge), so the feed brings it into view once it
 * is the newest row. With `searchHistory` it is an older one (a source's
 * merge divider): the feed brings it into view wherever it is, paging back
 * until it is loaded.
 */
export function revealChannelMessageState(messageId: string, options: { searchHistory?: boolean } = {}): {
  revealMessageId: string; searchHistory?: true;
} {
  return { revealMessageId: messageId, ...(options.searchHistory ? { searchHistory: true as const } : {}) };
}

/** The Channel message a navigation asked to bring into view, or null when it asked for none. */
export function revealChannelMessageRequest(state: unknown): { messageId: string; searchHistory: boolean } | null {
  return typeof state === 'object' && state !== null && 'revealMessageId' in state && typeof state.revealMessageId === 'string'
    ? { messageId: state.revealMessageId, searchHistory: 'searchHistory' in state && state.searchHistory === true }
    : null;
}

/**
 * Whether the pane open on one level of the stack (a thread over its Channel,
 * a breakout over its thread) is expanded. Held for the pane it was asked on,
 * so it drops when that pane closes or another opens, which then opens beside,
 * unless the navigation that opened it asked for it expanded. A request counts
 * once per navigation, so one onto the pane already open expands it again
 * after a Collapse, and a pane closed and opened again under the same
 * navigation opens beside. A level passes `honorsRequest` false for a navigation
 * whose request is aimed at the level below it.
 */
export function usePaneExpansion(paneId: string | null, honorsRequest = true): {
  expanded: boolean;
  setExpanded: (expanded: boolean) => void;
} {
  const location = useLocation();
  const request = honorsRequest ? expandRequest(location) : null;
  const asked = request !== null && paneId !== null;
  const [expandedId, setExpandedId] = useState<string | null>(asked ? paneId : null);
  // The request a pane already took: one that closes and opens again under
  // the same navigation opens beside, as it would from anywhere else.
  const [consumed, setConsumed] = useState<string | null>(asked ? request : null);
  const [heldFor, setHeldFor] = useState({ paneId, request });
  if (heldFor.paneId !== paneId || heldFor.request !== request) {
    setHeldFor({ paneId, request });
    if (request !== null && paneId !== null && request !== consumed) {
      setExpandedId(paneId);
      setConsumed(request);
    } else if (heldFor.paneId !== paneId) setExpandedId(null);
  }
  const setExpanded = useCallback((expand: boolean): void => setExpandedId(expand ? paneId : null), [paneId]);
  return { expanded: paneId !== null && expandedId === paneId, setExpanded };
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
