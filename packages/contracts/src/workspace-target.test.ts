import { describe, expect, it } from 'vitest';

import {
  addWorkspaceTarget,
  parseWorkspaceTarget,
  workspaceTargetsEqual,
} from './workspace-target';

const TARGET = {
  region: 'eu' as const,
  workspaceId: '00000000-0000-7000-8000-000000000009',
};

describe('workspace-addressed links', () => {
  it('uses one region/workspace query representation without discarding payload fields', () => {
    const url = addWorkspaceTarget(new URL('rallywithai://auth/complete?provider=slack'), TARGET);

    expect(url.toString()).toBe(
      `rallywithai://auth/complete?provider=slack&region=eu&workspace=${TARGET.workspaceId}`,
    );
    expect(parseWorkspaceTarget(url.searchParams)).toEqual(TARGET);
  });

  it('rejects missing, duplicated, and malformed coordinates', () => {
    for (const query of [
      `region=eu`,
      `workspace=${TARGET.workspaceId}`,
      `region=us&workspace=${TARGET.workspaceId}`,
      `region=eu&workspace=not-a-uuid`,
      `region=eu&region=global&workspace=${TARGET.workspaceId}`,
    ]) {
      expect(parseWorkspaceTarget(new URLSearchParams(query)), query).toBeNull();
    }
  });

  it('compares both routing coordinates', () => {
    expect(workspaceTargetsEqual(TARGET, { ...TARGET })).toBe(true);
    expect(workspaceTargetsEqual(TARGET, { ...TARGET, region: 'global' })).toBe(false);
    expect(workspaceTargetsEqual(TARGET, null)).toBe(false);
  });
});
