import type { BrowserLocator } from './browser-script-protocol';

/** Self-contained: installed in a sandboxed orchestration WebContents, never Rally's renderer. */
export function installBrowserScriptRuntime(tabId: string, documentation: string): void {
  type Image = { mimeType: 'image/jpeg'; data: string; width: number; height: number };
  type Page = { id: string; title: string; url: string };
  const host = globalThis as typeof globalThis & {
    __rallyInvoke(payload: string): void;
    __rallyReply(id: string, answer: { value?: unknown; error?: string }): void;
    __rallyOutput: Array<{ type: 'text'; text: string } | (Image & { type: 'image' })>;
  };
  const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
  const images = new WeakMap<Uint8Array, Image>();
  let sequence = 0;
  let documented = false;
  const rpc = <T>(method: string, args: Record<string, unknown> = {}): Promise<T> => new Promise((resolve, reject) => {
    const id = String(++sequence);
    pending.set(id, { resolve: (value) => resolve(value as T), reject });
    host.__rallyInvoke(JSON.stringify({ id, request: { ...args, method } }));
  });
  host.__rallyReply = (id, answer) => {
    const waiter = pending.get(id);
    if (!waiter) return;
    pending.delete(id);
    if (answer.error !== undefined) waiter.reject(new Error(answer.error)); else waiter.resolve(answer.value);
  };
  host.__rallyOutput = [];
  const write = (value: unknown) => {
    const text = typeof value === 'string' ? value : JSON.stringify(value, (_key, item: unknown) => {
      if (item instanceof Promise) throw new Error('Await the browser operation before emitting its result.');
      return item;
    });
    host.__rallyOutput.push({ type: 'text', text: text ?? String(value) });
  };
  const emitImage = (value: Uint8Array) => {
    const image = images.get(value);
    if (!image) throw new Error('emitImage expects screenshot bytes returned by this browser runtime.');
    host.__rallyOutput.push({ type: 'image', ...image });
  };
  const describe = () => { if (!documented) { documented = true; write(documentation); } };
  const metadata = () => rpc<Page>('metadata');
  const matcher = (value: string | RegExp | undefined) => value instanceof RegExp ? { source: value.source, flags: value.flags } : value;
  class Locator {
    constructor(private readonly selector: BrowserLocator) {}
    private invoke<T>(operation: string, args: Record<string, unknown> = {}) { return rpc<T>('locator', { locator: this.selector, operation, ...args }); }
    first() { return this.nth(0); }
    last() { return this.nth(-1); }
    nth(index: number) { return new Locator({ ...this.selector, index }); }
    count() { return this.invoke<number>('count'); }
    allTextContents(options: { timeoutMs?: number } = {}) { return this.invoke<string[]>('texts', options); }
    innerText(options: { timeoutMs?: number } = {}) { return this.invoke<string>('innerText', options); }
    textContent(options: { timeoutMs?: number } = {}) { return this.invoke<string | null>('textContent', options); }
    getAttribute(name: string, options: { timeoutMs?: number } = {}) { return this.invoke<string | null>('attribute', { ...options, value: name }); }
    isVisible() { return this.invoke<boolean>('visible'); }
    isEnabled() { return this.invoke<boolean>('enabled'); }
    click(options: { timeoutMs?: number } = {}) { return this.invoke<void>('click', options); }
    fill(value: string, options: { timeoutMs?: number } = {}) { return this.invoke<void>('fill', { ...options, value }); }
    type(value: string, options: { timeoutMs?: number } = {}) { return this.invoke<void>('type', { ...options, value }); }
    press(value: string, options: { timeoutMs?: number } = {}) { return this.invoke<void>('key', { ...options, value }); }
    waitFor(options: { state: 'attached' | 'detached' | 'visible' | 'hidden'; timeoutMs?: number }) { return this.invoke<void>('wait', options); }
  }
  const byText = (kind: BrowserLocator['kind'], value: string | RegExp, options: { exact?: boolean } = {}) =>
    new Locator({ kind, value: typeof value === 'string' ? value : '', ...(value instanceof RegExp ? { name: matcher(value) } : {}), ...options });
  const tab = {
    id: tabId,
    url: async () => (await metadata()).url,
    title: async () => (await metadata()).title,
    goto: (url: string) => rpc('action', { action: { kind: 'browser.navigate', url } }).then(() => undefined),
    back: () => rpc('navigation', { action: 'back' }).then(() => undefined),
    forward: () => rpc('navigation', { action: 'forward' }).then(() => undefined),
    reload: () => rpc('navigation', { action: 'reload' }).then(() => undefined),
    async getAXState(options: { emit?: boolean; disableDiffing?: boolean } = {}) {
      const state = await rpc<string>('ax', { ...(options.disableDiffing !== undefined ? { disableDiffing: options.disableDiffing } : {}) });
      if (options.emit !== false) write(state);
      return state;
    },
    async getScreenshot(options: { emit?: boolean } = {}) {
      const image = await rpc<Image>('action', { action: { kind: 'browser.screenshot' } });
      const bytes = Uint8Array.from(atob(image.data), (character) => character.charCodeAt(0));
      images.set(bytes, image);
      if (options.emit !== false) emitImage(bytes);
      return bytes;
    },
    async getAXStateAndScreenshot(options: { emit?: boolean; disableDiffing?: boolean } = {}) {
      const state = await tab.getAXState({ ...options, emit: false });
      const screenshot = await tab.getScreenshot({ emit: false });
      if (options.emit !== false) { write(state); emitImage(screenshot); }
      return { state, screenshot };
    },
    click(target: number | [number, number], options: { mouseButton?: 'left'; clickCount?: 1 } = {}) {
      if ((options.mouseButton !== undefined && options.mouseButton !== 'left') || (options.clickCount !== undefined && options.clickCount !== 1)) throw new Error('Only one left click is supported.');
      return rpc('target', { operation: 'click', target }).then(() => undefined);
    },
    scroll(target: number | [number, number], direction: 'up' | 'down' | 'left' | 'right', pages?: number) { return rpc('target', { operation: 'scroll', target, direction, ...(pages !== undefined ? { pages } : {}) }).then(() => undefined); },
    setValue: (target: number, value: string) => rpc('target', { operation: 'fill', target, value }).then(() => undefined),
    typeText: (target: number | null, value: string) => rpc('target', { operation: 'type', target, value }).then(() => undefined),
    paste(target: number | null, value: string, options: { format?: 'text' } = {}) {
      if (options.format !== undefined && options.format !== 'text') throw new Error('Only plain-text paste is supported.');
      return rpc('target', { operation: 'type', target, value }).then(() => undefined);
    },
    pressKey: (target: number | null, value: string) => rpc('target', { operation: 'key', target, value }).then(() => undefined),
    playwright: {
      domSnapshot: () => rpc<string>('ax', { disableDiffing: true }),
      getByRole: (value: string, options: { name?: string | RegExp; exact?: boolean } = {}) => new Locator({ kind: 'role', value, ...(options.name !== undefined ? { name: matcher(options.name) } : {}), ...(options.exact !== undefined ? { exact: options.exact } : {}) }),
      getByText: (value: string | RegExp, options?: { exact?: boolean }) => byText('text', value, options),
      getByLabel: (value: string | RegExp, options?: { exact?: boolean }) => byText('label', value, options),
      getByPlaceholder: (value: string | RegExp, options?: { exact?: boolean }) => byText('placeholder', value, options),
      getByTestId: (value: string) => byText('testid', value, { exact: true }),
      locator: (value: string) => byText('css', value),
    },
  };
  const bind = async (reference: string | { url?: string; mention?: string }, options: { browser?: string } = {}) => {
    if (options.browser !== undefined && options.browser !== 'iab') throw new Error('Only the pinned iab browser is available.');
    const page = await metadata();
    let matches = typeof reference === 'string' ? reference === tabId : reference.url !== undefined && reference.url === page.url;
    if (typeof reference !== 'string' && reference.mention) {
      const mention = new URL(reference.mention);
      matches = mention.protocol === 'plugin:' && mention.searchParams.get('mention') === 'tab-v1'
        && mention.searchParams.get('tabId') === tabId
        && (!mention.searchParams.has('url') || mention.searchParams.get('url') === page.url)
        && (!mention.searchParams.has('browserId') || mention.searchParams.get('browserId') === 'iab');
    }
    if (!matches) throw new Error('The requested tab is not the pinned tab or its reference is stale.');
    describe();
    await tab.getAXState();
    return tab;
  };
  const tabs = async () => [await metadata()];
  const browser = { browserId: 'iab', documentation: async () => documentation, tabs: { list: tabs, get: (id: string) => bind(id), selected: async () => bind(tabId) } };
  const browsers = async () => [{ id: 'iab', name: 'Rally Browser', type: 'iab', tabs: await tabs() }];
  const observe = async <T>(read: () => Promise<T>, options: { emit?: boolean } = {}) => { describe(); const result = await read(); if (options.emit !== false) write(result); return result; };
  Object.assign(host, {
    nodeRepl: { write, emitImage },
    cua: {
      getState: (options?: { emit?: boolean }) => observe(async () => ({ apps: [], browsers: await browsers() }), options),
      getBrowser: async (options: { id?: string; url?: string } = {}) => {
        if ((options.id !== undefined && options.id !== 'iab') || (options.url !== undefined && options.url !== (await metadata()).url)) throw new Error('The requested browser is unavailable.');
        describe(); return browser;
      },
      getTab: bind,
      listBrowsers: (options?: { emit?: boolean }) => observe(browsers, options),
      listTabs: (options: { browser?: string; emit?: boolean } = {}) => {
        if (options.browser !== undefined && options.browser !== 'iab') throw new Error('The requested browser is unavailable.');
        return observe(tabs, options);
      },
      rewriteDocumentation: async () => write(documentation),
    },
    rally: {
      pageScript: (body: string | (() => unknown)) => {
        if (typeof body === 'string' && /^(?:async\s+)?(?:function\b|(?:\([^)]*\)|[\w$]+)\s*=>)/u.test(body.trim())) {
          let expression = false;
          try { new Function(`return (${body.trim().replace(/;$/u, '')});`); expression = true; } catch { /* A body may begin with a helper declaration. */ }
          if (expression) throw new Error('pageScript received a function as a string. Pass the function directly: await rally.pageScript(async () => { return value; }), or pass an async function body string: "return value;".');
        }
        const script = typeof body === 'function' ? `return await (${body.toString()})();` : body;
        return rpc('action', { action: { kind: 'browser.evaluate', script } });
      },
      network: { list: (options: Record<string, unknown> = {}) => rpc('action', { action: { kind: 'browser.network_list', ...options } }), read: (options: Record<string, unknown>) => rpc('action', { action: { kind: 'browser.network_read', ...options } }) },
      load: (options: Record<string, unknown>) => rpc('action', { action: { kind: 'browser.load', ...options } }),
    },
  });
}
