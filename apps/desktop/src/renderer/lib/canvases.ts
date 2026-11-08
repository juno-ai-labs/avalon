import type { CanvasEditor, CanvasSidebarRow } from '@rally/contracts';
import { useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';

import { useOptionalCollaborationSession } from './collaboration-session';
import { SIDEBAR_LIST_QUERY_KEYS, useSocketOwnedList } from './sidebar-list-store';
import type { RallyApi } from './api';
import type { AutomationSummary, WorkspaceMember } from './types';
import { useWorkspaceMembers } from './workspace-members';

/*
 * What the Canvas screens share: the list the workspace socket keeps, the
 * routes, and the words a row says about a Canvas. `docs/canvases.md` owns the
 * model; the list is `workspace_canvas_list`, applied by `WorkspaceSocketProvider`.
 */

export const CANVASES_ROUTE = '/canvases';

export function canvasRoute(canvasId: string): string {
  return `${CANVASES_ROUTE}/${encodeURIComponent(canvasId)}`;
}

/** A Canvas opened on one turn of its Chat, as a search result for a message opens it. */
export function canvasTurnRoute(canvasId: string, turnId: string, transcriptSequence: number): string {
  return `${canvasRoute(canvasId)}?turn=${encodeURIComponent(turnId)}&sequence=${transcriptSequence}`;
}

/** The Canvas a route has open, or null; a malformed segment is returned raw, as React Router decodes a param. */
export function openCanvasId(pathname: string): string | null {
  const id = /^\/canvases\/([^/]+)$/.exec(pathname)?.[1];
  if (id === undefined) return null;
  try { return decodeURIComponent(id); } catch { return id; }
}

/** The Canvas as `GET /canvases/:id` answers it for this reader. */
export function canvasDetailQueryKey(canvasId: string): readonly unknown[] {
  return ['canvas', canvasId];
}

/** This viewer's Canvases, most recently active first; `undefined` until the socket (or the device cache) has said. */
export function useCanvasList(): CanvasSidebarRow[] | undefined {
  return useSocketOwnedList<CanvasSidebarRow[]>(SIDEBAR_LIST_QUERY_KEYS.canvases).data;
}

/** "Maya", "Maya and Theo", "Maya, Theo and Priya". */
export function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/** A person's first name as a row says it, or "you" for the viewer. */
export function personName(
  userId: string,
  membersById: ReadonlyMap<string, Pick<WorkspaceMember, 'name'>>,
  currentUserId: string | undefined,
): string {
  if (userId === currentUserId) return 'you';
  const name = membersById.get(userId)?.name.trim();
  return name ? name.split(/\s+/u)[0]! : 'Someone';
}

/** Everyone in a Canvas now but the viewer, who knows they are there. */
export function othersPresent(row: Pick<CanvasSidebarRow, 'presentUserIds'>, currentUserId: string | undefined): string[] {
  return row.presentUserIds.filter((userId) => userId !== currentUserId);
}

function editorName(
  editor: CanvasEditor,
  membersById: ReadonlyMap<string, Pick<WorkspaceMember, 'name'>>,
  sidekicksById: ReadonlyMap<string, Pick<AutomationSummary, 'name'>>,
  currentUserId: string | undefined,
): string {
  switch (editor.kind) {
    case 'rally': return 'Rally';
    case 'sidekick': return (editor.id ? sidekicksById.get(editor.id)?.name : undefined) ?? 'a Sidekick';
    case 'person': return editor.id ? personName(editor.id, membersById, currentUserId) : 'Someone';
  }
}

/**
 * A Canvas row's second line: who is in it now, when anyone else is, and
 * otherwise who last changed it — or, for one nobody has changed, who made it.
 */
export function canvasRowDetail(
  row: CanvasSidebarRow,
  membersById: ReadonlyMap<string, Pick<WorkspaceMember, 'name'>>,
  sidekicksById: ReadonlyMap<string, Pick<AutomationSummary, 'name'>>,
  currentUserId: string | undefined,
): string {
  const present = othersPresent(row, currentUserId);
  if (present.length > 0) {
    const names = present.map((userId) => personName(userId, membersById, currentUserId));
    return `${joinNames(names)} ${present.length === 1 ? 'is' : 'are'} here`;
  }
  if (row.lastEditor) return `Edited by ${editorName(row.lastEditor, membersById, sidekicksById, currentUserId)}`;
  if (row.writerSidekickId) return `Made by ${sidekicksById.get(row.writerSidekickId)?.name ?? 'a Sidekick'}`;
  return `Made by ${personName(row.createdByUserId, membersById, currentUserId)}`;
}

/**
 * Make a Canvas and open it. With a prompt, it is the Chat's first message,
 * sent by the server as the creator's (`POST /canvases`), so the Canvas opens
 * on a conversation already under way.
 */
export function useCreateCanvas(): (prompt?: string) => Promise<void> {
  const api = useOptionalCollaborationSession()?.api;
  const navigate = useNavigate();
  return useCallback(async (prompt?: string) => {
    if (!api) throw new Error('Rally is not connected yet.');
    const text = prompt?.trim();
    const created = await api.createCanvas(text ? { prompt: { text, clientMessageId: crypto.randomUUID() } } : {});
    void navigate(canvasRoute(created.canvasId));
  }, [api, navigate]);
}

/**
 * Who a Canvas row or screen can name: the Organization's members and the
 * Sidekicks the socket keeps, each by id, for `canvasRowDetail` and friends.
 */
export function useCanvasNameSources(api: Pick<RallyApi, 'getWorkspaceMembers'> | null | undefined): {
  members: WorkspaceMember[] | undefined;
  membersById: ReadonlyMap<string, WorkspaceMember>;
  sidekicksById: ReadonlyMap<string, AutomationSummary>;
} {
  const members = useWorkspaceMembers(api).data;
  const sidekicks = useSocketOwnedList<AutomationSummary[]>(SIDEBAR_LIST_QUERY_KEYS.automations).data;
  const membersById = useMemo(() => new Map((members ?? []).map((member) => [member.id, member])), [members]);
  const sidekicksById = useMemo(() => new Map((sidekicks ?? []).map((sidekick) => [sidekick.id, sidekick])), [sidekicks]);
  return { members, membersById, sidekicksById };
}
