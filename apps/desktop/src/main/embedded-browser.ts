import { randomUUID } from 'node:crypto';
import { app, session, WebContentsView, type BrowserWindow, type WebContents } from 'electron';
import {
  embeddedBrowserUrl,
  type EmbeddedBrowserBounds,
  type EmbeddedBrowserCommand,
  type EmbeddedBrowserResult,
  type EmbeddedBrowserState,
} from '../common/embedded-browser';

interface BrowserTab {
  id: string;
  view: WebContentsView;
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
      tabs: [...this.tabs.values()].map(({ id, view }) => {
        const contents = view.webContents;
        return {
          id,
          title: contents.getTitle() || 'New tab',
          url: contents.getURL() || 'about:blank',
          loading: contents.isLoading(),
          canGoBack: contents.navigationHistory.canGoBack(),
          canGoForward: contents.navigationHistory.canGoForward(),
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

  private async open(url = 'about:blank'): Promise<void> {
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
      // There is deliberately no preload in visited pages.
    } });
    this.registerView(view);
    if (target !== 'about:blank') await view.webContents.loadURL(target);
  }

  private registerView(view: WebContentsView): void {
    const id = randomUUID();
    const contents = view.webContents;
    this.configureRemoteContents(contents);
    contents.on('page-title-updated', () => this.publish());
    contents.on('did-navigate', () => this.publish());
    contents.on('did-navigate-in-page', () => this.publish());
    contents.on('did-start-loading', () => this.publish());
    contents.on('did-stop-loading', () => this.publish());
    contents.on('render-process-gone', () => this.publish());
    contents.on('destroyed', () => {
      if (!this.window.isDestroyed()) this.window.contentView.removeChildView(view);
      this.tabs.delete(id);
      if (this.activeTabId === id) this.activeTabId = this.tabs.keys().next().value ?? null;
      this.layout();
      this.publish();
    });
    this.tabs.set(id, { id, view });
    this.window.contentView.addChildView(view);
    this.activeTabId = id;
    this.layout();
    this.publish();
  }

  private configureRemoteContents(contents: WebContents): void {
    embeddedBrowserContents.add(contents);
    contents.setUserAgent(chromeUserAgent());
    contents.setWindowOpenHandler(({ url: popupUrl }) => {
      if (embeddedBrowserUrl(popupUrl)) {
        // Native popups from a WebContentsView can remain blank before their
        // first navigation. Open the destination in the rail's own tab model.
        setImmediate(() => { void this.open(popupUrl).catch(() => undefined); });
      }
      return { action: 'deny' };
    });
    const preventNonWebNavigation = (event: Electron.Event, nextUrl: string): void => {
      if (!embeddedBrowserUrl(nextUrl)) event.preventDefault();
    };
    contents.on('will-navigate', preventNonWebNavigation);
    contents.on('will-redirect', preventNonWebNavigation);
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
      tab.view.webContents.close();
      this.tabs.delete(tab.id);
      if (this.activeTabId === tab.id) this.activeTabId = this.tabs.keys().next().value ?? null;
      this.layout();
      this.publish();
      return { kind: 'state', state: this.state() };
    }
    if (command.action === 'select') {
      this.activeTabId = this.tab(command.tabId).id;
      this.layout();
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
