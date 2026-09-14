import "../../../../../tests/isolated-region";
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RallyDesktopBridge, DesktopSession } from '../../common/desktop';
import { desktopBridge } from './platform';

const globalApiBaseUrl = 'http://127.0.0.1:8787';
const enterpriseApiBaseUrl = 'https://enterprise.api.with-avalon.com';

const identityWireSession: DesktopSession & { refreshToken: string } = {
  accessToken: 'identity-access-token-longer-than-twenty-characters',
  refreshToken: 'identity-refresh-token-kept-private-in-browser-adapter',
  expiresAt: '2026-08-02T00:00:00.000Z',
  apiBaseUrl: globalApiBaseUrl,
  user: { id: 'user-1', email: 'adam@example.com', name: 'Adam' },
  workspace: null,
};

function jsonResponse(payload: unknown): Pick<Response, 'json' | 'ok' | 'status'> {
  return { json: async () => payload, ok: true, status: 200 };
}

describe('browser fallback single-platform identity boundary', () => {
  beforeEach(async () => {
    delete window.rally;
    vi.stubGlobal('fetch', vi.fn());
    await desktopBridge().logout();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reuses the Sidekicks window and clears its opener before navigation', async () => {
    const popup = { closed: false, opener: window, location: { href: '' }, focus: vi.fn() };
    const open = vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);
    await desktopBridge().openSidekicks('example');
    expect(popup.opener).toBeNull();
    expect(popup.location.href).toContain('#/sidekicks/example');
    await desktopBridge().openSidekicks();
    expect(open).toHaveBeenCalledTimes(1);
    expect(popup.location.href).toContain('#/sidekicks');
    expect(popup.focus).toHaveBeenCalledOnce();
    popup.closed = true;
    open.mockRestore();
  });

  it('prefers the hardened preload bridge for clipboard writes', async () => {
    const copyText = vi.fn(async () => undefined);
    const preloadBridge = { copyText } satisfies Pick<RallyDesktopBridge, 'copyText'>;
    Object.defineProperty(window, 'rally', {
      configurable: true,
      value: preloadBridge,
      writable: true,
    });

    await desktopBridge().copyText('copied through preload');

    expect(copyText).toHaveBeenCalledWith('copied through preload');
  });

  it('refuses to create or exchange an enterprise authentication attempt', async () => {
    const bridge = desktopBridge();
    await expect(bridge.createDesktopAuthAttempt({ apiBaseUrl: enterpriseApiBaseUrl, region: 'enterprise' }))
      .rejects.toThrow('Global identity service');
    await expect(bridge.exchangeDesktopTicket({
      apiBaseUrl: enterpriseApiBaseUrl,
      region: 'enterprise',
      ticket: 'single-use-ticket-long-enough',
      attemptId: 'a'.repeat(43),
    })).rejects.toThrow('Global identity service');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('accepts one Global login and validates the regional workspace session before installing it', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(jsonResponse(identityWireSession) as Response);
    const bridge = desktopBridge();
    const attempt = await bridge.createDesktopAuthAttempt({ apiBaseUrl: globalApiBaseUrl, region: 'global' });
    await bridge.exchangeDesktopTicket({
      apiBaseUrl: globalApiBaseUrl,
      region: 'global',
      ticket: 'single-use-ticket-long-enough',
      attemptId: attempt.attemptId,
    });

    fetchMock.mockResolvedValueOnce(jsonResponse({
      ...identityWireSession,
      accessToken: 'regional-access-token-longer-than-twenty-characters',
      refreshToken: 'regional-refresh-token-kept-private-in-browser-adapter',
      apiBaseUrl: enterpriseApiBaseUrl,
      user: { id: 'enterprise-shadow-user-9', email: 'ADAM@example.com', name: 'Adam' },
      workspace: { id: 'workspace-enterprise', name: 'Enterprise Research', region: 'enterprise', role: 'member' },
    }) as Response);
    const regionalSession = await bridge.activateWorkspace({ region: 'enterprise', workspaceId: 'workspace-enterprise' });

    expect(regionalSession.apiBaseUrl).toBe(enterpriseApiBaseUrl);
    expect(regionalSession.workspace?.region).toBe('enterprise');
    expect(regionalSession).not.toHaveProperty('refreshToken');
  });

  it('rejects a login response that bypasses platform workspace discovery', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(jsonResponse({
      ...identityWireSession,
      workspace: { id: 'workspace-global', name: 'Global Research', region: 'global', role: 'member' },
    }) as Response);
    const bridge = desktopBridge();
    const attempt = await bridge.createDesktopAuthAttempt({ apiBaseUrl: globalApiBaseUrl, region: 'global' });

    await expect(bridge.exchangeDesktopTicket({
      apiBaseUrl: globalApiBaseUrl,
      region: 'global',
      ticket: 'single-use-ticket-long-enough',
      attemptId: attempt.attemptId,
    })).rejects.toThrow('before platform discovery');
    await expect(bridge.getSession()).resolves.toBeNull();
  });

  it('rejects a regional session whose endpoint or workspace does not match the request', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(jsonResponse(identityWireSession) as Response);
    const bridge = desktopBridge();
    const attempt = await bridge.createDesktopAuthAttempt({ apiBaseUrl: globalApiBaseUrl, region: 'global' });
    await bridge.exchangeDesktopTicket({
      apiBaseUrl: globalApiBaseUrl,
      region: 'global',
      ticket: 'single-use-ticket-long-enough',
      attemptId: attempt.attemptId,
    });

    fetchMock.mockResolvedValueOnce(jsonResponse({
      ...identityWireSession,
      workspace: { id: 'workspace-global', name: 'Wrong Workspace', region: 'global', role: 'member' },
    }) as Response);

    await expect(bridge.activateWorkspace({ region: 'enterprise', workspaceId: 'workspace-enterprise' }))
      .rejects.toThrow('did not match this workspace request');
  });

  it('rejects a regional shadow user for another verified email', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(jsonResponse(identityWireSession) as Response);
    const bridge = desktopBridge();
    const attempt = await bridge.createDesktopAuthAttempt({ apiBaseUrl: globalApiBaseUrl, region: 'global' });
    await bridge.exchangeDesktopTicket({
      apiBaseUrl: globalApiBaseUrl,
      region: 'global',
      ticket: 'single-use-ticket-long-enough',
      attemptId: attempt.attemptId,
    });

    fetchMock.mockResolvedValueOnce(jsonResponse({
      ...identityWireSession,
      apiBaseUrl: enterpriseApiBaseUrl,
      user: { id: 'enterprise-shadow-user-9', email: 'mallory@example.com', name: 'Mallory' },
      workspace: { id: 'workspace-enterprise', name: 'Enterprise Research', region: 'enterprise', role: 'member' },
    }) as Response);

    await expect(bridge.activateWorkspace({ region: 'enterprise', workspaceId: 'workspace-enterprise' }))
      .rejects.toThrow('did not match this workspace request');
  });
});
