import type { ConversationAccessRequestItem } from '@rally/contracts';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';

import type { RallyApi } from './api';

export const CONVERSATION_ACCESS_PREVIEW_QUERY_KEY = ['conversation-access-preview'] as const;

/** A pending first fetch otherwise reuses its pre-event promise on invalidation. */
export async function refreshConversationAccessPreviews(queryClient: QueryClient): Promise<void> {
  await queryClient.cancelQueries({ queryKey: CONVERSATION_ACCESS_PREVIEW_QUERY_KEY });
  await queryClient.invalidateQueries({ queryKey: CONVERSATION_ACCESS_PREVIEW_QUERY_KEY });
}

/**
 * The access requests waiting on this person, per Organization. Written only
 * by the workspace socket (the subscribe answer and `workspace_access_requests`),
 * so reading it never fetches. `docs/channel-access-requests.md`.
 */
export function accessRequestsQueryKey(workspaceId: string): readonly unknown[] {
  return ['access-requests', workspaceId];
}

const NONE: readonly ConversationAccessRequestItem[] = [];

export function useAccessRequests(workspaceId: string | null | undefined): readonly ConversationAccessRequestItem[] {
  return useAccessRequestList(workspaceId).requests;
}

/** The list, and whether the socket has sent it yet: before it has, an empty list means "not known", not "none". */
export function useAccessRequestList(workspaceId: string | null | undefined): {
  requests: readonly ConversationAccessRequestItem[]; loaded: boolean;
} {
  const data = useQuery<readonly ConversationAccessRequestItem[]>({
    queryKey: accessRequestsQueryKey(workspaceId ?? ''),
    queryFn: async () => NONE,
    enabled: false,
  }).data;
  return { requests: data ?? NONE, loaded: data !== undefined };
}

export type AccessRequestDecisionApi = Pick<RallyApi, 'decideConversationAccess'>;

/**
 * Approve or decline one request. The row leaves the list at once and comes
 * back if the server refuses; the socket's next list is the authority either way.
 */
export function useDecideAccessRequest(api: AccessRequestDecisionApi | null, workspaceId: string | null | undefined) {
  const queryClient = useQueryClient();
  const key = accessRequestsQueryKey(workspaceId ?? '');
  return useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: 'approve' | 'decline' }) => {
      if (!api) throw new Error('Rally is not connected.');
      return api.decideConversationAccess(id, decision);
    },
    onMutate: ({ id }) => {
      const removed = queryClient.getQueryData<readonly ConversationAccessRequestItem[]>(key)?.find((item) => item.id === id);
      queryClient.setQueryData<readonly ConversationAccessRequestItem[]>(key, (current) => current?.filter((item) => item.id !== id));
      return { removed };
    },
    // Only the refused request comes back: restoring the whole list as it was
    // would also bring back one answered elsewhere since.
    onError: (_error, _variables, context) => {
      const removed = context?.removed;
      if (!removed) return;
      queryClient.setQueryData<readonly ConversationAccessRequestItem[]>(key, (current = []) =>
        current.some((item) => item.id === removed.id) ? current : [removed, ...current]);
    },
  });
}
