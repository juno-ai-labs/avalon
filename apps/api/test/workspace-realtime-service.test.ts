import { describe, expect, it } from 'vitest';

import { workspaceSyncPublicationsForMutation } from '../src/services/workspace-realtime-service';

const connectionTopics = ['connector_connections', 'resources', 'digest_schedule'];
const organization = { kind: 'organization' };
const actor = { kind: 'actor' };

describe('workspaceSyncPublicationsForMutation', () => {
  it('does not publish for reads', () => {
    expect(workspaceSyncPublicationsForMutation('GET', '/workspace')).toEqual([]);
    expect(workspaceSyncPublicationsForMutation('HEAD', '/workstreams')).toEqual([]);
  });

  it.each([
    ['PATCH', '/workspace', ['workspace_profile'], organization],
    ['PATCH', '/workspace/onboarding', ['workspace_profile'], actor],
    ['PATCH', '/workspace/me', ['workspace_profile', 'member_directory'], organization],
    ['POST', '/workspace/terminal/network-policy/apply', ['terminal_policy'], organization],
    ['POST', '/workspace/invitations', ['member_directory', 'invitation_directory'], organization],
    ['DELETE', '/connections/connection-1', connectionTopics, { kind: 'connection', connectionId: 'connection-1' }],
    ['PUT', '/connections/connection-1/github/repository-access', connectionTopics,
      { kind: 'connection', connectionId: 'connection-1' }],
    ['POST', '/connections/custom-mcp', connectionTopics, { kind: 'connection', connectionId: null }],
    ['POST', '/connections/webhook', connectionTopics, { kind: 'connection', connectionId: null }],
    ['POST', '/connections/x', connectionTopics, organization],
    ['POST', '/connections/granola/workspace', connectionTopics, organization],
    ['POST', '/connections/ashby/workspace', connectionTopics, organization],
    ['POST', '/connections/canva/complete', connectionTopics, actor],
    ['POST', '/connections/google/start', ['connector_oauth_attempts'], actor],
    ['POST', '/connections/custom-mcp/start', ['connector_oauth_attempts'], actor],
    ['POST', '/connections/connection-1/reconnect', ['connector_oauth_attempts'], actor],
    ['POST', '/connections/connection-1/resource-authorizations/start', ['connector_oauth_attempts'], actor],
    ['POST', '/connections/slack/link', ['connector_connections', 'digest_schedule'], actor],
    ['PUT', '/digest', ['digest_schedule'], actor],
    ['PATCH', '/automations/automation-1', ['automations', 'workstream_directory'], organization],
    ['POST', '/automation-templates/template-1/subscribe', ['automations', 'workstream_directory'], organization],
    ['POST', '/notes', ['notes', 'resources'], organization],
    ['DELETE', '/resources/resource-1', ['resources', 'workstream_directory'], organization],
    ['POST', '/work-opportunities/opportunity-1/start', ['work_opportunities', 'activity', 'workstream_directory'],
      organization],
    ['PATCH', '/workstreams/workstream-1', ['workstream_directory'], organization],
    ['PATCH', '/telemetry/preference', ['viewer_preferences'], actor],
  ])('maps %s %s to its owning surfaces and their audience', (method, path, topics, audience) => {
    expect(workspaceSyncPublicationsForMutation(method, path)).toEqual([{ topics, audience }]);
  });

  it('publishes nothing for a retired or read-only write', () => {
    expect(workspaceSyncPublicationsForMutation('PATCH', '/projects/project-1')).toEqual([]);
    expect(workspaceSyncPublicationsForMutation('POST', '/connections/slack/link/preview')).toEqual([]);
  });
});
