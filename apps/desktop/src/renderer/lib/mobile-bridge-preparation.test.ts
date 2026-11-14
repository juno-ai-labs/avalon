import { expect, it, vi } from 'vitest';
import { installMobileBridge, postMobileEvent } from '../../../../browser/src/mobile-bridge';
import type { MobileEvent, MobileSnapshot } from '../../../../mobile/src/protocol';

it('replays prepared pins after bridge attachment and drops them on organization change', () => {
  const events: MobileEvent[] = [];
  const snapshot: MobileSnapshot = { userId: 'alice', userName: 'Alice', workspaceId: 'work', workspaceName: 'Work', workspacePath: '/app/workspaces/global/work', canvases: [], pins: ['shopping'], hasMore: false, loading: false, pinBusy: false, pinError: null, directoryError: false, canvasId: null, tabId: null, view: 'home', title: 'Your canvases', artifactId: null, artifactPicker: false };
  history.replaceState(null, '', '/?mobile=1');
  vi.stubGlobal('ReactNativeWebView', { postMessage: (raw: string) => events.push(JSON.parse(raw).event) });
  try {
    installMobileBridge();
    postMobileEvent({ type: 'snapshot', snapshot });
    postMobileEvent({ type: 'prepared-canvas', userId: 'alice', workspaceId: 'work', canvasId: 'shopping', canvas: { canvasId: 'shopping', resourceId: 'site', version: 1, title: 'Shopping' } });
    expect(events).toEqual([]);
    vi.stubGlobal('__RALLY_MOBILE_BRIDGE_TOKEN__', 'capability');
    window.dispatchEvent(new Event('rally:mobile-ready'));
    expect(events.map((event) => event.type)).toEqual(['ready', 'snapshot', 'prepared-canvas']);
    postMobileEvent({ type: 'snapshot', snapshot: { ...snapshot, workspaceId: 'other', pins: [] } });
    events.length = 0;
    window.dispatchEvent(new Event('rally:mobile-ready'));
    expect(events.map((event) => event.type)).toEqual(['ready', 'snapshot']);
  } finally {
    postMobileEvent({ type: 'signed-out' });
    vi.unstubAllGlobals();
    history.replaceState(null, '', '/');
    sessionStorage.clear();
  }
});
