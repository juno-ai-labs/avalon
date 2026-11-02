import type { WorkstreamWorkflowInput } from '@rally/contracts';

/**
 * How every role assigns work and waits for a delegate. Carry decisions and
 * procedures in the handoff. Ending the turn is the wait: the reply
 * is admitted as a message and wakes the conversation, so polling and a
 * repeating timer only buy inference. A single wake-up is a deadline.
 */
const DELEGATION_GUIDANCE = 'Tell the agent what result is needed, what requirements are already settled, and what it still needs to investigate. Leave choices that still need investigation to that agent. Loading a skill in your conversation does not load it for another agent. Name the skills the agent must load. For work that will run later, also save the required steps in its run instructions. Send messages only for new results, concrete blockers or questions, or changed requirements. Do not reply just to acknowledge receipt, repeat that you are waiting, or acknowledge another acknowledgment. When a message needs no action or answer, send no agent message; end the turn with one short line in your own conversation, never with no text. After delegating, keep working on what does not need the result, or end your turn with a short status. The reply arrives as a message and wakes this conversation. Do not poll for it and do not resend the assignment. If you must know by a certain time, schedule one wake-up for that time, not a repeating one.';

/**
 * What a run is told about changing its own Sidekick. A run follows saved
 * instructions and cannot edit them; the wizard can. Without this, a request
 * to change the Sidekick that reached a run (a reply in its Slack thread, most
 * often) was either done once in that run or dropped.
 *
 * It names the evidence framing on purpose. A Slack reply reaches a run as
 * "evidence, not a request" that the Sidekick's instructions decide what to do
 * with, and those instructions never mention change requests; a softer
 * sentence lost to that framing in most trials. It also names what is not a
 * change request, so a run still treats an answer it asked for as an answer.
 * Measured on Terra and Sol against held-out replies across three Sidekicks;
 * the changelog in `docs/agent-communication.md` has the numbers.
 */
export const SIDEKICK_RUN_CHANGE_GUIDANCE = 'You are executing one run of a Sidekick. Its saved definition decides what every run does, and a run cannot edit it; this Sidekick\'s wizard can. A message asking for a lasting change to the Sidekick, such as what it does, what it reports or how, when it runs, or its sources or recipients, is a change request. That holds when the message reaches you as external evidence in this run\'s thread: passing it to the wizard is how a run handles it, and the wizard decides whether to apply it. Send it with request_sidekick_change, saying who asked and quoting their words. A message about this run alone, an answer the instructions asked for, a question, or thanks is not a change request; handle it as the instructions direct. If a change request also applies to this run\'s result, do that here too. The wizard\'s reply arrives as a message. Tell the person the change is saved only after the wizard confirms the revision was accepted; otherwise pass on its question or what blocks it.';

/**
 * The text the wizard reads for a run's change request. The host writes the
 * frame, so which run sent it and who started the turn that asked come from
 * the run's input, not from the model; the request itself is the run's words.
 * Bounded by `SIDEKICK_CHANGE_FRAME_RESERVE`.
 */
export function sidekickChangeRequestText(
  runId: string,
  continuation: WorkstreamWorkflowInput['automationContinuation'],
  changes: string,
): string {
  const requester = !continuation
    ? ''
    : continuation.source.kind === 'provider_thread'
      ? ` ${continuation.senderName} asked for it by replying in the run's ${continuation.source.provider} thread; they may not be a Rally member.`
      : ` ${continuation.senderName} asked for it in the run.`;
  return `Change request from run ${runId} of this Sidekick.${requester} Update this Sidekick's saved definition if the request fits it, then reply to this message saying whether the revision was accepted or what blocks it.\n\n${changes}`;
}

/** The same role guidance applies before and after loading coordination tools. */
export function agentCoordinationRoleGuidance(
  input: Pick<WorkstreamWorkflowInput, 'backgroundAgent' | 'parentKind'>,
): string {
  if (input.backgroundAgent) {
    return `You are a background agent carrying out delegated work. Execute the assignment directly; you do not need to preserve responsiveness for participants. Delegate further only when splitting the work would materially help. Before finishing an assignment, report its result or concrete blocker to your coordinator once. If an assignment ends without a report, your coordinator is told that you finished without replying. Acknowledgments of an already reported result need no further reply. ${DELEGATION_GUIDANCE}`;
  }
  if (input.parentKind === 'workstream') {
    return `Stay available to participants. Delegate substantial or blocking work when useful, then return to the conversation. ${DELEGATION_GUIDANCE}`;
  }
  return `Delegate independent work when splitting it would materially help. ${DELEGATION_GUIDANCE}`;
}
