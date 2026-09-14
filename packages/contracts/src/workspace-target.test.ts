import "../../../tests/isolated-region";
import { describe, expect, it } from 'vitest';

import {
  addWorkspaceTarget,
  parseWorkspaceTarget,
  workspaceTargetsEqual,
} from './workspace-target';

const TARGET = {
  region: 'enterprise' as const,
  workspaceId: '00000000-0000-7000-8000-000000000009',
};

describe('workspace-addressed links', () => {
  it('uses one versioned path representation without discarding payload fields', () => {
    const url = addWorkspaceTarget(new URL('rallywithai://auth/complete?provider=slack'), TARGET);

    expect(url.toString()).toBe(
      `rallywithai://workspace/enterprise/${TARGET.workspaceId}/auth/complete?provider=slack`,
    );
    expect(parseWorkspaceTarget(url)).toEqual(TARGET);
  });

  it('rejects missing, duplicated, malformed, and query-addressed coordinates', () => {
    for (const rawUrl of [
      'rallywithai://workspace/enterprise',
      'rallywithai://workspace/enterprise/not-a-uuid/settings/connections',
      `rallywithai://workspace/not%20a%20region/${TARGET.workspaceId}/settings/connections`,
      `rallywithai://workspace/enterprise/${TARGET.workspaceId}`,
      `rallywithai://settings/connections?region=enterprise&workspace=${TARGET.workspaceId}`,
    ]) {
      expect(parseWorkspaceTarget(new URL(rawUrl)), rawUrl).toBeNull();
    }
  });

  it('uses a host the previous desktop rejects instead of opening relative to its active workspace', () => {
    const previousReleaseAccepted = (url: URL): boolean => {
      const knownHost = ['auth', 'workstreams', 'invitations', 'settings', 'automations', 'slack']
        .includes(url.hostname);
      return (url.protocol === 'rallywithai:' || url.protocol === 'avalon:') && knownHost;
    };
    for (const destination of [
      `rallywithai://workstreams/00000000-0000-7000-8000-000000000010`,
      'rallywithai://settings/connections',
      'rallywithai://automations/new',
      `rallywithai://slack/link?token=${'a'.repeat(43)}`,
      'rallywithai://auth/complete?provider=google&status=denied&error=oauth_denied',
    ]) {
      const addressed = addWorkspaceTarget(new URL(destination), TARGET);
      expect(previousReleaseAccepted(addressed), addressed.toString()).toBe(false);
    }
  });

  it('compares both routing coordinates', () => {
    expect(workspaceTargetsEqual(TARGET, { ...TARGET })).toBe(true);
    expect(workspaceTargetsEqual(TARGET, { ...TARGET, region: 'global' })).toBe(false);
    expect(workspaceTargetsEqual(TARGET, null)).toBe(false);
  });
});
