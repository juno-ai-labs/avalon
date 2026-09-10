import type { ConversationDisplay } from './text-search';

/**
 * Patch a conversation's indexed display from what its owner says now, and
 * confirm the owner still says it afterwards. Two deliveries for one
 * conversation can overlap across queue invocations: one reads the display
 * before an archive, the other archives and patches, and the first would then
 * patch the rows back. The re-read turns that into a retry of the stale
 * delivery, which re-reads and re-patches the current state; the newest state
 * always writes last. A conversation gone by the re-read has nothing to
 * converge to and is left to its own removal.
 */
export async function projectConversationDisplay(read: () => Promise<ConversationDisplay | null>,
  patch: (display: ConversationDisplay) => Promise<number>): Promise<number> {
  const display = await read();
  if (!display) return 0;
  const patched = await patch(display);
  const after = await read();
  if (after && (after.title !== display.title || after.archived !== display.archived)) {
    throw new Error('search_conversation_display_changed');
  }
  return patched;
}
