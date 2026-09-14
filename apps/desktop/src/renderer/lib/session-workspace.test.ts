import "../../../../../tests/isolated-region";
import { describe, expect, it } from 'vitest';
import type { DesktopSession } from '../../common/desktop';
import { workspaceFromSession } from './session-workspace';

const session: DesktopSession = {
  accessToken: 'access-token-longer-than-twenty-characters',
  expiresAt: '2026-08-02T00:00:00.000Z',
  apiBaseUrl: 'https://api.rallywith.ai',
  user: {
    id: '00000000-0000-7000-8000-000000000001',
    email: 'adam@example.com',
    name: 'Adam',
    timezone: 'America/Los_Angeles',
  },
  workspace: {
    id: '00000000-0000-7000-8000-000000000002',
    name: 'Rally Studio',
    region: 'enterprise',
    role: 'admin',
    timezone: 'Europe/London',
  },
};

describe('workspaceFromSession', () => {
  it('describes the workspace the session is already signed in to', () => {
    expect(workspaceFromSession(session)).toEqual({
      id: '00000000-0000-7000-8000-000000000002',
      name: 'Rally Studio',
      region: 'enterprise',
      timezone: 'Europe/London',
      currentUser: {
        id: '00000000-0000-7000-8000-000000000001',
        email: 'adam@example.com',
        name: 'Adam',
        timezone: 'America/Los_Angeles',
        role: 'admin',
      },
    });
  });

  it('keeps the two timezones apart', () => {
    const workspace = workspaceFromSession(session);
    expect(workspace?.timezone).toBe('Europe/London');
    expect(workspace?.currentUser.timezone).toBe('America/Los_Angeles');
  });

  it('carries an avatar only when the session has one', () => {
    expect(workspaceFromSession(session)?.currentUser).not.toHaveProperty('avatarUrl');
    expect(workspaceFromSession({
      ...session,
      user: { ...session.user, avatarUrl: 'https://example.com/adam.png' },
    })?.currentUser.avatarUrl).toBe('https://example.com/adam.png');
  });

  it.each([
    ['no session', null],
    ['an identity with no workspace', { ...session, workspace: null }],
    ['a workspace with no timezone', { ...session, workspace: { ...session.workspace!, timezone: undefined } }],
    ['a user with no timezone', { ...session, user: { ...session.user, timezone: undefined } }],
  ])('refuses to guess from %s', (_case, value) => {
    expect(workspaceFromSession(value as DesktopSession | null)).toBeNull();
  });
});
