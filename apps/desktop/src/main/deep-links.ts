import { linkDeepLink, parseLinkTarget } from "@rally/contracts/links";
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

/**
 * Legacy connector results refresh the Settings renderer that started them.
 * Addressed results belong to main alone: it activates the target and then
 * opens Connections, so sending the same result to Settings would race two
 * workspace activations from two renderer processes.
 */
export function shouldDeliverConnectorResultToSettings(rawUrl: string): boolean {
  const intent = parseDesktopDeepLinkIntent(rawUrl);
  return intent?.kind === 'connector-result' && intent.target === null;
}

/**
 * Only the two associated Rally hosts and the Canvas and Sidekick path
 * families enter here. Anything else, a retired Space, Channel, Breakout or
 * Thread link included, stays in the browser, where the site's handoff page
 * says what it named is gone.
 */
export function httpsLinkDeepLink(rawUrl: string): string | null {
  if (!rawUrl.startsWith('https://')) return null;
  const target = parseLinkTarget(rawUrl, { webBaseUrl: ['https://rallywith.ai', 'https://www.rallywith.ai'] });
  return target ? linkDeepLink(target) : null;
}
