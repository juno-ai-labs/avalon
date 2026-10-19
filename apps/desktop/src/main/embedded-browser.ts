import { randomUUID } from 'node:crypto';
import { app, session, WebContentsView, type BrowserWindow, type WebContents } from 'electron';
import {
  embeddedBrowserFavicon,
  embeddedBrowserShortcut,
  embeddedBrowserUrl,
  type EmbeddedBrowserBounds,
  type EmbeddedBrowserShortcut,
  type EmbeddedBrowserCommand,
  type EmbeddedBrowserHostRequest,
  type EmbeddedBrowserNetworkResponse,
  type EmbeddedBrowserResult,
  type EmbeddedBrowserState,
} from '../common/embedded-browser';

import { clampBounds } from './artifact-viewers';
import { BrowserScriptRuntime } from './browser-script-runtime';
import { BrowserScriptDriver } from './browser-script-driver';

interface RecordedResponse extends EmbeddedBrowserNetworkResponse {
  body: { body: string; base64Encoded: boolean } | null;
}

interface BrowserTab {
  id: string;
  view: WebContentsView;
  /** The tab the person opened that this popup tab belongs to, or null for one they opened. */
  popupOf: string | null;
  favicon: string | null;
  /** What the page has received since it last navigated, by DevTools request id. */
  network: Map<string, RecordedResponse>;
  /** Bytes of copied bodies `network` holds, against `NETWORK_BODY_BYTES_MAX`. */
  networkBytes: number;
}

/**
 * The resource types whose bodies are copied as they finish: what page script
 * fetched, which is where a web app's data arrives. Documents, scripts, images
 * and media are listed but read live from Chromium's own buffer.
 */
const CACHED_RESOURCE_TYPES = new Set(['Fetch', 'XHR']);

/**
 * The most body bytes one tab holds for one document; a body past it is
 * listed but left uncopied, and reads live from Chromium if it still has it.
 *
 * Open on purpose: the guard is written, the number is the team's to set (see
 * `docs/adding-security-defensive-and-other-limits.md`). Only an agent-driven
 * browser records, and a new document empties the record, so the arithmetic
 * is one conversation page's Fetch/XHR traffic: a ChatGPT conversation's JSON
 * runs from 0.2 to 5 MB.
 */
export const NETWORK_BODY_BYTES_MAX = Number.POSITIVE_INFINITY;

const embeddedBrowserContents = new WeakSet<WebContents>();

/** Where a hidden active tab waits: far outside any window, at its full size. */
const PARKED_OFFSET = 100_000;

export function isEmbeddedBrowserWebContents(contents: WebContents): boolean {
  return embeddedBrowserContents.has(contents);
}

function chromeUserAgent(): string {
  const platform = process.platform === 'darwin'
    ? 'Macintosh; Intel Mac OS X 10_15_7'
    : process.platform === 'win32' ? 'Windows NT 10.0; Win64; x64' : 'X11; Linux x86_64';
  return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`;
}

/**
 * Electron draws no passkey prompt, so outside Windows a passkey request hangs;
 * without WebAuthn a site offers another sign-in. See docs/embedded-browser.md.
 */
function disabledBlinkFeatures(): string | undefined {
  return process.platform === 'win32' ? undefined : 'WebAuth';
}

function browserPartition(userId: string): string {
  return `persist:rally-browser-${userId}`;
}

function dimensions(bounds: EmbeddedBrowserBounds, window: BrowserWindow): EmbeddedBrowserBounds {
  const [width = 0, height = 0] = window.getContentSize();
  return clampBounds(bounds, { width, height }, window.webContents.getZoomFactor());
}

/**
 * A local browser owned by one Rally account. A tab's remote page has no
 * preload, Node, or access to the app renderer. Agent actions can use this
 * command path when a desktop action transport is added.
 */
export class EmbeddedBrowser {
  private readonly tabs = new Map<string, BrowserTab>();
  private readonly scriptRuntimes = new Map<string, { tabId: string; runtime: BrowserScriptRuntime }>();
  private activeTabId: string | null = null;
  private bounds: EmbeddedBrowserBounds = { x: 0, y: 0, width: 0, height: 0 };
  private visible = false;
  private disposed = false;
  private readonly browserSession;
  private readonly partition;

  constructor(
    private readonly window: BrowserWindow,
    userId: string,
    private readonly onState: (state: EmbeddedBrowserState) => void,
    /** Hands a shortcut pressed inside a page to the host's controls. */
    private readonly onHostRequest: (request: EmbeddedBrowserHostRequest) => void = () => undefined,
    /**
     * A browser an agent drives (the import window's): its tabs record their
     * network from creation, and a covered active tab keeps rendering at full
     * speed. A person's own browsing pays for neither.
     */
    private readonly agentDriven = false,
  ) {
    this.partition = browserPartition(userId);
    this.browserSession = session.fromPartition(this.partition);
    // Use the bundled Chromium version and ordinary browser language settings.
    // This removes Electron's UA token; it cannot make every fingerprint match Chrome.
    this.browserSession.setUserAgent(chromeUserAgent(), app.getLocale());
    this.browserSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    this.browserSession.setPermissionCheckHandler(() => false);
    window.once('closed', () => this.dispose());
    const clearRuntimes = () => {
      for (const entry of this.scriptRuntimes.values()) entry.runtime.dispose();
      this.scriptRuntimes.clear();
    };
    window.webContents.on('render-process-gone', clearRuntimes);
    window.webContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
      if (isMainFrame && !isInPlace) clearRuntimes();
    });
  }

  state(): EmbeddedBrowserState {
    return {
      activeTabId: this.activeTabId,
      tabs: [...this.tabs.values()].map(({ id, view, favicon }) => {
        const contents = view.webContents;
        return {
          id,
          title: contents.getTitle() || 'New tab',
          url: contents.getURL() || 'about:blank',
          loading: contents.isLoading(),
          canGoBack: contents.navigationHistory.canGoBack(),
          canGoForward: contents.navigationHistory.canGoForward(),
          favicon,
        };
      }),
    };
  }

  private publish(): void {
    if (!this.disposed) this.onState(this.state());
  }

  setBounds(bounds: EmbeddedBrowserBounds): void {
    this.bounds = dimensions(bounds, this.window);
    this.layout();
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.layout();
  }

  /**
   * The active tab keeps its size whether or not it is in view. Hidden, it is
   * parked outside the window: nobody can click or type into it, and a Rally
   * overlay paints over where it was, but an agent driving it still reads,
   * captures and clicks a full-size page that keeps rendering. Collapsing it
   * to nothing — what hiding used to do — stopped an import mid-run whenever
   * a dialog opened over the page.
   */
  private layout(): void {
    for (const tab of this.tabs.values()) {
      const active = tab.id === this.activeTabId;
      const contents = tab.view.webContents;
      contents.setBackgroundThrottling(!(active && this.agentDriven));
      if (!active) tab.view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
      else if (this.visible) tab.view.setBounds(this.bounds);
      else {
        tab.view.setBounds({ ...this.bounds, x: PARKED_OFFSET, y: PARKED_OFFSET });
        // Keys follow focus, not position: a parked page keeps none.
        if (contents.isFocused() && !this.window.isDestroyed()) this.window.webContents.focus();
      }
    }
  }

  private async open(url = 'about:blank', popupOf: string | null = null): Promise<void> {
    const target = embeddedBrowserUrl(url);
    if (!target) throw new Error('Only HTTP and HTTPS pages can open in the browser');
    const view = new WebContentsView({ webPreferences: {
      partition: this.partition,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: true,
      disableBlinkFeatures: disabledBlinkFeatures(),
      // There is deliberately no preload in visited pages.
    } });
    this.registerView(view, popupOf);
    if (target !== 'about:blank') await view.webContents.loadURL(target);
  }

  /**
   * A page's popup opens as a tab, and each tab the person opened has at most
   * one: popups from it, or from its popup, reuse that tab. A sign-in popup
   * works; a page that calls `window.open` in a loop re-navigates one tab
   * instead of spawning a renderer per call.
   */
  private async openPopup(fromId: string, url: string): Promise<void> {
    const root = this.tabs.get(fromId)?.popupOf ?? fromId;
    const existing = [...this.tabs.values()].find((tab) => tab.popupOf === root);
    if (!existing) return this.open(url, root);
    this.activeTabId = existing.id;
    this.layout();
    this.publish();
    await existing.view.webContents.loadURL(url);
  }

  private registerView(view: WebContentsView, popupOf: string | null): void {
    const id = randomUUID();
    const contents = view.webContents;
    this.configureRemoteContents(contents, id);
    const network = new Map<string, RecordedResponse>();
    if (this.agentDriven) this.recordNetwork(contents, id);
    contents.on('page-title-updated', () => this.publish());
    contents.on('did-navigate', () => {
      // A new document starts without the last one's icon.
      const tab = this.tabs.get(id);
      if (tab) tab.favicon = null;
      this.publish();
    });
    contents.on('page-favicon-updated', (_event, favicons: string[]) => {
      const tab = this.tabs.get(id);
      if (!tab) return;
      tab.favicon = favicons.map(embeddedBrowserFavicon).find((icon) => icon !== null) ?? null;
      this.publish();
    });
    contents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return;
      const shortcut = embeddedBrowserShortcut({
        key: input.key, code: input.code, shift: input.shift, alt: input.alt, control: input.control,
        command: process.platform === 'darwin' ? input.meta : input.control,
      });
      if (!shortcut) return;
      event.preventDefault();
      void this.shortcut(shortcut, id).catch(() => undefined);
    });
    contents.on('did-navigate-in-page', () => this.publish());
    contents.on('did-start-loading', () => this.publish());
    contents.on('did-stop-loading', () => this.publish());
    contents.on('render-process-gone', () => this.publish());
    contents.on('destroyed', () => {
      if (!this.window.isDestroyed()) this.window.contentView.removeChildView(view);
      // A `close` command has already removed and replaced the tab; only a tab
      // that went away on its own still needs it.
      if (this.forget(id)) this.publish();
    });
    this.tabs.set(id, { id, view, popupOf, favicon: null, network, networkBytes: 0 });
    this.window.contentView.addChildView(view);
    this.activeTabId = id;
    this.layout();
    this.publish();
  }

  private configureRemoteContents(contents: WebContents, id: string): void {
    embeddedBrowserContents.add(contents);
    contents.setUserAgent(chromeUserAgent());
    contents.setWindowOpenHandler(({ url: popupUrl }) => {
      if (embeddedBrowserUrl(popupUrl)) {
        // Native popups from a WebContentsView can remain blank before their
        // first navigation. Open the destination in the rail's own tab model.
        setImmediate(() => { void this.openPopup(id, popupUrl).catch(() => undefined); });
      }
      return { action: 'deny' };
    });
    const preventNonWebNavigation = (event: Electron.Event, nextUrl: string): void => {
      if (!embeddedBrowserUrl(nextUrl)) event.preventDefault();
    };
    contents.on('will-navigate', preventNonWebNavigation);
    contents.on('will-redirect', preventNonWebNavigation);
  }

  /** A shortcut pressed inside a page, acting on that page's tab. */
  private async shortcut(shortcut: EmbeddedBrowserShortcut, fromId: string): Promise<void> {
    const ids = [...this.tabs.keys()];
    const at = ids.indexOf(fromId);
    if (shortcut.kind === 'new-tab') {
      await this.command({ action: 'open' });
      this.onHostRequest('focus-address');
    } else if (shortcut.kind === 'close-tab') {
      // The last close is the host's: it may close the browser rather than
      // take the blank tab that would replace this one.
      if (this.tabs.size === 1) this.onHostRequest('close-last-tab');
      else await this.command({ action: 'close', tabId: fromId });
    } else if (shortcut.kind === 'focus-address') this.onHostRequest('focus-address');
    else if (shortcut.kind === 'reload') await this.command({ action: 'reload', tabId: fromId });
    else if (shortcut.kind === 'back') await this.command({ action: 'back', tabId: fromId });
    else if (shortcut.kind === 'forward') await this.command({ action: 'forward', tabId: fromId });
    else if (shortcut.kind === 'next-tab' || shortcut.kind === 'previous-tab') {
      const next = ids[(at + (shortcut.kind === 'next-tab' ? 1 : ids.length - 1)) % ids.length];
      if (next) await this.command({ action: 'select', tabId: next });
    } else if (shortcut.kind === 'tab-at') {
      const target = shortcut.index === 'last' ? ids.at(-1) : ids[shortcut.index];
      if (target) await this.command({ action: 'select', tabId: target });
    }
  }

  /** Drops a tab and picks the next active one; false when it was already gone. */
  private forget(id: string): boolean {
    for (const [runtimeId, entry] of this.scriptRuntimes) {
      if (entry.tabId === id) { entry.runtime.dispose(); this.scriptRuntimes.delete(runtimeId); }
    }
    const ids = [...this.tabs.keys()];
    const at = ids.indexOf(id);
    if (!this.tabs.delete(id)) return false;
    // As a browser does, the neighbour to the right takes over, else the left.
    if (this.activeTabId === id) this.activeTabId = ids[at + 1] ?? ids[at - 1] ?? null;
    this.layout();
    return true;
  }

  private tab(id?: string): BrowserTab {
    const tab = this.tabs.get(id ?? this.activeTabId ?? '');
    if (!tab) throw new Error('Browser tab is no longer open');
    return tab;
  }

  /**
   * Records every response the page receives, from the tab's first request,
   * so an agent can read the data a web app loaded instead of rebuilding the
   * request that fetched it. Fetch and XHR bodies are copied as each finishes:
   * Chromium evicts its own copies, and an agent may need one well after it
   * arrived. A new document starts a new list, which keeps what is held to one
   * page's traffic.
   */
  private recordNetwork(contents: WebContents, tabId: string): void {
    const methods = new Map<string, string>();
    // The tab is registered after its view, so it is looked up per event.
    const recordOf = () => this.tabs.get(tabId);
    contents.on('did-start-navigation', (...args: unknown[]) => {
      const details = args[0] as { isMainFrame?: boolean; isSameDocument?: boolean } | undefined;
      const isMainFrame = details?.isMainFrame ?? args[3] === true;
      const isSameDocument = details?.isSameDocument ?? args[2] === true;
      const tab = recordOf();
      if (isMainFrame && !isSameDocument && tab) {
        tab.network.clear();
        tab.networkBytes = 0;
        methods.clear();
      }
    });
    contents.debugger.on('message', (_event, method: string, params: Record<string, unknown>) => {
      const requestId = typeof params['requestId'] === 'string' ? params['requestId'] : null;
      const tab = recordOf();
      if (!requestId || !tab) return;
      const network = tab.network;
      if (method === 'Network.requestWillBeSent') {
        const request = params['request'] as { method?: string } | undefined;
        methods.set(requestId, request?.method ?? 'GET');
      } else if (method === 'Network.responseReceived') {
        const response = params['response'] as { url?: string; status?: number; mimeType?: string } | undefined;
        network.set(requestId, {
          requestId,
          url: response?.url ?? '',
          method: methods.get(requestId) ?? 'GET',
          status: response?.status ?? 0,
          mimeType: response?.mimeType ?? '',
          resourceType: typeof params['type'] === 'string' ? params['type'] : 'Other',
          size: null,
          cached: false,
          body: null,
        });
      } else if (method === 'Network.loadingFinished') {
        const recorded = network.get(requestId);
        if (!recorded) return;
        recorded.size = typeof params['encodedDataLength'] === 'number' ? params['encodedDataLength'] : null;
        if (!CACHED_RESOURCE_TYPES.has(recorded.resourceType)) return;
        void (contents.debugger.sendCommand('Network.getResponseBody', { requestId }) as Promise<{ body: string; base64Encoded: boolean }>)
          .then((body) => {
            // A navigation may have started a new list while this was read.
            if (network.get(requestId) !== recorded) return;
            if (tab.networkBytes + body.body.length > NETWORK_BODY_BYTES_MAX) return;
            tab.networkBytes += body.body.length;
            recorded.body = { body: body.body, base64Encoded: body.base64Encoded };
            recorded.cached = true;
          })
          .catch(() => undefined);
      }
    });
    try {
      if (!contents.debugger.isAttached()) contents.debugger.attach('1.3');
      void contents.debugger.sendCommand('Network.enable').catch(() => undefined);
    } catch {
      // Another debugger (an open DevTools window) holds the page; nothing is recorded.
    }
  }

  private async cdp(contents: WebContents, method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (!contents.debugger.isAttached()) contents.debugger.attach('1.3');
    return await contents.debugger.sendCommand(method, params);
  }

  async command(command: EmbeddedBrowserCommand): Promise<EmbeddedBrowserResult> {
    if (this.disposed) throw new Error('Browser is closed');
    if (command.action === 'script_reset') {
      const entry = this.scriptRuntimes.get(command.runtimeId);
      if (entry && entry.tabId !== command.tabId) throw new Error('Browser runtime belongs to another tab');
      entry?.runtime.dispose();
      this.scriptRuntimes.delete(command.runtimeId);
      return { kind: 'state', state: this.state() };
    }
    if (command.action === 'script') {
      this.tab(command.tabId);
      let entry = this.scriptRuntimes.get(command.runtimeId);
      if (entry && entry.tabId !== command.tabId) throw new Error('Browser runtime belongs to another tab');
      if (!entry) {
        const driver = new BrowserScriptDriver(command.tabId, {
          getEmbeddedBrowserState: async () => this.state(),
          commandEmbeddedBrowser: request => this.command(request),
        });
        entry = { tabId: command.tabId, runtime: new BrowserScriptRuntime(command.tabId, driver) };
        this.scriptRuntimes.set(command.runtimeId, entry);
      }
      const { stored, ...result } = await entry.runtime.execute(command.code);
      return { kind: 'script', result, stored };
    }
    if (command.action === 'open') {
      await this.open(command.url);
      return { kind: 'state', state: this.state() };
    }
    if (command.action === 'close') {
      const tab = this.tab(command.tabId);
      this.forget(tab.id);
      tab.view.webContents.close();
      // A browser surface always has a page; the last close leaves a blank tab.
      if (this.tabs.size === 0) await this.open();
      this.publish();
      return { kind: 'state', state: this.state() };
    }
    if (command.action === 'select') {
      this.activeTabId = this.tab(command.tabId).id;
      this.layout();
      this.publish();
      return { kind: 'state', state: this.state() };
    }
    if (command.action === 'move') {
      const moving = this.tab(command.tabId);
      const order = [...this.tabs.values()].filter((tab) => tab.id !== moving.id);
      order.splice(Math.min(command.index, order.length), 0, moving);
      this.tabs.clear();
      for (const tab of order) this.tabs.set(tab.id, tab);
      this.publish();
      return { kind: 'state', state: this.state() };
    }
    const contents = this.tab(command.tabId).view.webContents;
    if (command.action === 'navigate') {
      const url = embeddedBrowserUrl(command.url);
      if (!url) throw new Error('Only HTTP and HTTPS pages can open in the browser');
      await contents.loadURL(url);
    } else if (command.action === 'back') {
      if (contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
    } else if (command.action === 'forward') {
      if (contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward();
    } else if (command.action === 'reload') {
      contents.reload();
    } else if (command.action === 'stop') {
      contents.stop();
    } else if (command.action === 'snapshot') {
      const result = await this.cdp(contents, 'Accessibility.getFullAXTree');
      return { kind: 'snapshot', url: contents.getURL(), title: contents.getTitle(), tree: result };
    } else if (command.action === 'screenshot') {
      // At the page's own size in DIPs, so a point read off the image is the
      // point `click` and `scroll` send: input events are in DIPs, while the
      // capture is in device pixels.
      const view = this.tab(command.tabId).view.getBounds();
      const captured = await contents.capturePage();
      const image = view.width > 0 && view.height > 0 ? captured.resize({ width: view.width, height: view.height }) : captured;
      const size = image.getSize();
      return { kind: 'screenshot', mimeType: 'image/jpeg', data: image.toJPEG(80).toString('base64'), width: size.width, height: size.height };
    } else if (command.action === 'click') {
      contents.sendInputEvent({ type: 'mouseDown', x: command.x, y: command.y, button: 'left', clickCount: 1 });
      contents.sendInputEvent({ type: 'mouseUp', x: command.x, y: command.y, button: 'left', clickCount: 1 });
    } else if (command.action === 'scroll') {
      contents.sendInputEvent({ type: 'mouseWheel', x: command.x, y: command.y, deltaX: command.deltaX, deltaY: command.deltaY });
    } else if (command.action === 'type') {
      contents.insertText(command.text);
    } else if (command.action === 'key') {
      contents.sendInputEvent({ type: 'keyDown', keyCode: command.key });
      contents.sendInputEvent({ type: 'keyUp', keyCode: command.key });
    } else if (command.action === 'evaluate') {
      return { kind: 'value', value: await contents.executeJavaScript(command.expression, true) };
    } else if (command.action === 'cdp') {
      return { kind: 'value', value: await this.cdp(contents, command.method, command.params) };
    } else if (command.action === 'network') {
      const responses = [...this.tab(command.tabId).network.values()].map((recorded): EmbeddedBrowserNetworkResponse => ({
        requestId: recorded.requestId, url: recorded.url, method: recorded.method, status: recorded.status,
        mimeType: recorded.mimeType, resourceType: recorded.resourceType, size: recorded.size, cached: recorded.cached,
      }));
      return { kind: 'network', responses };
    } else if (command.action === 'response_body') {
      const recorded = this.tab(command.tabId).network.get(command.requestId);
      if (!recorded) throw new Error('No response with that id since the page last navigated');
      if (recorded.body) return { kind: 'response_body', ...recorded.body };
      const live = await this.cdp(contents, 'Network.getResponseBody', { requestId: command.requestId }) as { body: string; base64Encoded: boolean };
      return { kind: 'response_body', body: live.body, base64Encoded: live.base64Encoded };
    }
    this.publish();
    return { kind: 'state', state: this.state() };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const entry of this.scriptRuntimes.values()) entry.runtime.dispose();
    this.scriptRuntimes.clear();
    for (const tab of this.tabs.values()) {
      if (!this.window.isDestroyed()) this.window.contentView.removeChildView(tab.view);
      if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
    }
    this.tabs.clear();
  }
}
