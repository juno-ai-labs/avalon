import "../../../../../tests/isolated-region";
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DesktopSession } from '../../common/desktop';
import { RallyApi } from './api';

const timestamp = '2026-08-01T01:00:00.000Z';
const workspaceId = '018f3f4e-7b5a-7cc1-9a6f-2aa0324b79d0';
const userId = '018f3f4e-7b5a-7cc1-9a6f-2aa0324b79d1';
const invitationId = '018f3f4e-7b5a-7cc1-9a6f-2aa0324b79d2';

const session: DesktopSession = {
  accessToken: 'access-token-longer-than-twenty-characters',
  expiresAt: timestamp,
  apiBaseUrl: 'https://enterprise.api.rallywith.ai',
  user: {
    id: userId,
    email: 'owner@example.com',
    name: 'Owner',
  },
  workspace: {
    id: workspaceId,
    name: 'Europe Research',
    region: 'enterprise',
    role: 'owner',
  },
};

function json(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init.headers },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('organization and invitation API routing', () => {
  it('starts organization and invitation sign-in without putting private setup data in browser URLs', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({ url: 'https://accounts.google.com/o/oauth2/v2/auth?state=organization' }))
      .mockResolvedValueOnce(json({ url: 'https://accounts.google.com/o/oauth2/v2/auth?state=invitation' }));
    vi.stubGlobal('fetch', fetchMock);
    const api = new RallyApi('https://enterprise.api.rallywith.ai', null);
    const organizationUrl = new URL(await api.beginGoogleLogin(
      'enterprise',
      'rallywithai://auth/complete',
      {
        workspaceName: 'Europe Research',
        authAttempt: { attemptId: 'a'.repeat(43), codeChallenge: 'c'.repeat(43) },
      },
    ));

    expect(organizationUrl.origin).toBe('https://accounts.google.com');
    expect(organizationUrl.searchParams.get('state')).toBe('organization');
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      region: 'enterprise',
      returnUri: 'rallywithai://auth/complete',
      workspaceName: 'Europe Research',
      desktopAttemptId: 'a'.repeat(43),
      desktopCodeChallenge: 'c'.repeat(43),
    });

    const invitationUrl = new URL(await api.beginGoogleLogin(
      'enterprise',
      'rallywithai://auth/complete',
      {
        invitationToken: 'invite-token-longer-than-twenty-characters',
        authAttempt: { attemptId: 'b'.repeat(43), codeChallenge: 'd'.repeat(43) },
      },
    ));
    expect(invitationUrl.origin).toBe('https://accounts.google.com');
    expect(invitationUrl.searchParams.get('state')).toBe('invitation');
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      invitationToken: 'invite-token-longer-than-twenty-characters',
      region: 'enterprise',
      returnUri: 'rallywithai://auth/complete',
      desktopAttemptId: 'b'.repeat(43),
      desktopCodeChallenge: 'd'.repeat(43),
    });
  });

  it('previews an invitation through the selected regional base URL', async () => {
    const token = 'token/with spaces/longer-than-twenty-characters';
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(json({
      workspaceId,
      workspaceName: 'Europe Research',
      region: 'enterprise',
      email: 'invitee@example.com',
      role: 'member',
      expiresAt: '2026-08-08T01:00:00.000Z',
    }));
    vi.stubGlobal('fetch', fetchMock);

    const api = new RallyApi('https://enterprise.api.rallywith.ai', null);
    await expect(api.getInvitationPreview(token)).resolves.toMatchObject({
      workspaceId,
      region: 'enterprise',
      role: 'member',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      `https://enterprise.api.rallywith.ai/auth/invitations/preview?token=${encodeURIComponent(token)}`,
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('sends the selected administrator role to the authenticated invitation endpoint', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(json({
      invitation: {
        id: invitationId,
        email: 'admin@example.com',
        role: 'admin',
        status: 'pending',
        invitedByName: 'Owner',
        expiresAt: '2026-08-08T01:00:00.000Z',
        acceptedAt: null,
        createdAt: timestamp,
      },
      inviteUrl: 'https://rallywith.ai/invite/#region=enterprise&token=invite-token',
      emailDelivery: 'sent',
    }, { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);

    const api = new RallyApi('https://enterprise.api.rallywith.ai', session);
    await expect(api.createWorkspaceInvitation('admin@example.com', 'admin'))
      .resolves.toMatchObject({ invitation: { role: 'admin' } });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://enterprise.api.rallywith.ai/workspace/invitations',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ email: 'admin@example.com', role: 'admin' }),
      }),
    );
    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(headers.get('Authorization')).toBe(`Bearer ${session.accessToken}`);
  });

  it('uses the server-authoritative workspace role when the cached session role is stale', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(json({
      id: workspaceId,
      name: 'Europe Research',
      slug: 'europe-research',
      region: 'enterprise',
      role: 'admin',
      timezone: 'Europe/London',
      createdAt: timestamp,
    }));
    vi.stubGlobal('fetch', fetchMock);

    const staleSession: DesktopSession = {
      ...session,
      workspace: { ...session.workspace!, role: 'member' },
    };
    const api = new RallyApi('https://enterprise.api.rallywith.ai', staleSession);

    await expect(api.getWorkspace()).resolves.toMatchObject({
      region: 'enterprise',
      currentUser: { id: userId, role: 'admin' },
    });
  });
});
