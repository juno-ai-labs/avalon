import { SIDEKICK_CHANGE_REQUEST_HEADER, type WorkstreamWorkflowInput } from '@rally/contracts';

/**
 * How every role assigns work and waits for a delegate. Carry decisions and
 * procedures in the handoff. Ending the turn is the wait: the reply
 * is admitted as a message and wakes the conversation, so polling and a
 * repeating timer only buy inference. A single wake-up is a deadline.
 */
const DELEGATION_GUIDANCE = 'Tell the agent what result is needed, what requirements are already settled, and what it still needs to investigate. Leave choices that still need investigation to that agent. Loading a skill in your conversation does not load it for another agent. Name the skills the agent must load. For work that will run later, also save the required steps in its run instructions. Send messages only for new results, concrete blockers or questions, or changed requirements. Do not reply just to acknowledge receipt, repeat that you are waiting, or acknowledge another acknowledgment. When a message needs no action or answer, send no agent message; end the turn with one short line in your own conversation, never with no text. After delegating, keep working on what does not need the result, or end your turn with a short status. The reply arrives as a message and wakes this conversation. Do not poll for it and do not resend the assignment. If you must know by a certain time, schedule one wake-up for that time, not a repeating one.';

/**
 * The text the wizard reads for a run's change request. The host writes the
 * frame, so the header, which run sent it and who started the run's current
 * turn come from the run's input, not from the model; only the request is the
 * run's words. It carries no instruction of its own: what to do with it is the
 * wizard's guidance, keyed on the header.
 *
 * The attribution line says who started the turn, not who asked: a reply that
 * arrives while the turn is executing joins it without rebuilding this input,
 * so naming that sender as the asker could credit the wrong person. Who asked
 * is in the request, which the tool's parameter tells the run to include.
 *
 * The sender's display name is text somebody else chose, so it is quoted and
 * labelled, as the run's continuation note does, after its control characters
 * and lone surrogates are dropped: they mean nothing in a name, and JSON
 * quoting turns each into a six-character escape, which could overrun
 * `SIDEKICK_CHANGE_FRAME_RESERVE`. What remains can at most double, for a name
 * of quotes or backslashes.
 */
export function sidekickChangeRequestText(
  runId: string,
  continuation: WorkstreamWorkflowInput['automationContinuation'],
  changes: string,
): string {
  const startedBy = !continuation
    ? 'the run itself, not a person'
    : continuation.source.kind === 'provider_thread'
      ? `${quotedName(continuation.senderName)} (display name), replying in the run's ${providerName(continuation.source.provider)} thread; they may not be a Rally member`
      : `${quotedName(continuation.senderName)} (display name), in the run`;
  return [SIDEKICK_CHANGE_REQUEST_HEADER, `Run: ${runId}`, `Run turn started by: ${startedBy}`, 'Request:', changes].join('\n');
}

function quotedName(name: string): string {
  // eslint-disable-next-line no-control-regex
  return JSON.stringify(name.replace(/[\u0000-\u001f\u007f-\u009f\ud800-\udfff]/gu, ''));
}

function providerName(provider: string): string {
  return provider.length === 0 ? provider : `${provider[0]!.toLocaleUpperCase()}${provider.slice(1)}`;
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
