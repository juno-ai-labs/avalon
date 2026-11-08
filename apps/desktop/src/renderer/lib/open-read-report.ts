import { useMemo, useRef } from 'react';

/**
 * The one read report an open of a conversation owes even at an unchanged
 * cursor (`conversationReadAcknowledgement`'s `reportedThisOpen`), and owes
 * again each time its turns change while it is open. Keyed by the
 * conversation's address, so moving to another conversation and back is a new
 * open, while a reconnect, a refetch or a re-render of the same one is not;
 * and by `turns` (`transcriptTurnsKey`), so a new or revised turn is a new
 * report. Activity clears a finished run's row on a report made after the row
 * was written, and the run's row in the shared conversation is updated in
 * place: it moves no cursor, so without this a person watching their run
 * finish was left with an unseen row (`docs/activity.md`).
 */
export function useOpenReadReport(address: string, turns = ''): { reported: () => boolean; markReported: () => void } {
  const reportedFor = useRef<string | null>(null);
  return useMemo(() => {
    const key = `${address}|${turns}`;
    return {
      reported: () => reportedFor.current === key,
      markReported: () => { reportedFor.current = key; },
    };
  }, [address, turns]);
}
