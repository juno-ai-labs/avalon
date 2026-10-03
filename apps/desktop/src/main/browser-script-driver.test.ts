import { describe, expect, it, vi } from 'vitest';
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
  return { driver: new BrowserScriptDriver('pinned', bridge), commands, setNodes: (next: typeof nodes) => { nodes = next; }, hide: () => { visible = false; } };
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

  it('stops locator work when the runtime is disposed', async () => {
    const { driver } = fixture();
    driver.dispose();
    await expect(driver.invoke({ method: 'locator', locator: { kind: 'role', value: 'button' }, operation: 'wait' })).rejects.toThrow('runtime is closed');
  });
});
