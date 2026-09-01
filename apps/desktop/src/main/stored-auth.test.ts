import { describe, expect, it } from 'vitest';
import {
  activeStoredCredential,
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
  const euSession = {
    ...session,
    accessToken: 'eu-access-token-with-more-than-twenty-characters',
    refreshToken: 'eu-refresh-token-with-more-than-twenty-characters',
    workspace: {
      ...session.workspace,
      id: '00000000-0000-7000-8000-000000000003',
      name: 'Rally Europe',
      slug: 'rally-europe',
      region: 'eu' as const,
    },
    apiBaseUrl: 'https://eu.api.rallywith.ai',
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
    const eu = mergeStoredSession(global.auth, global.profiles, euSession, 'eu');

    expect(eu.auth.account?.binding.workspaceId).toBeNull();
    expect(eu.auth.workspaces.map((credential) => [
      credential.binding.workspaceId,
      credential.binding.region,
    ])).toEqual([
      [session.workspace.id, 'global'],
      [euSession.workspace.id, 'eu'],
    ]);
    expect(eu.auth.activeWorkspace).toEqual({ workspaceId: euSession.workspace.id, region: 'eu' });
    expect(activeStoredCredential(eu.auth)).toMatchObject({
      binding: { workspaceId: euSession.workspace.id, region: 'eu' },
    });
  });

  it('keeps same-id workspaces distinct when they belong to different regions', () => {
    const regionalCollision = {
      ...euSession,
      workspace: { ...euSession.workspace, id: session.workspace.id },
    };
    const global = mergeStoredSession(null, null, session, 'global');
    const eu = mergeStoredSession(global.auth, global.profiles, regionalCollision, 'eu');

    expect(eu.auth.workspaces.map((credential) => credential.binding.region)).toEqual(['global', 'eu']);
    expect(eu.profiles.workspaces.map((profile) => profile.workspace?.region)).toEqual(['global', 'eu']);
    expect(activeStoredCredential(eu.auth)).toMatchObject({
      binding: { workspaceId: session.workspace.id, region: 'eu' },
    });

    const selected = selectStoredWorkspace(eu.auth, session.workspace.id, 'global');
    expect(activeStoredCredential(selected)).toMatchObject({
      binding: { workspaceId: session.workspace.id, region: 'global' },
    });
    const removed = removeStoredWorkspace(selected, eu.profiles, session.workspace.id, 'eu');
    expect(removed.auth.workspaces.map((credential) => credential.binding.region)).toEqual(['global']);
    expect(removed.profiles.workspaces.map((profile) => profile.workspace?.region)).toEqual(['global']);
  });

  it('removes only one workspace and selects the most recent remaining credential', () => {
    const accountSession = { ...session, workspace: null, apiBaseUrl: 'https://api.rallywith.ai' };
    const account = mergeStoredSession(null, null, accountSession, 'global');
    const global = mergeStoredSession(account.auth, account.profiles, session, 'global');
    const eu = mergeStoredSession(global.auth, global.profiles, euSession, 'eu');
    const removed = removeStoredWorkspace(eu.auth, eu.profiles, euSession.workspace.id, 'eu');

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
    const eu = mergeStoredSession(global.auth, global.profiles, euSession, 'eu');

    const selected = selectStoredWorkspace(eu.auth, session.workspace.id, 'global');

    expect(selected.activeWorkspace).toEqual({ workspaceId: session.workspace.id, region: 'global' });
    expect(selected.workspaceRecency).toEqual([
      { workspaceId: session.workspace.id, region: 'global' },
      { workspaceId: euSession.workspace.id, region: 'eu' },
    ]);
    expect(selected.workspaces).toEqual(eu.auth.workspaces);
  });
});
