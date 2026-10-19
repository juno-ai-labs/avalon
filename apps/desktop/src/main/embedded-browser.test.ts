import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => ({
  sessions: new Map<string, {
    setUserAgent: ReturnType<typeof vi.fn>;
    setPermissionRequestHandler: ReturnType<typeof vi.fn>;
    setPermissionCheckHandler: ReturnType<typeof vi.fn>;
  }>(),
  views: [] as Array<{ options: { webPreferences: Record<string, unknown> }; webContents: FakeContents; bounds: unknown }>,
}));

class FakeContents extends EventEmitter {
  url = 'about:blank';
  destroyed = false;
  windowOpenHandler: ((details: { url: string }) => { action: string }) | null = null;
  navigationHistory = { canGoBack: () => false, canGoForward: () => false, goBack: vi.fn(), goForward: vi.fn() };
  setUserAgent = vi.fn();
  session = { setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn() };
  executeJavaScript = vi.fn(async () => []);
  setWindowOpenHandler = vi.fn((handler: (details: { url: string }) => { action: string }) => { this.windowOpenHandler = handler; });
  loadURL = vi.fn(async (url: string) => { this.url = url; });
  getURL = (): string => this.url;
  getTitle = (): string => '';
  isLoading = (): boolean => false;
  isDestroyed = (): boolean => this.destroyed;
  throttled = true;
  setBackgroundThrottling = (throttled: boolean): void => { this.throttled = throttled; };
  focused = false;
  isFocused = (): boolean => this.focused;
  /** DevTools: events a test emits, and the bodies `Network.getResponseBody` answers with. */
  bodies = new Map<string, { body: string; base64Encoded: boolean }>();
  debugger = Object.assign(new EventEmitter(), {
    attached: false,
    isAttached: () => this.debugger.attached,
    attach: () => { this.debugger.attached = true; },
    sendCommand: vi.fn(async (method: string, params: { requestId?: string } = {}) => {
      if (method !== 'Network.getResponseBody') return {};
      const body = this.bodies.get(params.requestId ?? '');
      if (!body) throw new Error('No resource with given identifier found');
      return body;
    }),
  });
  close = vi.fn(() => { this.destroyed = true; this.emit('destroyed'); });
}

vi.mock('electron', () => ({
  app: { getLocale: () => 'en-US' },
  session: {
    fromPartition: (partition: string) => {
      const existing = electron.sessions.get(partition);
      if (existing) return existing;
      const created = { setUserAgent: vi.fn(), setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn() };
      electron.sessions.set(partition, created);
      return created;
    },
  },
  WebContentsView: class {
    webContents = new FakeContents();
    bounds: unknown = null;
    constructor(public options: { webPreferences: Record<string, unknown> }) { electron.views.push(this); }
    setBounds(bounds: unknown): void { this.bounds = bounds; }
  },
}));

const { EmbeddedBrowser, isEmbeddedBrowserWebContents } = await import('./embedded-browser');

function hostWindow(zoom = 1) {
  const window = Object.assign(new EventEmitter(), {
    getContentSize: () => [1000, 800],
    isDestroyed: () => false,
    webContents: Object.assign(new EventEmitter(), { getZoomFactor: () => zoom, focus: vi.fn() }),
    contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
  });
  return window;
}

function browser(zoom = 1, userId = 'user-1', agentDriven = false) {
  const window = hostWindow(zoom);
  const states: unknown[] = [];
  const instance = new EmbeddedBrowser(window as never, userId, (state) => states.push(state), undefined, agentDriven);
  return { instance, window, states };
}

describe('the local browser behind the rail and the import window', () => {
  beforeEach(() => {
    electron.sessions.clear();
    electron.views.length = 0;
  });

  it.each(['render-process-gone', 'did-start-navigation'])('disposes script realms on owner %s while preserving the page', async event => {
    const { instance, window } = browser();
    await instance.command({ action: 'open', url: 'https://chatgpt.com/' });
    const tabId = instance.state().activeTabId!;
    await instance.command({ action: 'script', tabId, runtimeId: 'run-1', code: '1' });
    const page = electron.views[0]!.webContents;
    const realm = electron.views[1]!.webContents;
    expect(realm.destroyed).toBe(false);
    if (event === 'did-start-navigation') window.webContents.emit(event, {}, 'http://localhost/', false, true);
    else window.webContents.emit(event, {});
    expect(realm.destroyed).toBe(true);
    expect(page.destroyed).toBe(false);
    expect(instance.state().tabs.map(tab => tab.url)).toEqual(['https://chatgpt.com/']);
    instance.dispose();
  });

  it('gives visited pages no preload or Node, in a sandbox, in the signed-in user’s own partition', async () => {
    const { instance } = browser();
    await instance.command({ action: 'open', url: 'https://chatgpt.com/' });
    const preferences = electron.views[0]!.options.webPreferences;
    expect(preferences).toMatchObject({ partition: 'persist:rally-browser-user-1', sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true });
    expect(preferences).not.toHaveProperty('preload');
    expect(isEmbeddedBrowserWebContents(electron.views[0]!.webContents as never)).toBe(true);
    browser(1, 'user-2');
    expect([...electron.sessions.keys()]).toEqual(['persist:rally-browser-user-1', 'persist:rally-browser-user-2']);
  });

  it('refuses every permission a site asks for', () => {
    browser();
    const partition = electron.sessions.get('persist:rally-browser-user-1')!;
    const callback = vi.fn();
    (partition.setPermissionRequestHandler.mock.calls[0]![0] as (c: unknown, p: string, cb: (granted: boolean) => void) => void)(null, 'media', callback);
    expect(callback).toHaveBeenCalledWith(false);
    expect((partition.setPermissionCheckHandler.mock.calls[0]![0] as () => boolean)()).toBe(false);
  });

  it('opens and navigates only to web pages, and fences a page’s own navigation the same way', async () => {
    const { instance } = browser();
    await expect(instance.command({ action: 'open', url: 'file:///etc/passwd' })).rejects.toThrow('Only HTTP and HTTPS');
    await instance.command({ action: 'open' });
    await expect(instance.command({ action: 'navigate', url: 'javascript:alert(1)' })).rejects.toThrow('Only HTTP and HTTPS');
    const contents = electron.views[0]!.webContents;
    for (const [event, url, blocked] of [['will-navigate', 'file:///tmp/x', true], ['will-redirect', 'rally://workstreams/1', true], ['will-navigate', 'https://claude.ai/login', false]] as const) {
      const preventDefault = vi.fn();
      contents.emit(event, { preventDefault }, url);
      expect(preventDefault).toHaveBeenCalledTimes(blocked ? 1 : 0);
    }
  });

  it('opens a website’s popup as another tab and never as a native window', async () => {
    const { instance } = browser();
    await instance.command({ action: 'open', url: 'https://claude.ai/' });
    const handler = electron.views[0]!.webContents.windowOpenHandler!;
    expect(handler({ url: 'https://accounts.google.com/o/oauth2' })).toEqual({ action: 'deny' });
    expect(handler({ url: 'javascript:alert(1)' })).toEqual({ action: 'deny' });
    await new Promise((resolve) => setImmediate(resolve));
    expect(electron.views.map((view) => view.webContents.url)).toEqual(['https://claude.ai/', 'https://accounts.google.com/o/oauth2']);
  });

  it('gives each opened tab at most one popup tab, however many times a page opens one', async () => {
    const { instance } = browser();
    await instance.command({ action: 'open', url: 'https://ads.example/' });
    const page = electron.views[0]!.webContents;
    for (let index = 0; index < 50; index += 1) page.windowOpenHandler!({ url: `https://ads.example/popup/${index}` });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(electron.views).toHaveLength(2);
    expect(electron.views[1]!.webContents.url).toBe('https://ads.example/popup/49');
    // The popup's own popups reuse the same tab rather than chaining new ones.
    electron.views[1]!.webContents.windowOpenHandler!({ url: 'https://ads.example/chained' });
    await new Promise((resolve) => setImmediate(resolve));
    expect(electron.views).toHaveLength(2);
    expect(electron.views[1]!.webContents.url).toBe('https://ads.example/chained');
    expect(instance.state().activeTabId).toBe(instance.state().tabs[1]!.id);
  });

  it('places the active tab in window points while visible, and parks it at full size, unfocused, while hidden', async () => {
    const { instance, window } = browser(1.25, 'user-1', true);
    await instance.command({ action: 'open', url: 'https://a.example/' });
    await instance.command({ action: 'open', url: 'https://b.example/' });
    instance.setBounds({ x: 10, y: 40, width: 400, height: 300 });
    // Hidden from the start: an agent can still drive a page of the rail's size.
    expect(electron.views.map((view) => view.bounds)).toEqual([
      { x: 0, y: 0, width: 0, height: 0 }, { x: 100_000, y: 100_000, width: 500, height: 375 },
    ]);
    expect(electron.views.map((view) => view.webContents.throttled)).toEqual([true, false]);
    instance.setVisible(true);
    expect(electron.views[1]!.bounds).toEqual({ x: 13, y: 50, width: 500, height: 375 });
    expect(electron.views[0]!.bounds).toEqual({ x: 0, y: 0, width: 0, height: 0 });
    // Covered by a Rally dialog while the person was typing in the page.
    electron.views[1]!.webContents.focused = true;
    instance.setVisible(false);
    expect(electron.views[1]!.bounds).toEqual({ x: 100_000, y: 100_000, width: 500, height: 375 });
    expect(window.webContents.focus).toHaveBeenCalledTimes(1);
  });

  it('records nothing and throttles a covered tab in a browser no agent drives', async () => {
    const { instance } = browser();
    await instance.command({ action: 'open', url: 'https://chat.example/c/1' });
    const contents = electron.views[0]!.webContents;
    expect(contents.debugger.attached).toBe(false);
    expect(contents.throttled).toBe(true);
    contents.debugger.emit('message', {}, 'Network.responseReceived', { requestId: 'r1', type: 'Fetch', response: { url: 'https://chat.example/api', status: 200, mimeType: 'application/json' } });
    expect(await instance.command({ action: 'network', tabId: instance.state().activeTabId! })).toEqual({ kind: 'network', responses: [] });
  });

  it('reorders tabs, selects the closed tab’s neighbour, and leaves a blank tab after the last close', async () => {
    const { instance } = browser();
    for (const url of ['https://a.example/', 'https://b.example/', 'https://c.example/']) await instance.command({ action: 'open', url });
    const [a, b, c] = instance.state().tabs.map((tab) => tab.id);
    await instance.command({ action: 'move', tabId: c!, index: 0 });
    expect(instance.state().tabs.map((tab) => tab.id)).toEqual([c, a, b]);
    await instance.command({ action: 'select', tabId: a! });
    await instance.command({ action: 'close', tabId: a! });
    expect(instance.state().activeTabId).toBe(b);
    await instance.command({ action: 'close', tabId: b! });
    await instance.command({ action: 'close', tabId: c! });
    expect(instance.state().tabs).toEqual([expect.objectContaining({ url: 'about:blank' })]);
  });

  it('shows a page’s https icon, drops it on navigation, and ignores an unsafe one', async () => {
    const { instance } = browser();
    await instance.command({ action: 'open', url: 'https://claude.ai/' });
    const contents = electron.views[0]!.webContents;
    contents.emit('page-favicon-updated', {}, ['javascript:alert(1)', 'https://claude.ai/favicon.ico']);
    expect(instance.state().tabs[0]!.favicon).toBe('https://claude.ai/favicon.ico');
    contents.emit('did-navigate');
    expect(instance.state().tabs[0]!.favicon).toBeNull();
    contents.emit('page-favicon-updated', {}, ['http://claude.ai/favicon.ico']);
    expect(instance.state().tabs[0]!.favicon).toBeNull();
  });

  it('acts on a browser shortcut pressed inside the page, and lets other keys through', async () => {
    const hostRequest = vi.fn();
    const window = hostWindow();
    const instance = new EmbeddedBrowser(window as never, 'user-1', () => undefined, hostRequest);
    await instance.command({ action: 'open', url: 'https://a.example/' });
    const contents = electron.views[0]!.webContents;
    const press = (input: Record<string, unknown>) => {
      const event = { preventDefault: vi.fn() };
      contents.emit('before-input-event', event, { type: 'keyDown', key: '', code: '', shift: false, alt: false, control: false, meta: false, ...input });
      return event.preventDefault;
    };
    const modifier = process.platform === 'darwin' ? { meta: true } : { control: true };
    expect(press({ key: 'c', code: 'KeyC', ...modifier })).not.toHaveBeenCalled();
    expect(press({ key: 't', code: 'KeyT', ...modifier })).toHaveBeenCalled();
    await new Promise((resolve) => setImmediate(resolve));
    expect(instance.state().tabs).toHaveLength(2);
    expect(hostRequest).toHaveBeenCalledExactlyOnceWith('focus-address');
    press({ key: 'w', code: 'KeyW', ...modifier });
    await new Promise((resolve) => setImmediate(resolve));
    const [last] = instance.state().tabs;
    expect(instance.state().tabs).toHaveLength(1);
    // The last close goes to the host, which may close the browser instead.
    electron.views.at(-1)!.webContents.emit('before-input-event', { preventDefault: vi.fn() },
      { type: 'keyDown', key: 'w', code: 'KeyW', shift: false, alt: false, control: false, meta: false, ...modifier });
    await new Promise((resolve) => setImmediate(resolve));
    expect(hostRequest).toHaveBeenLastCalledWith('close-last-tab');
    expect(instance.state().tabs).toEqual([last]);
  });

  it('closes a tab once, selecting the next, and closes every tab on dispose', async () => {
    const { instance, states, window } = browser();
    await instance.command({ action: 'open', url: 'https://a.example/' });
    await instance.command({ action: 'open', url: 'https://b.example/' });
    const [first, second] = instance.state().tabs;
    const published = states.length;
    const result = await instance.command({ action: 'close', tabId: second!.id });
    expect(result).toEqual({ kind: 'state', state: expect.objectContaining({ activeTabId: first!.id, tabs: [expect.objectContaining({ id: first!.id })] }) });
    expect(states.length - published).toBe(1);
    expect(window.contentView.removeChildView).toHaveBeenCalledTimes(1);
    instance.dispose();
    expect(electron.views[0]!.webContents.close).toHaveBeenCalled();
    await expect(instance.command({ action: 'open' })).rejects.toThrow('Browser is closed');
  });

  it('records the page’s responses, keeps fetched bodies after the browser lets them go, and starts over on a new document', async () => {
    const { instance } = browser(1, 'user-1', true);
    await instance.command({ action: 'open', url: 'https://chat.example/c/1' });
    const tabId = instance.state().activeTabId!;
    const contents = electron.views[0]!.webContents;
    expect(contents.debugger.sendCommand).toHaveBeenCalledWith('Network.enable');
    const network = (method: string, params: Record<string, unknown>) => contents.debugger.emit('message', {}, method, params);
    network('Network.requestWillBeSent', { requestId: 'r1', request: { method: 'POST' } });
    network('Network.responseReceived', { requestId: 'r1', type: 'Fetch', response: { url: 'https://chat.example/api/conversation/1', status: 200, mimeType: 'application/json' } });
    network('Network.responseReceived', { requestId: 'r2', type: 'Image', response: { url: 'https://chat.example/logo.png', status: 200, mimeType: 'image/png' } });
    contents.bodies.set('r1', { body: '{"messages":[1,2]}', base64Encoded: false });
    network('Network.loadingFinished', { requestId: 'r1', encodedDataLength: 18 });
    network('Network.loadingFinished', { requestId: 'r2', encodedDataLength: 900 });
    await vi.waitFor(async () => expect(await instance.command({ action: 'network', tabId })).toEqual({ kind: 'network', responses: [
      { requestId: 'r1', url: 'https://chat.example/api/conversation/1', method: 'POST', status: 200, mimeType: 'application/json', resourceType: 'Fetch', size: 18, cached: true },
      { requestId: 'r2', url: 'https://chat.example/logo.png', method: 'GET', status: 200, mimeType: 'image/png', resourceType: 'Image', size: 900, cached: false },
    ] }));

    // Chromium has evicted its copy; the fetched body still reads back.
    contents.bodies.clear();
    expect(await instance.command({ action: 'response_body', tabId, requestId: 'r1' }))
      .toEqual({ kind: 'response_body', body: '{"messages":[1,2]}', base64Encoded: false });
    await expect(instance.command({ action: 'response_body', tabId, requestId: 'r2' })).rejects.toThrow('No resource');

    // A same-document change keeps the list; a new document starts it over.
    contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true });
    expect((await instance.command({ action: 'network', tabId }) as { responses: unknown[] }).responses).toHaveLength(2);
    contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
    expect(await instance.command({ action: 'network', tabId })).toEqual({ kind: 'network', responses: [] });
  });
});