// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

const openExternal = vi.fn(async () => undefined);
vi.mock('./platform', () => ({ desktopBridge: () => ({ openExternal }) }));

const { captureLinkClicks, openLink, registerBrowserRailHost } = await import('./browser-rail-links');

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  openExternal.mockClear();
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

  it('keeps other schemes, and every link without a host, external', async () => {
    const host = vi.fn();
    const unregister = registerBrowserRailHost(host);
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
