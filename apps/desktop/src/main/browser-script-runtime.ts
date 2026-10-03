import { randomUUID } from 'node:crypto';
import { WebContentsView } from 'electron';
import { BROWSER_RUNTIME_DOCUMENTATION } from '@rally/contracts/browser-runtime';
import type { DesktopActionResult } from '@rally/contracts/desktop-actions';
import { installBrowserScriptRuntime } from '../common/browser-script-bootstrap';
import type { BrowserScriptDriver } from './browser-script-driver';
import type { StoredItem } from '../common/desktop-actions/store';

/** One disposable, sandboxed Chromium REPL per desktop executor. No preload or signed-in partition. */
export class BrowserScriptRuntime {
  private readonly view = new WebContentsView({ webPreferences: {
    partition: `rally-browser-script-${randomUUID()}`, sandbox: true, contextIsolation: true,
    nodeIntegration: false, webSecurity: true, backgroundThrottling: false,
  } });
  private readonly ready: Promise<void>;
  private active = false;
  private disposed = false;
  private readonly pending = new Set<Promise<void>>();
  constructor(private readonly tabId: string, private readonly driver: BrowserScriptDriver) {
    const contents = this.view.webContents;
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', event => event.preventDefault());
    contents.on('will-redirect', event => event.preventDefault());
    contents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    contents.session.setPermissionCheckHandler(() => false);
    contents.debugger.on('message', (_event, method, params: { name?: string; payload?: string }) => {
      if (method !== 'Runtime.bindingCalled' || params.name !== '__rallyInvoke' || !params.payload) return;
      const operation = this.answer(params.payload);
      this.pending.add(operation);
      void operation.finally(() => this.pending.delete(operation)).catch(() => undefined);
    });
    this.ready = this.initialize();
    // Initialization may fail before the first caller awaits it.
    void this.ready.catch(() => undefined);
  }
  private async initialize() {
    const contents = this.view.webContents;
    // Only this disposable realm can compile model code. Its policy gives it
    // neither network access nor frames; browser access is the typed binding.
    const html = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-eval'">`;
    await contents.loadURL(`data:text/html,${encodeURIComponent(html)}`);
    contents.debugger.attach('1.3');
    await contents.debugger.sendCommand('Runtime.enable');
    await contents.debugger.sendCommand('Runtime.addBinding', { name: '__rallyInvoke' });
    await contents.executeJavaScript(`(${installBrowserScriptRuntime.toString()})(${JSON.stringify(this.tabId)},${JSON.stringify(BROWSER_RUNTIME_DOCUMENTATION)})`);
  }
  private async answer(payload: string) {
    let id: string | undefined;
    let answer: { value?: unknown; error?: string };
    try {
      const decoded = JSON.parse(payload) as { id?: unknown; request?: unknown };
      if (typeof decoded.id !== 'string') throw new Error('Browser request id must be a string.');
      id = decoded.id;
      if (!this.active || this.disposed) throw new Error('The browser script call has ended.');
      answer = { value: await this.driver.invoke(decoded.request) };
    } catch (error) { answer = { error: error instanceof Error ? error.message : String(error) }; }
    if (id !== undefined && !this.disposed) {
      await this.view.webContents.executeJavaScript(`globalThis.__rallyReply(${JSON.stringify(id)},${JSON.stringify(answer)})`).catch(() => undefined);
    }
  }
  async execute(code: string): Promise<DesktopActionResult<'browser.script'> & { stored: StoredItem[] }> {
    if (this.disposed) throw new Error('The browser runtime is closed.');
    await this.ready;
    if (this.active) throw new Error('The browser runtime is already executing a call.');
    this.active = true;
    let error: string | undefined;
    try {
      const result = await this.view.webContents.debugger.sendCommand('Runtime.evaluate', {
        expression: code, replMode: true, awaitPromise: true, returnByValue: false,
      }) as { exceptionDetails?: { text?: string; exception?: { description?: string } } };
      error = result.exceptionDetails?.exception?.description ?? result.exceptionDetails?.text;
    } catch (caught) { error = caught instanceof Error ? caught.message : String(caught); }
    finally {
      while (this.pending.size > 0 && !this.disposed) await Promise.all([...this.pending]);
      this.active = false;
    }
    const output = this.disposed ? [] : await this.view.webContents.executeJavaScript('globalThis.__rallyOutput.splice(0)') as DesktopActionResult<'browser.script'>['output'];
    return { output, ...(error !== undefined ? { error } : {}), stored: this.driver.store.drain() };
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.active = false;
    this.driver.dispose();
    this.view.webContents.close();
  }
}
