import type { EmbeddedBrowserCommand, EmbeddedBrowserResult, EmbeddedBrowserState } from '../common/embedded-browser';
import { BrowserScriptRequestSchema, type BrowserLocator, type BrowserScriptRequest } from '../common/browser-script-protocol';
import { createDesktopActionExecutor } from '../common/desktop-actions/executor';
import { DesktopActionStore } from '../common/desktop-actions/store';
import { describeZodIssues } from '@rally/contracts/zod-diagnostics';

interface AxNode { backendDOMNodeId?: number; ignored?: boolean; role?: { value?: string }; name?: { value?: string }; }
interface RemoteObject { objectId?: string; value?: unknown; description?: string; }
interface RuntimeReply { result?: RemoteObject; exceptionDetails?: { text?: string; exception?: RemoteObject }; }

/** DOM discovery for the non-role locator subset. Role/name matching uses Chromium AX. */
function queryElements(locator: BrowserLocator): Element[] {
  const match = (value: string) => {
    const expected = locator.name ?? locator.value;
    if (typeof expected !== 'string') return new RegExp(expected.source, expected.flags).test(value);
    const normalized = value.replace(/\s+/gu, ' ').trim();
    return locator.exact ? normalized === expected : normalized.toLowerCase().includes(expected.toLowerCase());
  };
  if (locator.kind === 'css') return Array.from(document.querySelectorAll(locator.value));
  if (locator.kind === 'testid') return Array.from(document.querySelectorAll('[data-testid]')).filter(el => el.getAttribute('data-testid') === locator.value);
  if (locator.kind === 'placeholder') return Array.from(document.querySelectorAll('[placeholder]')).filter(el => match(el.getAttribute('placeholder') ?? ''));
  if (locator.kind === 'label') return Array.from(document.querySelectorAll('input,textarea,select,button,[aria-label],[aria-labelledby]')).filter(el => {
    const labels = (el as HTMLInputElement).labels;
    const labelledBy = el.getAttribute('aria-labelledby')?.split(/\s+/u).map(id => document.getElementById(id)?.textContent ?? '').join(' ');
    return match(labelledBy || el.getAttribute('aria-label') || (labels ? Array.from(labels).map(label => label.textContent ?? '').join(' ') : ''));
  });
  return Array.from(document.querySelectorAll('body *')).filter(el => match(el.textContent ?? '') && !Array.from(el.children).some(child => match(child.textContent ?? '')));
}

/** The pinned-tab adapter. Model code never receives this object or the Electron bridge. */
export class BrowserScriptDriver {
  readonly store = new DesktopActionStore();
  private readonly executor;
  private readonly indexes = new Map<number, number>();
  private disposed = false;
  private nextIndex = 0;
  private stopWaiting!: () => void;
  private readonly stopped = new Promise<void>(resolve => { this.stopWaiting = resolve; });
  dispose() { this.disposed = true; this.stopWaiting(); this.store.drain(); }
  private ensureOpen() { if (this.disposed) throw new Error('The browser runtime is closed.'); }
  private previousState = '';
  private previousUrl = '';
  constructor(private readonly tabId: string, private readonly bridge: {
    commandEmbeddedBrowser(command: EmbeddedBrowserCommand): Promise<EmbeddedBrowserResult>;
    getEmbeddedBrowserState(): Promise<EmbeddedBrowserState>;
  }) { this.executor = createDesktopActionExecutor({ tabId, bridge, store: this.store }); }

  private async cdp<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    this.ensureOpen();
    const reply = await this.bridge.commandEmbeddedBrowser({ action: 'cdp', tabId: this.tabId, method, params });
    if (reply.kind !== 'value') throw new Error(`Browser command ${method} did not return a value.`);
    return reply.value as T;
  }
  private async page() {
    const state = await this.bridge.getEmbeddedBrowserState();
    const page = state.tabs.find(tab => tab.id === this.tabId);
    if (!page) throw new Error('The pinned tab is closed.');
    if (page.url !== this.previousUrl) { this.indexes.clear(); this.previousState = ''; this.previousUrl = page.url; }
    return { id: page.id, title: page.title, url: page.url };
  }
  private async nodes() { return (await this.cdp<{ nodes: AxNode[] }>('Accessibility.getFullAXTree')).nodes; }
  private async snapshot(full: boolean) {
    const page = await this.page();
    const lines = [`URL: ${page.url}`, `Title: ${page.title}`];
    const currentNodes = await this.nodes();
    const liveIds = new Set(currentNodes.filter(node => !node.ignored).map(node => node.backendDOMNodeId));
    for (const [index, id] of this.indexes) if (!liveIds.has(id)) this.indexes.delete(index);
    for (const node of currentNodes) {
      if (node.ignored || !node.backendDOMNodeId || !node.role?.value) continue;
      const role = node.role.value;
      if (['InlineTextBox', 'LineBreak', 'none', 'generic'].includes(role)) continue;
      let index = [...this.indexes].find(([, id]) => id === node.backendDOMNodeId)?.[0];
      if (index === undefined) { index = this.nextIndex++; this.indexes.set(index, node.backendDOMNodeId); }
      lines.push(`[${index}] ${role} ${JSON.stringify(node.name?.value ?? '')}`);
    }
    const text = lines.join('\n');
    const previous = this.previousState;
    this.previousState = text;
    if (full || !previous) return text;
    if (previous === text) return 'No accessibility-tree change.';
    const before = new Set(previous.split('\n')), after = new Set(lines);
    return ['Removed:', ...[...before].filter(line => !after.has(line)), 'Added:', ...lines.filter(line => !before.has(line))].join('\n');
  }
  private async resolve(backendNodeId: number) {
    const result = await this.cdp<{ object: RemoteObject }>('DOM.resolveNode', { backendNodeId });
    if (!result.object.objectId) throw new Error('The accessibility target is stale. Read fresh state.');
    return result.object.objectId;
  }
  private async call<T>(objectId: string, functionDeclaration: string, args: unknown[] = []): Promise<T> {
    const result = await this.cdp<RuntimeReply>('Runtime.callFunctionOn', { objectId, functionDeclaration, arguments: args.map(value => ({ value })), returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'Browser element operation failed.');
    return result.result?.value as T;
  }
  private async release(ids: string[]) { await Promise.all(ids.map(objectId => this.cdp('Runtime.releaseObject', { objectId }).catch(() => undefined))); }
  private async objects(locator: BrowserLocator): Promise<string[]> {
    let ids: string[];
    if (locator.kind === 'role') {
      const name = locator.name;
      const matches = (actual: string) => name === undefined || (typeof name === 'string'
        ? locator.exact ? actual === name : actual.toLowerCase().includes(name.toLowerCase())
        : new RegExp(name.source, name.flags).test(actual));
      const nodes = (await this.nodes()).filter(node => !node.ignored && node.role?.value === locator.value && node.backendDOMNodeId && matches(node.name?.value ?? ''));
      ids = await Promise.all(nodes.map(node => this.resolve(node.backendDOMNodeId!)));
    } else {
      const evaluated = await this.cdp<RuntimeReply>('Runtime.evaluate', { expression: `(${queryElements.toString()})(${JSON.stringify(locator)})` });
      if (evaluated.exceptionDetails) throw new Error(evaluated.exceptionDetails.exception?.description ?? 'Invalid browser locator.');
      const arrayId = evaluated.result?.objectId;
      if (!arrayId) return [];
      try {
        const properties = await this.cdp<{ result: Array<{ name: string; value?: RemoteObject }> }>('Runtime.getProperties', { objectId: arrayId, ownProperties: true });
        ids = properties.result.filter(property => /^\d+$/u.test(property.name) && property.value?.objectId).map(property => property.value!.objectId!);
      } finally { await this.release([arrayId]); }
    }
    if (locator.index === undefined) return ids;
    const chosen = ids.at(locator.index);
    await this.release(ids.filter(id => id !== chosen));
    return chosen ? [chosen] : [];
  }
  private async visible(id: string) { return this.call<boolean>(id, `function() { const rect = this.getBoundingClientRect(); const style = getComputedStyle(this); return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'; }`); }
  private async input(objectId: string, operation: string, value?: string, direction?: string, pages = 1) {
    if (!await this.visible(objectId)) throw new Error('The browser target is not visible.');
    if (operation !== 'scroll' && !await this.call<boolean>(objectId, `function() { return !this.disabled && this.getAttribute('aria-disabled') !== 'true' && !this.readOnly; }`)) throw new Error('The browser target is disabled or read-only.');
    const bounds = await this.call<{ x: number; y: number; height: number }>(objectId, `function() { this.scrollIntoView({block:'nearest',inline:'nearest'}); const r=this.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2,height:innerHeight}; }`);
    if (operation === 'click') { await this.bridge.commandEmbeddedBrowser({ action: 'click', tabId: this.tabId, x: bounds.x, y: bounds.y }); return; }
    if (operation === 'scroll') {
      const horizontal = direction === 'left' || direction === 'right';
      const distance = bounds.height * pages * (direction === 'up' || direction === 'left' ? -1 : 1);
      await this.bridge.commandEmbeddedBrowser({ action: 'scroll', tabId: this.tabId, x: bounds.x, y: bounds.y, deltaX: horizontal ? distance : 0, deltaY: horizontal ? 0 : distance }); return;
    }
    await this.call(objectId, operation === 'fill'
      ? `function() { this.focus(); if (typeof this.select === 'function') this.select(); else if (this.isContentEditable) { const range=document.createRange(); range.selectNodeContents(this); const selection=getSelection(); selection.removeAllRanges(); selection.addRange(range); } else throw new Error('The target is not editable.'); }`
      : `function() { this.focus(); }`);
    await this.bridge.commandEmbeddedBrowser(operation === 'key' ? { action: 'key', tabId: this.tabId, key: value ?? '' } : { action: 'type', tabId: this.tabId, text: value ?? '' });
  }
  private async locator(request: Extract<BrowserScriptRequest, { method: 'locator' }>) {
    const started = performance.now();
    for (;;) {
      this.ensureOpen();
      const ids = await this.objects(request.locator);
      try {
        if (request.operation === 'count') return ids.length;
        if (request.operation === 'texts') return await Promise.all(ids.map(id => this.call<string>(id, 'function() { return this.textContent ?? ""; }')));
        if (request.operation === 'wait') {
          const visible = ids.length === 1 && await this.visible(ids[0]!);
          const state = request.state ?? 'visible';
          if (state === 'attached' ? ids.length > 0 : state === 'detached' ? ids.length === 0 : state === 'visible' ? visible : !visible) return;
        } else {
          if (ids.length > 1) throw new Error(`Strict locator matched ${ids.length} elements; use nth() or a more specific locator.`);
          const id = ids[0];
          if (!id) {
            if (request.operation === 'visible' || request.operation === 'enabled') return false;
          } else {
            if (request.operation === 'visible') return await this.visible(id);
            if (request.operation === 'enabled') return await this.call<boolean>(id, 'function() { return !this.disabled && this.getAttribute("aria-disabled") !== "true"; }');
            if (request.operation === 'innerText') return await this.call<string>(id, 'function() { return this.innerText ?? this.textContent ?? ""; }');
            if (request.operation === 'textContent') return await this.call<string | null>(id, 'function() { return this.textContent; }');
            if (request.operation === 'attribute') return await this.call<string | null>(id, 'function(name) { return this.getAttribute(name); }', [request.value]);
            await this.input(id, request.operation, request.value); return;
          }
        }
      } finally { await this.release(ids); }
      if (request.timeoutMs !== undefined && performance.now() - started >= request.timeoutMs) throw new Error(`Locator ${request.operation} did not reach the requested state within timeoutMs.`);
      // Chromium's next animation frame is the observation boundary, not a guessed retry delay.
      await Promise.race([this.stopped, this.cdp('Runtime.evaluate', { expression: 'new Promise(resolve => requestAnimationFrame(() => resolve(null)))', awaitPromise: true })]);
    }
  }
  async invoke(raw: unknown): Promise<unknown> {
    this.ensureOpen();
    const parsed = BrowserScriptRequestSchema.safeParse(raw);
    if (!parsed.success) throw new Error(`Invalid browser request: ${describeZodIssues(parsed.error)}.`);
    const request = parsed.data;
    await this.page();
    if (request.method === 'metadata') return this.page();
    if (request.method === 'ax') return this.snapshot(request.disableDiffing ?? false);
    if (request.method === 'navigation') { await this.bridge.commandEmbeddedBrowser({ action: request.action, tabId: this.tabId }); return; }
    if (request.method === 'locator') return this.locator(request);
    if (request.method === 'target') {
      if (Array.isArray(request.target)) {
        if (request.operation === 'click') return this.bridge.commandEmbeddedBrowser({ action: 'click', tabId: this.tabId, x: request.target[0], y: request.target[1] }).then(() => undefined);
        if (request.operation !== 'scroll') throw new Error('Coordinate targets support click and scroll only.');
        const horizontal = request.direction === 'left' || request.direction === 'right';
        const value = await this.bridge.commandEmbeddedBrowser({ action: 'evaluate', tabId: this.tabId, expression: 'innerHeight' });
        const height = value.kind === 'value' && typeof value.value === 'number' ? value.value : 0;
        const distance = height * (request.pages ?? 1) * (request.direction === 'up' || request.direction === 'left' ? -1 : 1);
        await this.bridge.commandEmbeddedBrowser({ action: 'scroll', tabId: this.tabId, x: request.target[0], y: request.target[1], deltaX: horizontal ? distance : 0, deltaY: horizontal ? 0 : distance }); return;
      }
      if (request.target === null) {
        if (request.operation !== 'type' && request.operation !== 'key') throw new Error('Null targets support typing and keys only.');
        await this.bridge.commandEmbeddedBrowser(request.operation === 'key' ? { action: 'key', tabId: this.tabId, key: request.value ?? '' } : { action: 'type', tabId: this.tabId, text: request.value ?? '' }); return;
      }
      const node = this.indexes.get(request.target);
      if (node === undefined) throw new Error('Unknown accessibility index. Read fresh state.');
      const id = await this.resolve(node);
      try { return await this.input(id, request.operation, request.value, request.direction, request.pages); } finally { await this.release([id]); }
    }
    if (request.action.kind === 'browser.script' || request.action.kind === 'browser.script_reset' || !request.action.kind.startsWith('browser.')) throw new Error('This operation is not a browser capability.');
    const outcome = await this.executor.execute(request.action);
    if (!outcome.ok) throw new Error(`${outcome.code}: ${outcome.message}`);
    return outcome.result;
  }
}
