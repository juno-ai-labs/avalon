import { describe, expect, it, vi } from 'vitest';
import type { StoredAuth, StoredAuthSet } from './stored-auth';
import { selectStoredWorkspaceLocally } from './workspace-selection';

const workspaceA = '00000000-0000-7000-8000-000000000001';
const workspaceB = '00000000-0000-7000-8000-000000000002';

function credential(workspaceId: string, region: 'global' | 'eu' = 'global'): StoredAuth {
  return {
    version: 1,
    accessToken: `access-${workspaceId}`,
    refreshToken: `refresh-${workspaceId}`,
    expiresAt: '2030-01-01T00:00:00.000Z',
    binding: { userId: 'user-1', workspaceId, region },
  };
}

const authSet: StoredAuthSet = {
  version: 2,
  account: null,
  workspaces: [credential(workspaceA), credential(workspaceB)],
  activeWorkspace: { workspaceId: workspaceA, region: 'global' },
  workspaceRecency: [{ workspaceId: workspaceA, region: 'global' }],
};

describe('local workspace selection', () => {
  it('commits the stored credential for the target as the active selection', async () => {
    const commit = vi.fn(async (auth: StoredAuthSet, session: string) => `${session}:${auth.activeWorkspace?.workspaceId}`);
    const sessionForCredential = vi.fn(async (stored: StoredAuth) => `session-${stored.binding.workspaceId}`);

    const result = await selectStoredWorkspaceLocally(
      { region: 'global', workspaceId: workspaceB },
      { loadAuthSet: async () => authSet, sessionForCredential, commit },
    );

    expect(result).toBe(`session-${workspaceB}:${workspaceB}`);
    expect(sessionForCredential).toHaveBeenCalledWith(credential(workspaceB));
    const committed = commit.mock.calls[0]![0];
    expect(committed.activeWorkspace).toEqual({ workspaceId: workspaceB, region: 'global' });
    expect(committed.workspaceRecency[0]).toEqual({ workspaceId: workspaceB, region: 'global' });
    // Selection rewrites only the active binding; every credential survives.
    expect(committed.workspaces).toEqual(authSet.workspaces);
  });

  it('yields to platform activation when the device holds no credential for the target', async () => {
    const commit = vi.fn();

    const result = await selectStoredWorkspaceLocally(
      { region: 'eu', workspaceId: workspaceB },
      { loadAuthSet: async () => authSet, sessionForCredential: async () => 'never', commit },
    );

    expect(result).toBeNull();
    expect(commit).not.toHaveBeenCalled();
  });

  it('yields to platform activation when the credential has no cached profile', async () => {
    const commit = vi.fn();

    const result = await selectStoredWorkspaceLocally(
      { region: 'global', workspaceId: workspaceB },
      { loadAuthSet: async () => authSet, sessionForCredential: async () => null, commit },
    );

    expect(result).toBeNull();
    expect(commit).not.toHaveBeenCalled();
  });
});
