import { describe, expect, it } from 'vitest';
import { agentCoordinationRoleGuidance } from '../src/services/agent-communication-prompts';

describe('agent coordination role guidance', () => {
  it.each(['workstream', 'automation'] as const)('identifies a worker under %s as background rather than a participant coordinator', parentKind => {
    const guidance = agentCoordinationRoleGuidance({ parentKind, backgroundAgent: true });
    expect(guidance).toContain('You are a background agent');
    expect(guidance).toContain('Execute the assignment directly');
    expect(guidance).toContain('only when splitting the work would materially help');
    expect(guidance).toContain('your coordinator is told that you finished without replying');
    expect(guidance).not.toContain('Stay available to participants');
  });

  it.each([
    { parentKind: 'workstream' as const },
    { parentKind: 'automation' as const },
    { parentKind: 'workstream' as const, backgroundAgent: true },
  ])('tells every role that ending the turn is the wait and a wake-up is a deadline (%o)', (input) => {
    const guidance = agentCoordinationRoleGuidance(input);
    expect(guidance).toContain('The reply arrives as a message and wakes this conversation. Do not poll for it and do not resend the assignment.');
    expect(guidance).toContain('schedule one wake-up for that time, not a repeating one');
  });

  it('tells a delegate, and only a delegate, that it works in its coordinator\'s sandbox', () => {
    // The delegate needs the fact to use the files it was sent to work on; the
    // coordinator gets the same fact from `start_agent`, where it decides what
    // to hand over. Naming it in every role would put a Terminal detail in the
    // prompt of runs that never load Terminal.
    const shared = 'sandbox and checkout of the conversation that started you';
    expect(agentCoordinationRoleGuidance({ parentKind: 'workstream', backgroundAgent: true })).toContain(shared);
    expect(agentCoordinationRoleGuidance({ parentKind: 'automation', backgroundAgent: true })).toContain(shared);
    expect(agentCoordinationRoleGuidance({ parentKind: 'workstream' })).not.toContain(shared);
    expect(agentCoordinationRoleGuidance({ parentKind: 'automation' })).not.toContain(shared);
  });

  it('reserves participant responsiveness for foreground workstreams', () => {
    expect(agentCoordinationRoleGuidance({ parentKind: 'workstream' })).toContain('Stay available to participants');
    expect(agentCoordinationRoleGuidance({ parentKind: 'automation' })).not.toContain('Stay available to participants');
  });
});
