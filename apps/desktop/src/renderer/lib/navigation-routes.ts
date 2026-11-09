import type { IconGroupAction } from '@rally/ui/components/icon-group';
import { IconArrowsDiagonal, IconArrowsDiagonalMinimize2 } from '@tabler/icons-react';
import { createElement, useCallback, useState } from 'react';
import { useLocation } from 'react-router-dom';

/**
 * The `location.state` a link passes to open a pane expanded: the right
 * panel taking the whole pane, with what it covers as its crumbs. A link
 * without it opens the panel beside its conversation.
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
 * A navigation that opens a conversation (a Canvas's Chat) onto one of its
 * artifacts: the conversation opens that artifact's panel once it is on screen,
 * expanded over the conversation unless `expanded` is false, which opens it
 * beside, as an artifact opened from the transcript does.
 */
export function openResourceState(conversationId: string, resourceId: string, { expanded = true }: { expanded?: boolean } = {}): {
  openExpanded?: true; openResource: { conversationId: string; resourceId: string };
} {
  return { ...(expanded ? OPEN_EXPANDED : {}), openResource: { conversationId, resourceId } };
}

/** The artifact a navigation asked a conversation to open, or null when it asked for none. */
export function openResourceRequest(state: unknown): { conversationId: string; resourceId: string } | null {
  if (typeof state !== 'object' || state === null || !('openResource' in state)) return null;
  const request = state.openResource;
  return typeof request === 'object' && request !== null
    && 'conversationId' in request && typeof request.conversationId === 'string'
    && 'resourceId' in request && typeof request.resourceId === 'string'
    ? { conversationId: request.conversationId, resourceId: request.resourceId }
    : null;
}

/**
 * Whether the right panel open over a conversation is expanded. Held for the
 * panel it was asked on, so it drops when that panel closes or another opens,
 * which then opens beside, unless the navigation that opened it asked for it
 * expanded. A request counts once per navigation, so one onto the panel
 * already open expands it again after a Collapse, and a panel closed and
 * opened again under the same navigation opens beside.
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
 * The header action that expands the panel over its conversation, or puts it
 * back: Expand while both are on screen, Collapse while it is expanded.
 */
export function expandToggle(expanded: boolean, beside: boolean, setExpanded: (expanded: boolean) => void): IconGroupAction[] | undefined {
  if (expanded) {
    // One key for both states, so the button a keyboard pressed keeps focus.
    return [{
      key: 'expand',
      label: 'Collapse',
      icon: createElement(IconArrowsDiagonalMinimize2, { 'aria-hidden': true, size: 16, stroke: 1.9 }),
      onSelect: () => setExpanded(false),
    }];
  }
  if (!beside) return undefined;
  return [{
    key: 'expand',
    label: 'Expand',
    icon: createElement(IconArrowsDiagonal, { 'aria-hidden': true, size: 16, stroke: 1.9 }),
    onSelect: () => setExpanded(true),
  }];
}
