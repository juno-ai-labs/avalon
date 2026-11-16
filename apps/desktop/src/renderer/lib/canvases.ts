import { asWorkstreamId, type CanvasSidebarRow } from '@rally/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import { useOptionalCollaborationSession } from './collaboration-session';
import { SIDEBAR_LIST_QUERY_KEYS, useSocketOwnedList } from './sidebar-list-store';
import { ApiError, type RallyApi } from './api';
import { uuidV7 } from './telemetry';
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

/** Everyone in a Canvas now but the viewer, who knows they are there. */
export function othersPresent(row: Pick<CanvasSidebarRow, 'presentUserIds'>, currentUserId: string | undefined): string[] {
  return row.presentUserIds.filter((userId) => userId !== currentUserId);
}

/**
 * Open a Canvas immediately and create it in the background. A prompt is the Chat's first message,
 * sent by the server as the creator's (`POST /canvases`), so the Canvas opens
 * on a conversation already under way.
 *
 * One attempt series makes one Canvas. A call while one is in flight (a
 * double click) answers with that one rather than making a second, and a
 * retry of the same prompt after a failure sends the same `canvasId` and
 * `clientMessageId`, which the server answers as a replay
 * (`HostedCanvas.create`), so a request that landed but whose answer was lost
 * does not make a second Canvas. Success ends the series.
 *
 * `replace` opens the Canvas in place of the current route, for a route whose
 * only job was to start one: Back must not land there and start another.
 */
export function useCreateCanvas(): (prompt?: string, options?: { replace?: boolean }) => void {
  const api = useOptionalCollaborationSession()?.api;
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const creationKey = useCanvasCreationKey();
  const series = useRef<{ scope: readonly unknown[]; text: string; canvasId: ReturnType<typeof asWorkstreamId>; clientMessageId: string; inFlight: Promise<void> | null } | null>(null);
  return useCallback((prompt?: string, options?: { replace?: boolean }) => {
    const replace = options?.replace ?? false;
    const text = prompt?.trim() ?? '';
    const current = series.current?.scope === creationKey ? series.current : null;
    if (current?.inFlight) {
      if (location.pathname !== canvasRoute(current.canvasId)) void navigate(canvasRoute(current.canvasId), { replace });
      return;
    }
    const attempt = current?.text === text ? current
      : { scope: creationKey, text, canvasId: asWorkstreamId(uuidV7()), clientMessageId: crypto.randomUUID(), inFlight: null };
    series.current = attempt;
    const createdAt = new Date().toISOString();
    queryClient.setQueryDefaults(creationKey, { gcTime: Number.POSITIVE_INFINITY });
    const complete = (): void => {
      queryClient.setQueryData<Record<string, CanvasCreation>>(creationKey, (records) => {
        const next = { ...records };
        delete next[attempt.canvasId];
        return next;
      });
    };
    const retry = (editedPrompt = attempt.text): void => {
      if (attempt.inFlight) return;
      // A correction is a new message; an unchanged retry replays the same receipt.
      if (editedPrompt.trim() !== attempt.text) {
        attempt.text = editedPrompt.trim();
        attempt.clientMessageId = crypto.randomUUID();
      }
      const publish = (status: CanvasCreation['status'], error: Error | null = null): void => {
        queryClient.setQueryData<Record<string, CanvasCreation>>(creationKey, (records) => ({
          ...records, [attempt.canvasId]: { status, error, retry, complete, createdAt, prompt: attempt.text },
        }));
      };
      publish('creating');
      const request = api ? api.createCanvas({
        canvasId: attempt.canvasId,
        ...(attempt.text ? { prompt: { text: attempt.text, clientMessageId: attempt.clientMessageId } } : {}),
      }) : Promise.reject(new Error('Rally is not connected yet.'));
      attempt.inFlight = request.then(() => {
        publish('ready');
        if (series.current === attempt) series.current = null;
      }, (cause: unknown) => {
        publish('failed', cause instanceof Error ? cause : new Error('The Canvas could not be made.'));
      }).finally(() => { attempt.inFlight = null; });
    };
    retry();
    void navigate(canvasRoute(attempt.canvasId), { replace });
  }, [api, creationKey, location.pathname, navigate, queryClient]);
}

export interface CanvasCreation {
  status: 'creating' | 'failed' | 'ready';
  error: Error | null;
  retry: (prompt?: string) => void;
  complete: () => void;
  createdAt: string;
  prompt: string;
}

const NO_CREATIONS: Record<string, CanvasCreation> = {};

function useCanvasCreationKey(): readonly unknown[] {
  const session = useOptionalCollaborationSession()?.session;
  const userId = session?.user.id;
  const region = session?.workspace?.region;
  const workspaceId = session?.workspace?.id;
  return useMemo(() => ['canvas-creations', userId, region, workspaceId], [userId, region, workspaceId]);
}

/** Window-local recovery survives navigation until the first live snapshot. */
export function useCanvasCreations(): Record<string, CanvasCreation> {
  const queryKey = useCanvasCreationKey();
  return useQuery<Record<string, CanvasCreation>>({
    queryKey, enabled: false, gcTime: Number.POSITIVE_INFINITY,
  }).data ?? NO_CREATIONS;
}

export function useCanvasCreation(id: string): CanvasCreation | undefined {
  return useCanvasCreations()[id];
}

/**
 * Who a Canvas row or screen can name: the Organization's members and the
 * Sidekicks the socket keeps, each by id, for Canvas people and Sidekick menus.
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
