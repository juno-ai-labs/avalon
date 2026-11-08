import type { CanvasEditor, CanvasSidebarRow } from '@rally/contracts';
import { useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';

import { useOptionalCollaborationSession } from './collaboration-session';
import { SIDEBAR_LIST_QUERY_KEYS, useSocketOwnedList } from './sidebar-list-store';
import { ApiError, type RallyApi } from './api';
import { sidekickRunSearch } from './sidekick-status';
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

/**
 * A Canvas opened onto one of its artifacts. Every host and every link lands
 * here the same way (`?artifact=`); the Canvas screen turns it into the route
 * state the artifact rail opens from.
 */
export function canvasArtifactRoute(canvasId: string, artifactId: string): string {
  return `${canvasRoute(canvasId)}?${new URLSearchParams({ artifact: artifactId })}`;
}

/** A Canvas opened on one turn of its Chat, as a search result for a message opens it. */
export function canvasTurnRoute(canvasId: string, turnId: string, transcriptSequence: number): string {
  return `${canvasRoute(canvasId)}?turn=${encodeURIComponent(turnId)}&sequence=${transcriptSequence}`;
}

/**
 * The route a link to a Canvas opens, on every host and from every entry (a
 * deep link, a push, a canonical link): onto its artifact (`?artifact=`), at
 * one message of its Chat (`?turn=&sequence=`, which the Canvas screen
 * scrolls to, as for a search result), or the Canvas itself.
 */
export function canvasLinkRoute(target: { canvasId: string; artifactId?: string; turnId?: string; sequence?: number }): string {
  if (target.artifactId) return canvasArtifactRoute(target.canvasId, target.artifactId);
  if (target.turnId !== undefined && target.sequence !== undefined) return canvasTurnRoute(target.canvasId, target.turnId, target.sequence);
  return canvasRoute(target.canvasId);
}

/** The Canvas a route has open, or null; a malformed segment is returned raw, as React Router decodes a param. */
export function openCanvasId(pathname: string): string | null {
  const id = /^\/canvases\/([^/]+)$/.exec(pathname)?.[1];
  if (id === undefined) return null;
  try { return decodeURIComponent(id); } catch { return id; }
}

/**
 * Route state that opens a Canvas with its title already being renamed, which
 * is how the sidebar row's Rename… hands the edit to the pill it happens in.
 */
export const RENAME_CANVAS_STATE = { renameCanvas: true } as const;

/** Route state a sidebar row's Share… opens a Canvas with, so its Share panel opens there. */
export const SHARE_CANVAS_STATE = { shareCanvas: true } as const;

export function canvasShareRequested(state: unknown): boolean {
  return typeof state === 'object' && state !== null && (state as { shareCanvas?: unknown }).shareCanvas === true;
}

export function canvasRenameRequested(state: unknown): boolean {
  return typeof state === 'object' && state !== null && (state as { renameCanvas?: unknown }).renameCanvas === true;
}

/**
 * What a refused retitle says in the pill. The server names the issue
 * (`canvas_rename_invalid:title:<issue>`); the words for the two a person
 * can type are here, and anything else is the server's own message.
 */
export function canvasRenameRefusal(error: Error): string {
  const issue = error instanceof ApiError && error.code?.startsWith('canvas_rename_invalid:title:')
    ? error.code.slice('canvas_rename_invalid:title:'.length) : null;
  if (issue === 'too_small') return 'A Canvas needs a title';
  if (issue === 'too_big') return 'That title is too long';
  return error.message;
}

/**
 * What a refused Approve or Deny says. The two refusals a decider can meet
 * in the ordinary course are worded here: another decider answered first,
 * or this person no longer manages the Canvas. Anything else is the server's
 * own message.
 */
export function canvasAccessDecisionRefusal(error: Error): string {
  const code = error instanceof ApiError ? error.code : undefined;
  if (code === 'canvas_access_request_settled') return 'Someone already answered this request.';
  if (code === 'canvas_access_decision_not_manager') return 'Only the Canvas’s creator and the Organization’s administrators can answer requests to open it.';
  return error.message;
}

/**
 * Whether Rally is still choosing this Canvas's name from its opening message.
 * An older server sends no `titleStatus`, which is settled.
 */
export function canvasNaming(canvas: { titleStatus?: 'naming' | 'settled' | undefined } | undefined): boolean {
  return canvas?.titleStatus === 'naming';
}

/** The Canvas as `GET /canvases/:id` answers it for this reader. */
export function canvasDetailQueryKey(canvasId: string): readonly unknown[] {
  return ['canvas', canvasId];
}

/**
 * Whether a Canvas that did not open may be asked into, as `GET
 * /canvases/:id/access` answers it. Outside the detail's key, so refetching
 * the detail on a grant does not ask this again.
 */
export function canvasAccessQueryKey(canvasId: string): readonly unknown[] {
  return ['canvas-access', canvasId];
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
 * The home card's line for a Canvas a Sidekick run last wrote: "<Sidekick> ·
 * run #N", opening the Sidekick's conversation at that run. Null while
 * anyone else is in it (who is here comes first, as `canvasRowDetail` says)
 * and when its newest version is no run's. The Sidekick's name is the live
 * one when the socket's Sidekick list has it, the row's otherwise.
 */
export function canvasWrittenByRun(
  row: Pick<CanvasSidebarRow, 'lastWrittenBy' | 'presentUserIds'>,
  sidekicksById: ReadonlyMap<string, Pick<AutomationSummary, 'name'>>,
  currentUserId: string | undefined,
): { label: string; to: string } | null {
  const run = row.lastWrittenBy;
  if (!run || othersPresent(row, currentUserId).length > 0) return null;
  const name = sidekicksById.get(run.sidekickId)?.name ?? run.sidekickName;
  return {
    label: `${name} · run #${run.runNumber}`,
    to: `/sidekicks/${encodeURIComponent(run.sidekickId)}${sidekickRunSearch(run.runId)}`,
  };
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
