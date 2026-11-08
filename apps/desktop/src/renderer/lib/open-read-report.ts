import { useMemo, useRef } from 'react';

/**
 * The one read report an open of a conversation owes even at an unchanged
 * cursor (`conversationReadAcknowledgement`'s `reportedThisOpen`). Keyed by the
 * conversation's address, so moving to another conversation and back is a new
 * open, while a reconnect, a refetch or a re-render of the same one is not.
 */
export function useOpenReadReport(address: string): { reported: () => boolean; markReported: () => void } {
  const reportedFor = useRef<string | null>(null);
  return useMemo(() => ({
    reported: () => reportedFor.current === address,
    markReported: () => { reportedFor.current = address; },
  }), [address]);
}
