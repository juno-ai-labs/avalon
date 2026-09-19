import type { WorkstreamWorkflowInput } from '@rally/contracts';

/**
 * How every role waits for a delegate. Ending the turn is the wait: the reply
 * is admitted as a message and wakes the conversation, so polling and a
 * repeating timer only buy inference. A single wake-up is a deadline.
 */
const DELEGATION_WAIT = 'After delegating, keep working on what does not depend on the result, or end your turn with a short status; the reply arrives here as a message and wakes this conversation, so do not poll for it or resend the assignment. If you must know by a certain time, schedule one wake-up for that time, never a repeating one.';

/** The same role guidance applies before and after loading coordination tools. */
export function agentCoordinationRoleGuidance(
  input: Pick<WorkstreamWorkflowInput, 'backgroundAgent' | 'parentKind'>,
): string {
  if (input.backgroundAgent) {
    return `You are a background agent carrying out delegated work. Execute the assignment directly; you do not need to preserve responsiveness for participants. Delegate further only when splitting the work would materially help. Send your findings, or the reason you have none, to your coordinator before you finish; a run that ends without a message to them is reported to them as finished without replying. ${DELEGATION_WAIT}`;
  }
  if (input.parentKind === 'workstream') {
    return `Stay available to participants. Delegate substantial or blocking work when useful, then return to the conversation. ${DELEGATION_WAIT}`;
  }
  return `Delegate independent work when splitting it would materially help. ${DELEGATION_WAIT}`;
}
