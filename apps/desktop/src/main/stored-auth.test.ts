import { describe, expect, it } from 'vitest';
import {
  parseStoredAuth,
  parseStoredProfile,
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
