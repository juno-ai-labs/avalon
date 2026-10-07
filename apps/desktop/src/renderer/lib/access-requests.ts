import type { ConversationAccessRequestItem } from '@rally/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { RallyApi } from './api';

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
  return useQuery<readonly ConversationAccessRequestItem[]>({
    queryKey: accessRequestsQueryKey(workspaceId ?? ''),
    queryFn: async () => NONE,
    enabled: false,
  }).data ?? NONE;
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
      const previous = queryClient.getQueryData<readonly ConversationAccessRequestItem[]>(key);
      queryClient.setQueryData<readonly ConversationAccessRequestItem[]>(key, (current) => current?.filter((item) => item.id !== id));
      return { previous };
    },
    onError: (_error, _variables, context) => {
      if (context?.previous) queryClient.setQueryData(key, context.previous);
    },
  });
}
