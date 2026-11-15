import { MOBILE_SIGN_IN_PATH } from '../../mobile/src/auth-contract';
import { MOBILE_CHANNEL, MOBILE_COMMAND_EVENT, VISIBLE_PIN_COUNT, MobileCommandSchema, type MobileEvent } from '../../mobile/src/protocol';

let latest: MobileEvent | null = null;
let screenReady = false;
let latestArtifact: MobileEvent | null = null;
const preparedCanvases = new Map<string, Extract<MobileEvent, { type: 'prepared-canvas' }>>();
let preview: { token: string; origin: string } | null = null;

export function isMobileHost(): boolean {
  if (typeof window === 'undefined' || location.pathname.startsWith(`${MOBILE_SIGN_IN_PATH}/`)) return false;
  const embedded = Boolean(Reflect.get(window, 'ReactNativeWebView')) || new URLSearchParams(location.search).get('mobile') === '1';
  try {
    if (embedded) sessionStorage.setItem('rally-mobile-host', '1');
    return embedded || sessionStorage.getItem('rally-mobile-host') === '1';
  } catch { return embedded; }
}

export function postMobileEvent(event: MobileEvent): void {
  if (!isMobileHost()) return;
  if (event.type === 'screen-ready') screenReady = true;
  if (event.type === 'snapshot' && latest?.type === 'snapshot' && (event.snapshot.userId !== latest.snapshot.userId || event.snapshot.workspaceId !== latest.snapshot.workspaceId)) latestArtifact = null;
  if (event.type === 'snapshot') {
    for (const [id, prepared] of preparedCanvases) {
      if (prepared.userId !== event.snapshot.userId || prepared.workspaceId !== event.snapshot.workspaceId || !event.snapshot.pins.slice(0, VISIBLE_PIN_COUNT).includes(id)) preparedCanvases.delete(id);
    }
  }
  if (event.type === 'prepared-canvas') preparedCanvases.set(event.canvasId, event);
  if (event.type === 'signed-out') preparedCanvases.clear();
  if (event.type === 'snapshot' || event.type === 'signed-out') latest = event;
  if (event.type === 'artifact') latestArtifact = event;
  if (event.type === 'artifact-unavailable') latestArtifact = null;
  if (event.type === 'signed-out') latestArtifact = null;
  const token: unknown = Reflect.get(window, '__RALLY_MOBILE_BRIDGE_TOKEN__');
  const bridge: unknown = Reflect.get(window, 'ReactNativeWebView');
  if (typeof token === 'string' && bridge && typeof bridge === 'object' && 'postMessage' in bridge && typeof bridge.postMessage === 'function') {
    bridge.postMessage(JSON.stringify({ channel: MOBILE_CHANNEL, token, event }));
  } else if (preview && window.parent !== window) {
    window.parent.postMessage({ channel: MOBILE_CHANNEL, token: preview.token, event }, preview.origin);
  }
}

export function installMobileBridge(): void {
  if (!isMobileHost()) return;
  document.documentElement.dataset.mobileHost = 'true';
  // Native compares this with the deployed entry on resume, to reload a stale Home while it is hidden.
  const build = document.querySelector('script[type="module"][src^="/assets/"]')?.getAttribute('src') ?? undefined;
  const ready = () => { postMobileEvent({ type: 'ready', waitForContent: true, build }); if (screenReady) postMobileEvent({ type: 'screen-ready' }); if (latest) postMobileEvent(latest); if (latestArtifact) postMobileEvent(latestArtifact); for (const prepared of preparedCanvases.values()) postMobileEvent(prepared); };
  window.addEventListener('rally:mobile-ready', ready);
  window.addEventListener('message', (event: MessageEvent) => {
    // Only the preview's direct parent may attach. Native uses a token injected
    // into the main frame; an artifact iframe cannot read or mint that token.
    if (event.source !== window.parent || window.parent === window || !event.data || event.data.channel !== MOBILE_CHANNEL) return;
    let configured = new URLSearchParams(location.search).get('mobilePreviewOrigin');
    try {
      if (configured) sessionStorage.setItem('rally-mobile-preview-origin', configured);
      else configured = sessionStorage.getItem('rally-mobile-preview-origin');
    } catch { /* Native does not use this preview channel. */ }
    if (!configured || event.origin !== configured) return;
    if (typeof event.data.attach === 'string') {
      if (typeof event.data.topInset === 'number' && Number.isFinite(event.data.topInset) && event.data.topInset >= 0) document.documentElement.style.setProperty('--mobile-top-inset', `${event.data.topInset}px`);
      preview = { token: event.data.attach, origin: event.origin }; ready(); return; }
    if (!preview || event.origin !== preview.origin || event.data.token !== preview.token) return;
    const parsed = MobileCommandSchema.safeParse(event.data.command);
    if (parsed.success) window.dispatchEvent(new CustomEvent(MOBILE_COMMAND_EVENT, { detail: parsed.data }));
  });
  ready();
}

/** Actionable browser recovery must be visible above the native loading gate. */
export function mobileScreenReady(): void { postMobileEvent({ type: 'screen-ready' }); }
