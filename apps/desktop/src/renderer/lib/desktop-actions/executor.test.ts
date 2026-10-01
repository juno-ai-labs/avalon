import { describe, expect, it, vi } from 'vitest';
import type { EmbeddedBrowserCommand, EmbeddedBrowserResult, EmbeddedBrowserTab } from '../../../common/embedded-browser';
import { providerSiteAllows } from '../browser-conversation';
import { createDesktopActionExecutor } from './executor';
import { DesktopActionStore } from './store';

const tab = (id: string, url: string): EmbeddedBrowserTab => ({
  id, title: 'Chat', url, loading: false, canGoBack: false, canGoForward: false, favicon: null,
});

function harness(url = 'https://claude.ai/chat/1') {
  const tabs = [tab('pinned', url), tab('other', 'https://example.com/')];
  const commandEmbeddedBrowser = vi.fn(async (command: EmbeddedBrowserCommand): Promise<EmbeddedBrowserResult> => {
    if (command.action === 'navigate') tabs[0] = tab('pinned', command.url);
    if (command.action === 'evaluate') {
      return { kind: 'value', value: { ok: true, value: 3, stored: [{ handle: 'h1', kind: 'json', name: 'm', mimeType: 'application/json', size: 2, data: '[]' }], url, title: 'Chat' } };
    }
    return { kind: 'state', state: { tabs, activeTabId: 'pinned' } };
  });
  const store = new DesktopActionStore();
  const executor = createDesktopActionExecutor({
    bridge: { commandEmbeddedBrowser, getEmbeddedBrowserState: vi.fn(async () => ({ tabs, activeTabId: 'pinned' })) },
    tabId: 'pinned',
    siteAllows: (value) => providerSiteAllows('claude', value),
    store,
  });
  return { executor, commandEmbeddedBrowser, store, tabs };
}

describe('desktop action executor', () => {
  it('runs every action on the pinned tab and keeps what page script stored', async () => {
    const { executor, commandEmbeddedBrowser, store } = harness();
    await expect(executor.execute({ kind: 'browser.evaluate', script: 'return 3' })).resolves.toEqual({
      ok: true, result: { url: 'https://claude.ai/chat/1', title: 'Chat', value: 3,
        stored: [{ handle: 'h1', kind: 'json', name: 'm', mimeType: 'application/json', size: 2 }] },
    });
    expect(store.json('h1')).toEqual([]);
    await executor.execute({ kind: 'browser.click', x: 10, y: 20 });
    expect(commandEmbeddedBrowser.mock.calls.map(([command]) => 'tabId' in command ? command.tabId : null)).toEqual(['pinned', 'pinned']);
  });

  it('refuses sites the work may not use, before and after an action', async () => {
    const { executor, commandEmbeddedBrowser, tabs } = harness();
    await expect(executor.execute({ kind: 'browser.navigate', url: 'https://example.com/' }))
      .resolves.toMatchObject({ ok: false, code: 'origin_not_allowed' });
    await expect(executor.execute({ kind: 'browser.load', url: 'https://example.com/file.pdf' }))
      .resolves.toMatchObject({ ok: false, code: 'origin_not_allowed' });
    expect(commandEmbeddedBrowser).not.toHaveBeenCalled();
    // A page that navigated itself away fails the next action, but navigation may bring it back.
    tabs[0] = tab('pinned', 'https://example.com/');
    await expect(executor.execute({ kind: 'browser.snapshot' })).resolves.toMatchObject({ ok: false, code: 'origin_not_allowed' });
    await expect(executor.execute({ kind: 'browser.navigate', url: 'https://claude.ai/chat/1' })).resolves.toMatchObject({ ok: true });
  });

  it('answers a closed tab, an unknown action and an unhandled kind without throwing', async () => {
    const { executor, tabs } = harness();
    await expect(executor.execute({ kind: 'browser.open' })).resolves.toMatchObject({ ok: false, code: 'invalid_action' });
    await expect(executor.execute({ kind: 'session_import.fail', reason: 'page_unavailable' }))
      .resolves.toMatchObject({ ok: false, code: 'invalid_action' });
    tabs.splice(0, 1);
    await expect(executor.execute({ kind: 'browser.screenshot' })).resolves.toMatchObject({ ok: false, code: 'tab_closed' });
  });
});
