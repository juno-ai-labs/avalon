import { linkDeepLink, parseLinkTarget } from "@rally/contracts/links";
import { isDesktopDeepLinkProtocol } from '@rally/contracts/desktop-deep-link';
import { parseDesktopDeepLinkIntent } from '@rally/contracts/desktop-deep-link-intent';
import { parseWorkspaceAddressedDeepLink } from '@rally/contracts/workspace-target';

/** What the deep-link error window says for a retired link: the web app's sentence. */
export { RETIRED_LINK_MESSAGE } from "@rally/contracts/links";

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

/**
 * Whether a deep link the app refused names a Space, Channel, Breakout or
 * Thread, which no longer exist: a deep link under `spaces` or `workstreams`,
 * addressed or not. Shape only, as on the site: nothing it names is read.
 * Main says so in its deep-link error window rather than dropping the link
 * without a word. An HTTPS link never reaches here: `continue-activity` hands
 * back to the browser any link `httpsLinkDeepLink` does not claim, and the
 * web app's entry card says the same sentence for a retired path.
 */
export function isRetiredDeepLink(rawUrl: string): boolean {
  let url: URL;
  try { url = new URL(rawUrl); } catch { return false; }
  if (!isDesktopDeepLinkProtocol(url.protocol)) return false;
  const destination = parseWorkspaceAddressedDeepLink(url)?.destination ?? url;
  return destination.hostname === 'spaces' || destination.hostname === 'workstreams';
}
