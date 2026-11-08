/**
 * Whether this device's shortcuts take Command rather than Control. The
 * renderer runs as the macOS app and in any browser, so a label read off the
 * keyboard it is drawn for, not the one Rally was first built on.
 */
export function isApplePlatform(platform: string = typeof navigator === 'undefined' ? '' : navigator.platform): boolean {
  return /^(Mac|iPhone|iPad|iPod)/u.test(platform);
}

/** A shortcut's label with the platform's primary modifier: `⌘↵` on a Mac, `Ctrl+Enter` elsewhere. */
export function primaryShortcutLabel(key: { apple: string; other: string }, platform?: string): string {
  return isApplePlatform(platform) ? `⌘${key.apple}` : `Ctrl+${key.other}`;
}
