import { useQuery } from '@tanstack/react-query';
import type { SharedNavigationDirectory } from '@rally/contracts/scope-grants';
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

/** The Channels this person may open only through some of their conversations, never through Main. */
export function conversationScopedChannelIds(directory: SharedNavigationDirectory | undefined): ReadonlySet<string> {
  return new Set(directory?.workstreams.filter(mainOmitted).map((entry) => entry.parentId) ?? []);
}

/**
 * Read the shell's conversation directory without fetching it again. Outside
 * a collaboration session there is none, and the answer is undefined.
 */
export function useConversationDirectory(): SharedNavigationDirectory | undefined {
  const session = useOptionalCollaborationSession()?.session;
  return useQuery<SharedNavigationDirectory | undefined>({
    queryKey: conversationDirectoryQueryKey(session?.workspace?.id),
    queryFn: async () => undefined,
    enabled: false,
  }).data;
}
