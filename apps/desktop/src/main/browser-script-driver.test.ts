import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserScriptDriver } from './browser-script-driver';
import type { EmbeddedBrowserCommand, EmbeddedBrowserResult } from '../common/embedded-browser';

function fixture() {
  let nodes = [{ backendDOMNodeId: 10, role: { value: 'button' }, name: { value: 'Expand conversation' } }];
  let visible = true;
  const commands: EmbeddedBrowserCommand[] = [];
  const bridge = {
    getEmbeddedBrowserState: async () => ({ activeTabId: 'pinned', tabs: [{ id: 'pinned', title: 'Chat', url: 'https://claude.ai/chat/1', loading: false, canGoBack: false, canGoForward: false, favicon: null }] }),
    commandEmbeddedBrowser: vi.fn(async (command: EmbeddedBrowserCommand): Promise<EmbeddedBrowserResult> => {
      commands.push(command);
      if (command.action !== 'cdp') return { kind: 'state', state: await bridge.getEmbeddedBrowserState() };
      let value: unknown;
      if (command.method === 'Accessibility.getFullAXTree') value = { nodes };
      else if (command.method === 'DOM.resolveNode') value = { object: { objectId: `node-${command.params?.backendNodeId}` } };
      else if (command.method === 'Runtime.callFunctionOn') {
        const body = String(command.params?.functionDeclaration);
        value = { result: { value: body.includes('getBoundingClientRect') ? (body.includes('scrollIntoView') ? { x: 15, y: 20, height: 800 } : visible) : true } };
      } else value = {};
      return { kind: 'value', value };
    }),
  };
  return { bridge, driver: new BrowserScriptDriver('pinned', bridge), commands, setNodes: (next: typeof nodes) => { nodes = next; }, hide: () => { visible = false; } };
}

describe('pinned browser script driver', () => {
  it('resolves an accessibility name to native input on the pinned tab', async () => {
    const { driver, commands } = fixture();
    await driver.invoke({ method: 'locator', locator: { kind: 'role', value: 'button', name: 'Expand conversation', exact: true }, operation: 'click' });
    expect(commands.filter(command => command.action === 'click')).toEqual([{ action: 'click', tabId: 'pinned', x: 15, y: 20 }]);
  });

  it('rejects ambiguous semantic targets before sending input', async () => {
    const { driver, commands, setNodes } = fixture();
    setNodes([{ backendDOMNodeId: 10, role: { value: 'button' }, name: { value: 'Expand' } }, { backendDOMNodeId: 11, role: { value: 'button' }, name: { value: 'Expand' } }]);
    await expect(driver.invoke({ method: 'locator', locator: { kind: 'role', value: 'button' }, operation: 'click' })).rejects.toThrow('matched 2 elements');
    expect(commands.filter(command => command.action === 'click')).toEqual([]);
  });

  it('drops removed AX targets without reusing their indexes', async () => {
    const { driver, setNodes } = fixture();
    expect(await driver.invoke({ method: 'ax' })).toBe('URL: https://claude.ai/chat/1\nTitle: Chat\n[0] button "Expand conversation"');
    setNodes([{ backendDOMNodeId: 11, role: { value: 'button' }, name: { value: 'Download' } }]);
    expect(await driver.invoke({ method: 'ax' })).toBe('Removed:\n[0] button "Expand conversation"\nAdded:\n[1] button "Download"');
    await expect(driver.invoke({ method: 'target', target: 0, operation: 'click' })).rejects.toThrow('Unknown accessibility index');
  });

  it('reports declared protocol fields and refuses recursive or import actions', async () => {
    const { driver } = fixture();
    await expect(driver.invoke({ method: 'target', target: 'bad', operation: 'click' })).rejects.toThrow('target');
    await expect(driver.invoke({ method: 'locator', locator: { kind: 'css', value: 'input' }, operation: 'fill' })).rejects.toThrow('value');
    await expect(driver.invoke({ method: 'action', action: { kind: 'browser.script', code: '1' } })).rejects.toThrow('not a browser capability');
    await expect(driver.invoke({ method: 'action', action: { kind: 'session_import.fail', reason: 'unreadable' } })).rejects.toThrow('not a browser capability');
  });

  afterEach(() => vi.useRealTimers());

  it.each(['visible', 'hidden'])("rejects ambiguous %s waits", async state => {
    const { driver, setNodes } = fixture();
    setNodes([{ backendDOMNodeId: 10, role: { value: 'button' }, name: { value: 'Expand' } }, { backendDOMNodeId: 11, role: { value: 'button' }, name: { value: 'Expand' } }]);
    await expect(driver.invoke({ method: 'locator', locator: { kind: 'role', value: 'button' }, operation: 'wait', state })).rejects.toThrow('matched 2 elements');
  });

  it('returns a repairable missing-target error without an implicit wait', async () => {
    const { driver, setNodes } = fixture();
    setNodes([]);
    await expect(driver.invoke({ method: 'locator', locator: { kind: 'role', value: 'button' }, operation: 'click' })).rejects.toThrow('matched no elements');
  });

  it('honors the caller deadline even when Chromium never paints a frame', async () => {
    vi.useFakeTimers();
    const { driver, bridge, setNodes } = fixture();
    setNodes([]);
    const command = bridge.commandEmbeddedBrowser.getMockImplementation()!;
    bridge.commandEmbeddedBrowser.mockImplementation(input => input.action === 'cdp' && input.method === 'Runtime.evaluate' ? new Promise(() => {}) : command(input));
    const call = driver.invoke({ method: 'locator', locator: { kind: 'role', value: 'button' }, operation: 'wait', timeoutMs: 25 });
    const rejected = expect(call).rejects.toThrow('within timeoutMs');
    await vi.advanceTimersByTimeAsync(25);
    await rejected;
  });

  it('does not send native input after disposal during bounds lookup', async () => {
    const { driver, bridge, commands } = fixture();
    const command = bridge.commandEmbeddedBrowser.getMockImplementation()!;
    let release!: (value: EmbeddedBrowserResult) => void;
    let started!: () => void;
    const bounds = new Promise<void>(resolve => { started = resolve; });
    bridge.commandEmbeddedBrowser.mockImplementation(input => {
      if (input.action === 'cdp' && String(input.params?.functionDeclaration).includes('scrollIntoView')) {
        started(); return new Promise(resolve => { release = resolve; });
      }
      return command(input);
    });
    const call = driver.invoke({ method: 'locator', locator: { kind: 'role', value: 'button' }, operation: 'click' });
    await bounds;
    driver.dispose();
    release({ kind: 'value', value: { result: { value: { x: 15, y: 20, height: 800 } } } });
    await expect(call).rejects.toThrow('runtime is closed');
    expect(commands.filter(input => input.action === 'click')).toEqual([]);
    expect(commands.filter(input => input.action === 'cdp' && input.method === 'Runtime.releaseObject')).toHaveLength(1);
  });

  it('closes a file stream without reading it after disposal during load', async () => {
    const { driver, bridge, commands } = fixture();
    const command = bridge.commandEmbeddedBrowser.getMockImplementation()!;
    let release!: (value: EmbeddedBrowserResult) => void;
    let started!: () => void;
    const loading = new Promise<void>(resolve => { started = resolve; });
    bridge.commandEmbeddedBrowser.mockImplementation(input => {
      if (input.action === 'cdp' && input.method === 'Page.getFrameTree') return Promise.resolve({ kind: 'value', value: { frameTree: { frame: { id: 'frame' } } } });
      if (input.action === 'cdp' && input.method === 'Network.loadNetworkResource') {
        started(); return new Promise(resolve => { release = resolve; });
      }
      return command(input);
    });
    const call = driver.invoke({ method: 'action', action: { kind: 'browser.load', url: 'https://claude.ai/file' } });
    await loading;
    driver.dispose();
    release({ kind: 'value', value: { resource: { stream: 'stream', success: true, httpStatusCode: 200 } } });
    await expect(call).rejects.toThrow('runtime is closed');
    expect(commands.filter(input => input.action === 'cdp' && input.method === 'IO.read')).toEqual([]);
    expect(commands.filter(input => input.action === 'cdp' && input.method === 'IO.close')).toEqual([{ action: 'cdp', tabId: 'pinned', method: 'IO.close', params: { handle: 'stream' } }]);
  });

  it('stops locator work when the runtime is disposed', async () => {
    const { driver } = fixture();
    driver.dispose();
    await expect(driver.invoke({ method: 'locator', locator: { kind: 'role', value: 'button' }, operation: 'wait' })).rejects.toThrow('runtime is closed');
  });
});
