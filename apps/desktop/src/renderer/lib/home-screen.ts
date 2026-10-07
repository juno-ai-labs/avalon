/**
 * Whether the browser host runs as an app added to the Home Screen, or in an
 * iOS Safari tab that could be. Only Safari on iPhone and iPad defines
 * `navigator.standalone`, so it tells the two apart without reading the user
 * agent. Safari keeps a Home Screen app's cookies apart from its tabs, and
 * offers Web Push only to the Home Screen app.
 */
function standalone(): boolean | undefined {
  if (typeof navigator === 'undefined') return undefined;
  const value: unknown = Reflect.get(navigator, 'standalone');
  return typeof value === 'boolean' ? value : undefined;
}

/** True in a Home Screen app on iOS, or an installed app window elsewhere. */
export function homeScreenApp(): boolean {
  return standalone() === true || (typeof matchMedia === 'function' && matchMedia('(display-mode: standalone)').matches);
}

/** True in an iOS Safari tab, where adding to the Home Screen unlocks notifications. */
export function iosSafariTab(): boolean {
  return standalone() === false;
}
