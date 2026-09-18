import "../../../../tests/isolated-region";
import { describe, expect, it } from 'vitest';
import type { DesktopWorkspaceSummary } from '../common/desktop';
import type { StoredAuth, StoredAuthSet, StoredProfile, StoredProfileSet } from './stored-auth';
import { endedStoredWorkspaces, mergeWorkspaceDirectory, storedWorkspaceSummaries } from './workspace-directory';

const user = {
  id: '00000000-0000-7000-8000-000000000001',
  email: 'member@example.com',
  name: 'Member',
  avatarUrl: null,
  timezone: 'America/Los_Angeles',
  createdAt: '2026-08-01T12:00:00.000Z',
};

function workspace(id: string, name: string, region: string = 'global'): DesktopWorkspaceSummary {
  return { id, name, slug: name.toLowerCase().replace(/\s+/gu, '-'), region, role: 'member', createdAt: '2026-08-01T12:00:00.000Z' };
}

function credential(workspaceId: string, region: string = 'global'): StoredAuth {
  return {
    version: 1,
    accessToken: `access-token-for-${workspaceId}-${region}`,
    refreshToken: `refresh-token-for-${workspaceId}-${region}`,
    expiresAt: '2026-09-02T12:15:00.000Z',
    binding: { userId: user.id, workspaceId, region },
  };
}

function profile(summary: DesktopWorkspaceSummary, cachedAt = '2026-09-01T12:00:00.000Z'): StoredProfile {
  return {
    version: 1,
    cachedAt,
    user,
    workspace: { ...summary, timezone: 'America/Los_Angeles' },
  };
}

const junoLabs = workspace('00000000-0000-7000-8000-0000000000a1', 'Juno Labs');
const laCabra = workspace('00000000-0000-7000-8000-0000000000a2', 'La Cabra');
const europe = workspace('00000000-0000-7000-8000-0000000000a3', 'Europe Studio', 'enterprise');
const joinedElsewhere = workspace('00000000-0000-7000-8000-0000000000a4', 'Joined Elsewhere');

const auth: StoredAuthSet = {
  version: 2,
  account: null,
  workspaces: [credential(junoLabs.id), credential(laCabra.id), credential(europe.id, 'enterprise')],
  activeWorkspace: { workspaceId: junoLabs.id, region: 'global' },
  workspaceRecency: [
    { workspaceId: junoLabs.id, region: 'global' },
    { workspaceId: laCabra.id, region: 'global' },
  ],
};
const profiles: StoredProfileSet = {
  version: 2,
  account: null,
  workspaces: [profile(europe), profile(laCabra), profile(junoLabs)],
};

describe('stored workspace summaries', () => {
  it('lists every stored workspace, most recently selected first and never-selected ones after', () => {
    expect(storedWorkspaceSummaries(auth, profiles).map((row) => [row.name, row.credentialStored])).toEqual([
      ['Juno Labs', true],
      ['La Cabra', true],
      ['Europe Studio', true],
    ]);
  });

  it('skips a profile whose credential is gone and a credential whose profile is gone', () => {
    const withoutLaCabraCredential = {
      ...auth,
      workspaces: auth.workspaces.filter((candidate) => candidate.binding.workspaceId !== laCabra.id),
      workspaceRecency: auth.workspaceRecency.filter((candidate) => candidate.workspaceId !== laCabra.id),
    };
    const withoutEuropeProfile = {
      ...profiles,
      workspaces: profiles.workspaces.filter((candidate) => candidate.workspace?.id !== europe.id),
    };

    expect(storedWorkspaceSummaries(withoutLaCabraCredential, withoutEuropeProfile).map((row) => row.name))
      .toEqual(['Juno Labs']);
    expect(storedWorkspaceSummaries(null, profiles)).toEqual([]);
  });
});

describe('merged workspace directory', () => {
  it('keeps a stored workspace that discovery could not list and marks which rows this device can read', () => {
    const stored = storedWorkspaceSummaries(auth, profiles);
    const merged = mergeWorkspaceDirectory(
      [{ ...junoLabs, name: 'Juno Labs (renamed)' }, joinedElsewhere],
      stored,
      auth,
    );

    expect(merged.map((row) => [row.name, row.credentialStored])).toEqual([
      ['Juno Labs (renamed)', true],
      ['La Cabra', true],
      ['Joined Elsewhere', false],
      ['Europe Studio', true],
    ]);
  });

  it('is the stored set alone when nothing has been discovered', () => {
    expect(mergeWorkspaceDirectory([], storedWorkspaceSummaries(auth, profiles), auth).map((row) => row.name))
      .toEqual(['Juno Labs', 'La Cabra', 'Europe Studio']);
  });

  it('reads a credential whose profile cache is gone as stored, so its attention can still be asked for', () => {
    const withoutEuropeProfile = {
      ...profiles,
      workspaces: profiles.workspaces.filter((candidate) => candidate.workspace?.id !== europe.id),
    };
    const merged = mergeWorkspaceDirectory([europe], storedWorkspaceSummaries(auth, withoutEuropeProfile), auth);

    expect(merged.map((row) => [row.name, row.credentialStored])).toEqual([
      ['Juno Labs', true],
      ['La Cabra', true],
      ['Europe Studio', true],
    ]);
  });

  it('does not confuse a same-id workspace in the other region with a stored one', () => {
    const regionalTwin = { ...laCabra, region: 'enterprise' as const, name: 'La Cabra enterprise' };
    const merged = mergeWorkspaceDirectory([regionalTwin], storedWorkspaceSummaries(auth, profiles), auth);

    expect(merged.map((row) => [row.name, row.region, row.credentialStored])).toEqual([
      ['Juno Labs', 'global', true],
      ['La Cabra', 'global', true],
      ['La Cabra enterprise', 'enterprise', false],
      ['Europe Studio', 'enterprise', true],
    ]);
  });
});

describe('ended stored workspaces', () => {
  const discoveredAt = '2026-09-02T12:00:00.000Z';

  it('names a stored background workspace that a complete discovery no longer lists', () => {
    expect(endedStoredWorkspaces(auth, profiles, [junoLabs, europe], discoveredAt)).toEqual([
      { workspaceId: laCabra.id, region: 'global' },
    ]);
  });

  it('never names the active workspace, even when discovery omits it', () => {
    expect(endedStoredWorkspaces(auth, profiles, [laCabra, europe], discoveredAt)).toEqual([]);
  });

  it('spares a workspace stored after the discovery request began', () => {
    const freshProfiles = {
      ...profiles,
      workspaces: profiles.workspaces.map((candidate) => (
        candidate.workspace?.id === laCabra.id ? { ...candidate, cachedAt: '2026-09-02T12:00:01.000Z' } : candidate
      )),
    };

    expect(endedStoredWorkspaces(auth, freshProfiles, [junoLabs, europe], discoveredAt)).toEqual([]);
  });

  it('tells regions apart when the same id is listed for the other one', () => {
    expect(endedStoredWorkspaces(auth, profiles, [junoLabs, laCabra, { ...europe, region: 'global' }], discoveredAt))
      .toEqual([{ workspaceId: europe.id, region: 'enterprise' }]);
  });
});
