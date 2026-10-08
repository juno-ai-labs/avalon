/**
 * Where the browser host runs on iPhone and iPad: `true` in an app added to the
 * Home Screen, `false` in a Safari tab, `undefined` anywhere else. Only iOS
 * Safari defines `navigator.standalone`, so this needs no user agent. Safari
 * keeps a Home Screen app's cookies apart from its tabs, and offers Web Push
 * only to the Home Screen app. An installed Chromium app shares its browser
 * profile's cookies, so it is deliberately `undefined` here.
 */
export function iosStandalone(): boolean | undefined {
  if (typeof navigator === 'undefined') return undefined;
  const value: unknown = Reflect.get(navigator, 'standalone');
  return typeof value === 'boolean' ? value : undefined;
}
