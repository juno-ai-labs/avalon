/**
 * The two notices the host sends an agent's owner on its behalf: a failure,
 * and a completion that sent nothing. `renderAgentMessage` adds the line that
 * attributes them to Rally rather than to an agent.
 */
export function renderAgentFailureNotice(reason: string, agentId: string): string {
  return `Agent failed due to ${reason}. Id: ${agentId}`;
}

export function renderAgentSilentCompletionNotice(name: string | null, agentId: string): string {
  return `Agent ${name ?? agentId} finished without replying. Id: ${agentId}. Message it if you still need its result.`;
}
