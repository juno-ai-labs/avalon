import { ConnectorOAuthProviders, IdSchema } from '@rally/contracts';
import { isDesktopDeepLinkProtocol } from '@rally/contracts/desktop-deep-link';
import { parseWorkspaceTarget } from '@rally/contracts/workspace-target';

function hasExactWorkspaceTarget(url: URL, extraKeys: readonly string[] = []): boolean {
  const keys = [...url.searchParams.keys()];
  return keys.length === extraKeys.length + 2
    && keys.every((key) => key === 'region' || key === 'workspace' || extraKeys.includes(key))
    && extraKeys.every((key) => url.searchParams.getAll(key).length === 1)
    && parseWorkspaceTarget(url.searchParams) !== null;
}

/** The exact native URL shapes the main process will deliver to a renderer. */
export function acceptedDeepLink(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    const isAuthentication = isDesktopDeepLinkProtocol(url.protocol)
      && url.hostname === 'auth'
      && url.pathname === '/complete';
    const legacyOrAddressed = url.search === '' || hasExactWorkspaceTarget(url);
    const isWorkstream = isDesktopDeepLinkProtocol(url.protocol)
      && url.hostname === 'workstreams'
      && /^\/[0-9a-f]{8}-[0-9a-f-]{27}$/iu.test(url.pathname)
      && legacyOrAddressed;
    const isNewWorkstream = isDesktopDeepLinkProtocol(url.protocol)
      && url.hostname === 'workstreams'
      && url.pathname === '/new'
      && url.search === '';
    const isInvitation = isDesktopDeepLinkProtocol(url.protocol)
      && url.hostname === 'invitations'
      && url.pathname === '/accept'
      && url.searchParams.get('token') !== null
      && (url.searchParams.get('region') === 'global' || url.searchParams.get('region') === 'eu');
    const isSettings = isDesktopDeepLinkProtocol(url.protocol)
      && url.hostname === 'settings'
      && (url.pathname === '/workspace' || url.pathname === '/connections' || url.pathname === '/digest')
      && legacyOrAddressed;
    const isAutomation = isDesktopDeepLinkProtocol(url.protocol)
      && url.hostname === 'automations'
      && url.pathname === '/new'
      && legacyOrAddressed;
    const token = url.searchParams.get('token');
    const isSlackLink = isDesktopDeepLinkProtocol(url.protocol)
      && url.hostname === 'slack'
      && url.pathname === '/link'
      && token !== null
      && /^[A-Za-z0-9_-]{20,500}$/u.test(token)
      && url.searchParams.getAll('token').length === 1
      && (
        ([...url.searchParams.keys()].length === 1 && url.searchParams.has('token'))
        || hasExactWorkspaceTarget(url, ['token'])
      );
    return isAuthentication || isWorkstream || isNewWorkstream || isInvitation
      || isSettings || isAutomation || isSlackLink
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

/** Connector completions are also delivered to a legacy initiating Settings renderer. */
export function isConnectorOAuthResult(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    const connectionId = url.searchParams.get('connection');
    if (!isDesktopDeepLinkProtocol(url.protocol) || url.hostname !== 'auth' || url.pathname !== '/complete') {
      return false;
    }
    const legacySuccess = connectionId !== null
      && IdSchema.safeParse(connectionId).success
      && url.searchParams.get('status') === 'connected';
    const provider = url.searchParams.get('provider');
    const status = url.searchParams.get('status');
    const providerResult = ConnectorOAuthProviders.some((candidate) => candidate === provider)
      && (
        (status === 'connected' && connectionId !== null && IdSchema.safeParse(connectionId).success)
        || ((status === 'denied' || status === 'failed') && connectionId === null)
      );
    return legacySuccess || providerResult;
  } catch {
    return false;
  }
}
