import { describe, expect, it, vi } from 'vitest';
import { projectConversationDisplay } from '../src/services/search-conversation-display';
import type { ConversationDisplay } from '../src/services/text-search';

describe('conversation display projection', () => {
  it('lets the newest owner state win when two deliveries overlap', async () => {
    // Deliveries A and B share one conversation. A reads before the archive, B reads after and patches first.
    let current: ConversationDisplay = { title: 'Planning', archived: false };
    const index: ConversationDisplay[] = [];
    const patch = vi.fn(async (display: ConversationDisplay) => { index.push(display); return 1; });
    let releaseA = () => {};
    const gateA = new Promise<void>((resolve) => { releaseA = resolve; });
    const readA = vi.fn(async () => { const seen = current; await gateA; return seen; });
    const readB = vi.fn(async () => current);
    const a = projectConversationDisplay(readA, patch);
    await vi.waitFor(() => expect(readA).toHaveBeenCalledTimes(1));
    current = { title: 'Planning', archived: true };
    await projectConversationDisplay(readB, patch);
    expect(index.at(-1)).toEqual({ title: 'Planning', archived: true });
    releaseA();
    // A patched the stale display; its re-read notices and hands the message back for retry.
    await expect(a).rejects.toThrow('search_conversation_display_changed');
    expect(index.at(-1)).toEqual({ title: 'Planning', archived: false });
    expect(await projectConversationDisplay(readB, patch)).toBe(1);
    expect(index.at(-1)).toEqual({ title: 'Planning', archived: true });
  });

  it('patches nothing for a conversation that no longer answers, before or after', async () => {
    const patch = vi.fn(async () => 1);
    expect(await projectConversationDisplay(async () => null, patch)).toBe(0);
    expect(patch).not.toHaveBeenCalled();
    const reads = [{ title: 'Gone soon', archived: false }, null];
    expect(await projectConversationDisplay(async () => reads.shift() ?? null, patch)).toBe(1);
  });
});
