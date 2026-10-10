import { isCookieSession, type ClientSession } from '@rally/contracts/client-session';
import type { ConnectorProviderCatalogEntry } from './connector-catalog';

/** The public macOS build, the same one the site and the browser's account rail link to. */
export const MAC_APP_DOWNLOAD_URL = 'https://downloads.rallywith.ai/stable/darwin/arm64/Rally.dmg';

/**
 * Whether the browser runs on a phone or tablet OS, where a Mac download is
 * no use. iPadOS reports itself as a Mac, so a touch-capable "MacIntel" counts.
 */
export function isMobileOs(userAgent: string, platform: string, maxTouchPoints: number): boolean {
  return /Android|iPad|iPhone|iPod/u.test(userAgent) || (platform === 'MacIntel' && maxTouchPoints > 1);
}

/** Whether this device can use the Mac app download. Read once: the OS does not change under a page. */
export const MAC_APP_DOWNLOADABLE = typeof navigator === 'undefined'
  || !isMobileOs(navigator.userAgent, navigator.platform, navigator.maxTouchPoints);

/** What a connector the browser cannot start says, wherever it is listed. */
export const MAC_APP_CONNECT_NOTE = MAC_APP_DOWNLOADABLE
  ? 'Download the Mac app to connect this.'
  : 'Connect this from the Mac app.';

/**
 * Answers whether this client may start a connection to `provider`. The Mac
 * app may start any; a browser tab any but those marked `desktopOnly`, whose
 * authorization needs something only the Mac app has. A new connector is
 * offered in both unless it is marked. Presentation only: the connection
 * routes do not read the mark.
 */
export function useConnectorStartAvailable(
  session: ClientSession | null,
): (provider: ConnectorProviderCatalogEntry) => boolean {
  const browser = isCookieSession(session);
  return (provider) => !browser || !('desktopOnly' in provider && provider.desktopOnly);
}
