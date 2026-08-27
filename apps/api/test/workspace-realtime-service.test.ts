import { describe, expect, it } from 'vitest';

import { workspaceSyncTopicsForMutation } from '../src/services/workspace-realtime-service';

describe('workspaceSyncTopicsForMutation', () => {
  it('does not publish for reads', () => {
    expect(workspaceSyncTopicsForMutation('GET', '/workspace')).toEqual([]);
    expect(workspaceSyncTopicsForMutation('HEAD', '/workstreams')).toEqual([]);
  });

  it.each([
    ['PATCH', '/workspace', ['workspace_profile']],
    ['PATCH', '/workspace/me', ['workspace_profile', 'member_directory']],
    ['POST', '/workspace/terminal/network-policy/apply', ['terminal_policy']],
    ['POST', '/workspace/invitations', ['member_directory', 'invitation_directory']],
    ['DELETE', '/connections/connection-1', ['connector_connections', 'resources', 'automations', 'digest_schedule']],
    ['PATCH', '/digest', ['digest_schedule']],
    ['PATCH', '/automations/automation-1', ['automations', 'workstream_directory']],
    ['POST', '/automation-templates/template-1/subscribe', ['automations', 'workstream_directory']],
    ['POST', '/notes', ['notes', 'resources']],
    ['PATCH', '/projects/project-1', []],
    ['DELETE', '/resources/resource-1', ['resources', 'workstream_directory']],
    ['POST', '/work-opportunities/opportunity-1/start', ['work_opportunities', 'activity', 'workstream_directory']],
    ['PATCH', '/workstreams/workstream-1', ['workstream_directory']],
    ['PATCH', '/telemetry/preference', ['viewer_preferences']],
  ])('maps %s %s to the complete owning surfaces', (method, path, expected) => {
    expect(workspaceSyncTopicsForMutation(method, path)).toEqual(expected);
  });
});
