import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { SharedNavigationDirectory } from '@rally/contracts/scope-grants';
import type { WorkstreamSummary } from './types';
import { useOptionalCollaborationSession } from './collaboration-session';

type ConversationDirectoryEntry = SharedNavigationDirectory['workstreams'][number];

/**
 * The conversation directory: every Channel this person can read some
 * conversation of without reaching it through the member directory — a guest's
 * grants, or a member's breakouts in a Channel they cannot otherwise see.
 *
 * The shell fetches it; everything else reads the same cache entry.
 */
export function conversationDirectoryQueryKey(workspaceId: string | undefined): readonly unknown[] {
  return ['shared-navigation', workspaceId];
}

/** Whether this entry leaves Main out, so its Channel opens only through the conversations it lists. */
export function mainOmitted(entry: ConversationDirectoryEntry): boolean {
  return !entry.conversations.some((conversation) => conversation.substreamId === '0');
}

/**
 * Whether this Channel's Main is this person's to open, by the same rule for a
 * member and a guest (`docs/listing-rules.md`): not when their row says Main is
 * withheld or the conversation directory leaves it out, and yes once either has
 * spoken and neither says so. `undefined` until then. Callers dial Main unless
 * the answer is `false`: a dial the server refuses costs one request and drops
 * only Main's own cached entry.
 */
export function mainReachable(
  row: Pick<WorkstreamSummary, 'mainWithheld'> | undefined,
  directory: SharedNavigationDirectory | undefined,
  parentId: string,
): boolean | undefined {
  if (row?.mainWithheld) return false;
  const entry = directory?.workstreams.find((item) => item.parentId === parentId);
  if (entry && mainOmitted(entry)) return false;
  return row !== undefined || directory !== undefined ? true : undefined;
}

/**
 * Read the shell's conversation directory without fetching it again. Outside
 * a collaboration session there is none, and the answer is undefined.
 */
export function useConversationDirectory(): SharedNavigationDirectory | undefined {
  return useConversationDirectoryQuery().data;
}

/** The same read with its state, for a screen that must say when the shell's fetch failed. */
export function useConversationDirectoryQuery(): UseQueryResult<SharedNavigationDirectory | undefined> {
  const session = useOptionalCollaborationSession()?.session;
  return useQuery<SharedNavigationDirectory | undefined>({
    queryKey: conversationDirectoryQueryKey(session?.workspace?.id),
    queryFn: async () => undefined,
    enabled: false,
  });
}
