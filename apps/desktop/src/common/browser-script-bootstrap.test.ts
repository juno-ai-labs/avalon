import { describe, expect, it, vi } from 'vitest';
import { installBrowserScriptRuntime } from './browser-script-bootstrap';

function runtime() {
  const calls: unknown[] = [];
  const root = globalThis as typeof globalThis & {
    __rallyReply(id: string, result: { value?: unknown; error?: string }): void;
    __rallyOutput: Array<{ type: string; text?: string; data?: string }>;
    cua: { getState(): Promise<unknown>; getTab(id: string): Promise<{ playwright: { getByRole(role: string, options: { name: RegExp }): { nth(index: number): { fill(value: string): Promise<void> } } }; getScreenshot(options?: { emit: boolean }): Promise<Uint8Array> }> };
    nodeRepl: { write(value: unknown): void; emitImage(value: Uint8Array): void };
    rally: { pageScript(script: string | (() => unknown)): Promise<unknown> };
  };
  for (const name of ['__rallyReply', '__rallyOutput', 'cua', 'nodeRepl', 'rally']) vi.stubGlobal(name, undefined);
  vi.stubGlobal('__rallyInvoke', (payload: string) => {
    const { id, request } = JSON.parse(payload);
    calls.push(request);
    const value = request.method === 'metadata' ? { id: 'tab-1', title: 'Conversation', url: 'https://claude.ai/chat/1' }
      : request.method === 'ax' ? '[0] textbox "Search"'
      : request.action?.kind === 'browser.screenshot' ? { mimeType: 'image/jpeg', data: 'AQID', width: 3, height: 1 }
      : request.method === 'action' ? { value: 2, stored: [] } : undefined;
    queueMicrotask(() => root.__rallyReply(id, { value }));
  });
  installBrowserScriptRuntime('tab-1', 'Browser API documentation');
  return { root, calls };
}

describe('browser script API', () => {
  it('emits discovery documentation once and fresh state when binding the pinned tab', async () => {
    const { root } = runtime();
    await root.cua.getState();
    await root.cua.getTab('tab-1');
    expect(root.__rallyOutput).toEqual([
      { type: 'text', text: 'Browser API documentation' },
      { type: 'text', text: '{"apps":[],"browsers":[{"id":"iab","name":"Rally Browser","type":"iab","tabs":[{"id":"tab-1","title":"Conversation","url":"https://claude.ai/chat/1"}]}]}' },
      { type: 'text', text: '[0] textbox "Search"' },
    ]);
    await expect(root.cua.getTab('another-tab')).rejects.toThrow('not the pinned tab');
  });

  it('translates semantic locator chains and regex names into the closed browser protocol', async () => {
    const { root, calls } = runtime();
    const tab = await root.cua.getTab('tab-1');
    await tab.playwright.getByRole('textbox', { name: /Search/i }).nth(1).fill('find this');
    expect(calls.at(-1)).toEqual({ method: 'locator', locator: { kind: 'role', value: 'textbox', name: { source: 'Search', flags: 'i' }, index: 1 }, operation: 'fill', value: 'find this' });
  });

  it('emits native screenshot bytes once, and refuses arbitrary image bytes', async () => {
    const { root } = runtime();
    const tab = await root.cua.getTab('tab-1');
    root.__rallyOutput.splice(0);
    const image = await tab.getScreenshot({ emit: false });
    expect([...image]).toEqual([1, 2, 3]);
    expect(root.__rallyOutput).toEqual([]);
    root.nodeRepl.emitImage(image);
    expect(root.__rallyOutput).toEqual([{ type: 'image', mimeType: 'image/jpeg', data: 'AQID', width: 3, height: 1 }]);
    expect(() => root.nodeRepl.emitImage(new Uint8Array([1]))).toThrow('screenshot bytes');
  });

  it('requires awaited observations and leaves page extraction explicitly separate', async () => {
    const { root, calls } = runtime();
    expect(() => root.nodeRepl.write(Promise.resolve(2))).toThrow('Await the browser operation');
    root.nodeRepl.write(await root.rally.pageScript('return 2'));
    expect(calls.at(-1)).toEqual({ method: 'action', action: { kind: 'browser.evaluate', script: 'return 2' } });
    expect(root.__rallyOutput).toEqual([{ type: 'text', text: '{"value":2,"stored":[]}' }]);
  });

  it('invokes page callbacks and rejects function strings that would silently do nothing', async () => {
    const { root, calls } = runtime();
    await root.rally.pageScript(async () => { return 7; });
    const request = calls.at(-1) as { action: { script: string } };
    const run = new Function(`return (async () => { ${request.action.script} })();`);
    await expect(run()).resolves.toBe(7);
    expect(() => root.rally.pageScript('async () => { return 7; }')).toThrow('Pass the function directly');
    expect(() => root.rally.pageScript('() => { return 7; }')).toThrow('Pass the function directly');
  });
});
