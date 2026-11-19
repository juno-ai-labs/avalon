import type { ClientSession } from '@rally/contracts/client-session';
import type { Region } from '@rally/contracts/regions';
import { QueryClientProvider, useQuery, type UseQueryResult } from '@tanstack/react-query';
import { useState, type PropsWithChildren } from 'react';

import { SpeechPlaybackProvider } from '../components/speech-playback';
import type { RallyApi } from './api';
import { useAppSession } from './app-session';
import { CollaborationSessionProvider, useCollaborationSession } from './collaboration-session';
import { localCacheScope } from './local-cache';
import { LocalCacheScopeProvider } from './local-cache-scope';
import { createQueryClient } from './query-client';
import { SidekickMentionProvider } from './sidekick-mentions';
import { WorkspaceSocketAbsent } from './workspace-socket';

/*
 * One screen of another of this person's Organizations, drawn inside the one
 * in front without switching to it (`docs/canvas-share-federation.md`). The
 * shell, its sidebar and its Organization socket stay where they are; only
 * what this wraps talks to the other Organization, with that Organization's
 * own credential. Today it holds a Canvas shared with the person as a guest
 * there; nothing in it is specific to Canvases.
 */

/** An Organization other than the active one, named the way its links name it. */
export interface OrganizationTarget {
  region: Region;
  workspaceId: string;
}

/** A client and session for one Organization, handed out without making it active. */
export interface OrganizationSession {
  api: RallyApi;
  session: ClientSession;
}

/** Where another Organization's Canvas opens inside this shell. */
export function organizationCanvasRoute(target: OrganizationTarget, canvasId: string): string {
  return `/organizations/${encodeURIComponent(target.region)}/${encodeURIComponent(target.workspaceId)}/canvases/${encodeURIComponent(canvasId)}`;
}

export const ORGANIZATION_CANVAS_ROUTE = '/organizations/:region/:workspaceId/canvases/:id';

/**
 * The other Organization's client, made once per Organization and kept for the
 * shell's lifetime: reopening one of its Canvases costs nothing more. Keyed by
 * the person too, so another account on the same device never reuses it.
 */
export function useOrganizationSession(target: OrganizationTarget | null): UseQueryResult<OrganizationSession> {
  const { openOrganizationSession, session } = useAppSession();
  return useQuery({
    queryKey: ['organization-session', session?.user.id ?? null, target?.region ?? null, target?.workspaceId ?? null],
    queryFn: () => openOrganizationSession(target!),
    enabled: target !== null && session !== null,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
}

/**
 * Re-roots everything a conversation screen reads for one other Organization:
 * the collaboration session (its client and its guest or member answer), a
 * query cache of its own, so no list or detail of the active Organization is
 * read or written for it, its own local-cache scope, and no Organization
 * socket, since the one this shell holds is the active Organization's.
 * Starting a connection stays with the active Organization's own screens.
 */
export function OrganizationScope({ children, organization }: PropsWithChildren<{ organization: OrganizationSession }>): React.JSX.Element {
  const { host } = useCollaborationSession();
  const [queryClient] = useState(createQueryClient);
  const { api, session } = organization;
  const workspace = session.workspace!;
  return <QueryClientProvider client={queryClient}>
    <CollaborationSessionProvider api={api} host={host} session={session}>
      <LocalCacheScopeProvider scope={localCacheScope(session.user.id, workspace.region, workspace.id, workspace.accessClass ?? 'member')}>
        <WorkspaceSocketAbsent>
          <SidekickMentionProvider>
            <SpeechPlaybackProvider api={api}>{children}</SpeechPlaybackProvider>
          </SidekickMentionProvider>
        </WorkspaceSocketAbsent>
      </LocalCacheScopeProvider>
    </CollaborationSessionProvider>
  </QueryClientProvider>;
}
