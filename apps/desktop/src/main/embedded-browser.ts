import { randomUUID } from 'node:crypto';
import { app, session, WebContentsView, type BrowserWindow, type WebContents } from 'electron';
import {
  embeddedBrowserFavicon,
  embeddedBrowserShortcut,
  embeddedBrowserUrl,
  type EmbeddedBrowserBounds,
  type EmbeddedBrowserShortcut,
  type EmbeddedBrowserCommand,
  type EmbeddedBrowserResult,
  type EmbeddedBrowserState,
} from '../common/embedded-browser';

interface BrowserTab {
  id: string;
  view: WebContentsView;
  /** The tab the person opened that this popup tab belongs to, or null for one they opened. */
  popupOf: string | null;
  favicon: string | null;
}

const embeddedBrowserContents = new WeakSet<WebContents>();

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
  // Renderer DOM rectangles use CSS pixels. Native views use window points,
  // which differ when Rally's renderer zoom factor is above or below one.
  const zoom = window.webContents.getZoomFactor();
  const x = Math.max(0, Math.min(Math.round(bounds.x * zoom), width));
  const y = Math.max(0, Math.min(Math.round(bounds.y * zoom), height));
  return {
    x, y,
    width: Math.max(0, Math.min(Math.round(bounds.width * zoom), width - x)),
    height: Math.max(0, Math.min(Math.round(bounds.height * zoom), height - y)),
  };
}

/**
 * A local browser owned by one Rally account. A tab's remote page has no
 * preload, Node, or access to the app renderer. Agent actions can use this
 * command path when a desktop action transport is added.
 */
export class EmbeddedBrowser {
  private readonly tabs = new Map<string, BrowserTab>();
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
    /** Asks the host's controls to focus the address field, for a shortcut pressed inside a page. */
    private readonly onFocusAddress: () => void = () => undefined,
  ) {
    this.partition = browserPartition(userId);
    this.browserSession = session.fromPartition(this.partition);
    // Use the bundled Chromium version and ordinary browser language settings.
    // This removes Electron's UA token; it cannot make every fingerprint match Chrome.
    this.browserSession.setUserAgent(chromeUserAgent(), app.getLocale());
    this.browserSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    this.browserSession.setPermissionCheckHandler(() => false);
    window.once('closed', () => this.dispose());
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

  private layout(): void {
    for (const tab of this.tabs.values()) {
      tab.view.setBounds(this.visible && tab.id === this.activeTabId
        ? this.bounds : { x: 0, y: 0, width: 0, height: 0 });
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
    this.tabs.set(id, { id, view, popupOf, favicon: null });
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
      this.onFocusAddress();
    } else if (shortcut.kind === 'close-tab') await this.command({ action: 'close', tabId: fromId });
    else if (shortcut.kind === 'focus-address') this.onFocusAddress();
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

  private async cdp(contents: WebContents, method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (!contents.debugger.isAttached()) contents.debugger.attach('1.3');
    return await contents.debugger.sendCommand(method, params);
  }

  async command(command: EmbeddedBrowserCommand): Promise<EmbeddedBrowserResult> {
    if (this.disposed) throw new Error('Browser is closed');
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
      const image = await contents.capturePage();
      return { kind: 'screenshot', mimeType: 'image/jpeg', data: image.toJPEG(80).toString('base64') };
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
    }
    this.publish();
    return { kind: 'state', state: this.state() };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const tab of this.tabs.values()) {
      if (!this.window.isDestroyed()) this.window.contentView.removeChildView(tab.view);
      if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
    }
    this.tabs.clear();
  }
}
