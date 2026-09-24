// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

const openExternal = vi.fn(async () => undefined);
const commandEmbeddedBrowser = vi.fn(async () => ({ kind: 'state' }));
vi.mock('./platform', () => ({ desktopBridge: () => ({ openExternal, commandEmbeddedBrowser }) }));

const { renderHook } = await import('@testing-library/react');
const { captureLinkClicks, openLink, registerBrowserRailHost, useBrowserRailLinks } = await import('./browser-rail-links');
const { useUiStore } = await import('./ui-store');

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  openExternal.mockClear();
  commandEmbeddedBrowser.mockClear();
  Reflect.deleteProperty(window, 'rally');
  document.body.innerHTML = '';
});

function anchor(href: string): HTMLAnchorElement {
  const link = document.createElement('a');
  link.href = href;
  link.target = '_blank';
  link.textContent = 'link';
  document.body.append(link);
  return link;
}

describe('openLink', () => {
  it('sends a web link to the rail when a host is registered', async () => {
    const host = vi.fn();
    cleanups.push(registerBrowserRailHost(host));
    await openLink('https://example.com/a');
    expect(host).toHaveBeenCalledWith('https://example.com/a');
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('leaves other schemes, and every link without a host, on the openExternal path', async () => {
    const host = vi.fn();
    const unregister = registerBrowserRailHost(host);
    cleanups.push(unregister);
    await openLink('mailto:someone@example.com');
    unregister();
    await openLink('https://example.com/b');
    expect(host).not.toHaveBeenCalled();
    expect(openExternal.mock.calls).toEqual([['mailto:someone@example.com'], ['https://example.com/b']]);
  });
});

describe('captureLinkClicks', () => {
  it('opens an external anchor in the rail and prevents the window open', () => {
    const host = vi.fn();
    cleanups.push(registerBrowserRailHost(host), captureLinkClicks(document));
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    anchor('https://example.com/c').dispatchEvent(event);
    expect(host).toHaveBeenCalledWith('https://example.com/c');
    expect(event.defaultPrevented).toBe(true);
  });

  it('leaves a click a component already handled, and Rally’s own routes', () => {
    const host = vi.fn();
    cleanups.push(registerBrowserRailHost(host), captureLinkClicks(document));
    const handled = anchor('https://example.com/d');
    handled.addEventListener('click', (event) => event.preventDefault());
    handled.click();
    anchor(`${document.location.origin}/workstreams/1`).click();
    expect(host).not.toHaveBeenCalled();
  });
});

/** Mounts the hook; the returned unmount also runs in `afterEach` if a test fails first. */
function mountHost(enabled: boolean): () => void {
  const hook = renderHook(() => useBrowserRailLinks(enabled));
  let mounted = true;
  const unmount = (): void => {
    if (mounted) hook.unmount();
    mounted = false;
  };
  cleanups.push(unmount);
  return unmount;
}

describe('useBrowserRailLinks', () => {
  it('opens the rail on a tab for the link while enabled, and not when disabled', async () => {
    Object.defineProperty(window, 'rally', { configurable: true, value: {} });
    const unmountChannel = mountHost(true);
    await openLink('https://example.com/e');
    expect(useUiStore.getState()).toMatchObject({ railOpen: true, railVariant: 'browser' });
    expect(commandEmbeddedBrowser).toHaveBeenCalledWith({ action: 'open', url: 'https://example.com/e' });
    unmountChannel();

    const unmountSidekick = mountHost(false);
    await openLink('https://example.com/f');
    unmountSidekick();
    expect(commandEmbeddedBrowser).toHaveBeenCalledTimes(1);
    expect(openExternal).toHaveBeenCalledWith('https://example.com/f');
  });
});
