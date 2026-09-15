import { describe, expect, it } from 'vitest';
import { agentCoordinationRoleGuidance } from '../src/services/agent-communication-prompts';

describe('agent coordination role guidance', () => {
  it.each(['workstream', 'automation'] as const)('identifies a worker under %s as background rather than a participant coordinator', parentKind => {
    const guidance = agentCoordinationRoleGuidance({ parentKind, backgroundAgent: true });
    expect(guidance).toContain('You are a background agent');
    expect(guidance).toContain('Execute the assignment directly');
    expect(guidance).toContain('only when splitting the work would materially help');
    expect(guidance).not.toContain('Stay available to participants');
  });

  it('reserves participant responsiveness for foreground workstreams', () => {
    expect(agentCoordinationRoleGuidance({ parentKind: 'workstream' })).toContain('Stay available to participants');
    expect(agentCoordinationRoleGuidance({ parentKind: 'automation' })).not.toContain('Stay available to participants');
  });
});
