import { describe, expect, it } from 'vitest';
import { normalizeLegacyStoredSession, parseLegacyStoredSession } from './stored-session';

const baseSession = {
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

describe('legacy encrypted desktop sessions', () => {
  it('adds Pacific user and Global workspace defaults', () => {
    expect(normalizeLegacyStoredSession({
      user: { id: 'user-1' },
      workspace: { id: 'workspace-1', region: 'global' },
    })).toMatchObject({
      user: { timezone: 'America/Los_Angeles' },
      workspace: { timezone: 'America/Los_Angeles' },
    });
  });

  it('adds the London default to an EU workspace without replacing stored values', () => {
    expect(normalizeLegacyStoredSession({
      user: { timezone: 'Asia/Tokyo' },
      workspace: { region: 'eu' },
    })).toMatchObject({
      user: { timezone: 'Asia/Tokyo' },
      workspace: { timezone: 'Europe/London' },
    });
  });

  it('accepts a pre-preference session and applies durable defaults', () => {
    const legacyUser = {
      id: baseSession.user.id,
      email: baseSession.user.email,
      name: baseSession.user.name,
      avatarUrl: baseSession.user.avatarUrl,
      createdAt: baseSession.user.createdAt,
    };
    const legacyWorkspace = {
      id: baseSession.workspace.id,
      name: baseSession.workspace.name,
      slug: baseSession.workspace.slug,
      region: baseSession.workspace.region,
      role: baseSession.workspace.role,
      createdAt: baseSession.workspace.createdAt,
    };

    expect(parseLegacyStoredSession({
      ...baseSession,
      user: legacyUser,
      workspace: legacyWorkspace,
      futureWireField: 'ignored',
    })).toMatchObject({
      user: { timezone: 'America/Los_Angeles' },
      workspace: { timezone: 'America/Los_Angeles' },
    });
  });

  it('rejects malformed persisted credentials', () => {
    expect(parseLegacyStoredSession({ ...baseSession, refreshToken: 'short' })).toBeNull();
  });
});
