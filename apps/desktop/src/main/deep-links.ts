import { parseDesktopDeepLinkIntent } from '@rally/contracts/desktop-deep-link-intent';

/** The exact native URL shapes the main process will deliver to a renderer. */
export function acceptedDeepLink(rawUrl: string): string | null {
  try {
    return parseDesktopDeepLinkIntent(rawUrl) ? new URL(rawUrl).toString() : null;
  } catch {
    return null;
  }
}

/** Connector completions are also delivered to a legacy initiating Settings renderer. */
export function isConnectorOAuthResult(rawUrl: string): boolean {
  return parseDesktopDeepLinkIntent(rawUrl)?.kind === 'connector-result';
}
