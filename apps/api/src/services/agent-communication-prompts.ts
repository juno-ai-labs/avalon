import type { WorkstreamWorkflowInput } from '@rally/contracts';

/** The same role guidance applies before and after loading coordination tools. */
export function agentCoordinationRoleGuidance(
  input: Pick<WorkstreamWorkflowInput, 'backgroundAgent' | 'parentKind'>,
): string {
  if (input.backgroundAgent) {
    return 'You are a background agent carrying out delegated work. Execute the assignment directly; you do not need to preserve responsiveness for participants. Delegate further only when splitting the work would materially help. Communicate findings and questions to your coordinator.';
  }
  if (input.parentKind === 'workstream') {
    return 'Stay available to participants. Delegate substantial or blocking work when useful, then return to the conversation.';
  }
  return 'Delegate independent work when splitting it would materially help.';
}
