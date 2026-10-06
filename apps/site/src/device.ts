export function isIosDevice(userAgent: string, platform: string, maxTouchPoints: number): boolean {
  return /iPad|iPhone|iPod/u.test(userAgent) || (platform === 'MacIntel' && maxTouchPoints > 1);
}

/** iOS, iPadOS or Android: a device that cannot run the macOS app. */
export function isMobileOs(userAgent: string, platform: string, maxTouchPoints: number): boolean {
  return isIosDevice(userAgent, platform, maxTouchPoints) || /Android/u.test(userAgent);
}
