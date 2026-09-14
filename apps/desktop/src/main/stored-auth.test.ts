import "../../../../tests/isolated-region";
import { describe, expect, it } from 'vitest';
import {
  activeStoredCredential,
  activeStoredWorkspaceCredential,
  mergeStoredSession,
  parseStoredAuthSet,
  parseStoredProfileSet,
  parseStoredAuth,
  parseStoredProfile,
  removeStoredWorkspace,
  selectStoredWorkspace,
  sessionFromStoredState,
  sessionsShareBinding,
  storedAuthFromSession,
  storedProfileFromSession,
} from './stored-auth';

const session = {
  accessToken: 'access-token-with-more-than-twenty-characters',
  refreshToken: 'refresh-token-with-more-than-twenty-characters',
  expiresAt: '2026-08-05T18:00:00.000Z',
  user: {
    id: '00000000-0000-7000-8000-000000000001',
    email: 'member@example.com',
    name: 'Member',
    avatarUrl: null,
    timezone: 'America/Los_Angeles',
    createdAt: '2026-08-01T12:00:00.000Z',
  },
  workspace: {
    id: '00000000-0000-7000-8000-000000000002',
    name: 'Rally',
    slug: 'rally',
    region: 'global' as const,
    role: 'owner' as const,
    timezone: 'America/Los_Angeles',
    createdAt: '2026-08-01T12:00:00.000Z',
  },
  apiBaseUrl: 'https://api.rallywith.ai',
};

describe('split desktop authentication storage', () => {
  it('keeps credentials and identity bindings out of the profile cache', () => {
    const auth = storedAuthFromSession(session, 'global');
    const profile = storedProfileFromSession(session, '2026-08-05T17:00:00.000Z');

    expect(auth).toEqual({
      version: 1,
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      expiresAt: session.expiresAt,
      binding: {
        userId: session.user.id,
        workspaceId: session.workspace.id,
        region: 'global',
      },
    });
    expect(profile).not.toHaveProperty('accessToken');
    expect(profile).not.toHaveProperty('refreshToken');
    expect(profile).toMatchObject({ version: 1, user: session.user, workspace: session.workspace });
  });

  it('reconstructs a session only when the disposable profile matches the credential binding', () => {
    const auth = storedAuthFromSession(session, 'global');
    const profile = storedProfileFromSession(session);

    expect(sessionFromStoredState(auth, profile, session.apiBaseUrl)).toEqual(session);
    expect(sessionFromStoredState(auth, {
      ...profile,
      workspace: { ...profile.workspace!, id: '00000000-0000-7000-8000-000000000099' },
    }, session.apiBaseUrl)).toBeNull();
  });

  it('rejects incompatible versions without coupling auth to profile fields', () => {
    const auth = storedAuthFromSession(session, 'global');
    const profile = storedProfileFromSession(session);

    expect(parseStoredAuth({ ...auth, version: 2 })).toBeNull();
    expect(parseStoredAuth({ ...auth, futureProfileField: true })).toEqual(auth);
    expect(parseStoredProfile({ ...profile, version: 2 })).toBeNull();
  });

  it('compares refresh responses against stable ids and regions', () => {
    const auth = storedAuthFromSession(session, 'global');

    expect(sessionsShareBinding(session, auth)).toBe(true);
    expect(sessionsShareBinding({
      ...session,
      user: { ...session.user, id: '00000000-0000-7000-8000-000000000099' },
    }, auth)).toBe(false);
  });
});

describe('plural desktop authentication storage', () => {
  const enterpriseSession = {
    ...session,
    accessToken: 'enterprise-access-token-with-more-than-twenty-characters',
    refreshToken: 'enterprise-refresh-token-with-more-than-twenty-characters',
    workspace: {
      ...session.workspace,
      id: '00000000-0000-7000-8000-000000000003',
      name: 'Rally Enterprise',
      slug: 'rally-enterprise',
      region: 'enterprise' as const,
    },
    apiBaseUrl: 'https://enterprise.api.rallywith.ai',
  };

  it('wraps a version-one workspace credential and profile without losing it', () => {
    const auth = storedAuthFromSession(session, 'global');
    const profile = storedProfileFromSession(session);

    expect(parseStoredAuthSet(auth)).toMatchObject({
      version: 2,
      account: null,
      activeWorkspace: { workspaceId: session.workspace.id, region: 'global' },
      workspaces: [auth],
    });
    expect(parseStoredProfileSet(profile)).toMatchObject({
      version: 2,
      account: null,
      workspaces: [profile],
    });
  });

  it('keeps an account credential beside independently regional workspace credentials', () => {
    const accountSession = { ...session, workspace: null, apiBaseUrl: 'https://api.rallywith.ai' };
    const account = mergeStoredSession(null, null, accountSession, 'global');
    const global = mergeStoredSession(account.auth, account.profiles, session, 'global');
    const enterprise = mergeStoredSession(global.auth, global.profiles, enterpriseSession, 'enterprise');

    expect(enterprise.auth.account?.binding.workspaceId).toBeNull();
    expect(enterprise.auth.workspaces.map((credential) => [
      credential.binding.workspaceId,
      credential.binding.region,
    ])).toEqual([
      [session.workspace.id, 'global'],
      [enterpriseSession.workspace.id, 'enterprise'],
    ]);
    expect(enterprise.auth.activeWorkspace).toEqual({ workspaceId: enterpriseSession.workspace.id, region: 'enterprise' });
    expect(activeStoredCredential(enterprise.auth)).toMatchObject({
      binding: { workspaceId: enterpriseSession.workspace.id, region: 'enterprise' },
    });
  });

  it('attaches a missing account credential without changing the active legacy workspace', () => {
    const legacy = mergeStoredSession(null, null, enterpriseSession, 'enterprise');
    const accountSession = { ...session, workspace: null, apiBaseUrl: 'https://api.rallywith.ai' };

    const attached = mergeStoredSession(
      legacy.auth,
      legacy.profiles,
      accountSession,
      'global',
      { activate: false },
    );

    expect(attached.auth.account?.binding.workspaceId).toBeNull();
    expect(attached.auth.activeWorkspace).toEqual({ workspaceId: enterpriseSession.workspace.id, region: 'enterprise' });
    expect(activeStoredCredential(attached.auth)).toMatchObject({
      binding: { workspaceId: enterpriseSession.workspace.id, region: 'enterprise' },
    });
  });

  it('restores one platform account whose regional sessions use different local user ids', () => {
    const accountSession = { ...session, workspace: null, apiBaseUrl: 'https://api.rallywith.ai' };
    const regionalEuSession = {
      ...enterpriseSession,
      user: { ...enterpriseSession.user, id: '00000000-0000-7000-8000-000000000099' },
    };
    const account = mergeStoredSession(null, null, accountSession, 'global');
    const enterprise = mergeStoredSession(account.auth, account.profiles, regionalEuSession, 'enterprise');

    expect(parseStoredAuthSet(JSON.parse(JSON.stringify(enterprise.auth)))).toEqual(enterprise.auth);
  });

  it('keeps same-id workspaces distinct when they belong to different regions', () => {
    const regionalCollision = {
      ...enterpriseSession,
      workspace: { ...enterpriseSession.workspace, id: session.workspace.id },
    };
    const global = mergeStoredSession(null, null, session, 'global');
    const enterprise = mergeStoredSession(global.auth, global.profiles, regionalCollision, 'enterprise');

    expect(enterprise.auth.workspaces.map((credential) => credential.binding.region)).toEqual(['global', 'enterprise']);
    expect(enterprise.profiles.workspaces.map((profile) => profile.workspace?.region)).toEqual(['global', 'enterprise']);
    expect(activeStoredCredential(enterprise.auth)).toMatchObject({
      binding: { workspaceId: session.workspace.id, region: 'enterprise' },
    });

    const selected = selectStoredWorkspace(enterprise.auth, session.workspace.id, 'global');
    expect(activeStoredCredential(selected)).toMatchObject({
      binding: { workspaceId: session.workspace.id, region: 'global' },
    });
    const removed = removeStoredWorkspace(selected, enterprise.profiles, session.workspace.id, 'enterprise');
    expect(removed.auth.workspaces.map((credential) => credential.binding.region)).toEqual(['global']);
    expect(removed.profiles.workspaces.map((profile) => profile.workspace?.region)).toEqual(['global']);
  });

  it('removes only one workspace and selects the most recent remaining credential', () => {
    const accountSession = { ...session, workspace: null, apiBaseUrl: 'https://api.rallywith.ai' };
    const account = mergeStoredSession(null, null, accountSession, 'global');
    const global = mergeStoredSession(account.auth, account.profiles, session, 'global');
    const enterprise = mergeStoredSession(global.auth, global.profiles, enterpriseSession, 'enterprise');
    const removed = removeStoredWorkspace(enterprise.auth, enterprise.profiles, enterpriseSession.workspace.id, 'enterprise');

    expect(removed.auth.workspaces).toHaveLength(1);
    expect(removed.auth.workspaces[0]?.binding.workspaceId).toBe(session.workspace.id);
    expect(removed.auth.activeWorkspace).toEqual({ workspaceId: session.workspace.id, region: 'global' });
    expect(removed.profiles.workspaces).toHaveLength(1);
    expect(removed.auth.account).not.toBeNull();
  });

  it('changes the active workspace without replacing either credential', () => {
    const accountSession = { ...session, workspace: null, apiBaseUrl: 'https://api.rallywith.ai' };
    const account = mergeStoredSession(null, null, accountSession, 'global');
    const global = mergeStoredSession(account.auth, account.profiles, session, 'global');
    const enterprise = mergeStoredSession(global.auth, global.profiles, enterpriseSession, 'enterprise');

    const selected = selectStoredWorkspace(enterprise.auth, session.workspace.id, 'global');

    expect(selected.activeWorkspace).toEqual({ workspaceId: session.workspace.id, region: 'global' });
    expect(selected.workspaceRecency).toEqual([
      { workspaceId: session.workspace.id, region: 'global' },
      { workspaceId: enterpriseSession.workspace.id, region: 'enterprise' },
    ]);
    expect(selected.workspaces).toEqual(enterprise.auth.workspaces);
  });

  it('never resolves a background credential for a destructive active-workspace action', () => {
    const accountSession = { ...session, workspace: null, apiBaseUrl: 'https://api.rallywith.ai' };
    const account = mergeStoredSession(null, null, accountSession, 'global');
    const global = mergeStoredSession(account.auth, account.profiles, session, 'global');
    const enterprise = mergeStoredSession(global.auth, global.profiles, enterpriseSession, 'enterprise');

    expect(activeStoredWorkspaceCredential(
      enterprise.auth, enterpriseSession.workspace.id, 'enterprise',
    )).toMatchObject({ binding: { workspaceId: enterpriseSession.workspace.id, region: 'enterprise' } });
    expect(activeStoredWorkspaceCredential(
      enterprise.auth, session.workspace.id, 'global',
    )).toBeNull();
  });
});

it('drops a removed deployment while preserving the account and Global workspace credentials', () => {
  const account = mergeStoredSession(null, null, { ...session, workspace: null }, 'global');
  const global = mergeStoredSession(account.auth, account.profiles, session, 'global');
  const retiredSession = { ...session, workspace: { ...session.workspace, region: 'retired-deployment' } };
  const retired = mergeStoredSession(global.auth, global.profiles, retiredSession, 'retired-deployment');
  const parsed = parseStoredAuthSet(retired.auth)!;
  expect(parsed.account).toEqual(account.auth.account);
  expect(parsed.workspaces).toEqual(global.auth.workspaces);
  expect(parsed.activeWorkspace).toBeNull();
  expect(parsed.workspaceRecency).toEqual(global.auth.workspaceRecency);
  expect(parseStoredProfileSet(retired.profiles)?.workspaces).toEqual(global.profiles.workspaces);
  expect(parseStoredAuthSet(storedAuthFromSession(retiredSession, 'retired-deployment'))).toBeNull();
  expect(parseStoredProfileSet(storedProfileFromSession(retiredSession))).toBeNull();
});
