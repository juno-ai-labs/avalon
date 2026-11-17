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
