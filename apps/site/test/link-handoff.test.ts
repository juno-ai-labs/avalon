// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The page's own markup, so the test reads what the built page shows.
// Vitest runs the site's suite from `apps/site`; jsdom gives `import.meta.url` no file scheme.
const page = readFileSync(join(process.cwd(), 'app/open/index.html'), 'utf8');
const body = /<body>([\s\S]*)<\/body>/u.exec(page)![1]!.replace(/<script[\s\S]*?<\/script>/gu, '');

beforeEach(() => {
  vi.resetModules();
  // Telemetry and the name lookup are network; neither decides what is shown.
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 404 })));
  document.body.innerHTML = body;
});

const visible = (selector: string): boolean => !document.querySelector<HTMLElement>(selector)!.hidden;

describe('the link handoff page', () => {
  it('says a retired Thread link names something that no longer exists, and offers Rally', async () => {
    history.replaceState(null, '', '/app/global/1111117Hxt1fAWDjN7TW/s/1111117Hxt1fAWDjN7TX/c/1111117Hxt1fAWDjN7TY');
    await import('../src/link-handoff');
    expect(document.querySelector('#link-title')!.textContent).toBe('This link is to something that no longer exists');
    expect(visible('#link-gone')).toBe(true);
    expect(visible('#open-rally')).toBe(false);
    expect(visible('#link-error')).toBe(false);
    const browser = document.querySelector<HTMLAnchorElement>('#open-browser')!;
    expect(browser.hidden).toBe(false);
    expect(browser.textContent).toBe('Go to Rally');
    expect(browser.href).toBe('http://localhost:8794/');
  });

  it('opens a Canvas link and says nothing of a retired one', async () => {
    history.replaceState(null, '', '/app/global/1111117Hxt1fAWDjN7TW/cv/1111117Hxt1fAWDjN7TX/');
    await import('../src/link-handoff');
    expect(document.querySelector('#link-title')!.textContent).toBe('Opening in Rally');
    expect(visible('#link-gone')).toBe(false);
    expect(document.querySelector<HTMLAnchorElement>('#open-browser')!.href)
      .toBe('http://localhost:8794/app/global/1111117Hxt1fAWDjN7TW/cv/1111117Hxt1fAWDjN7TX/');
  });

  it('opens a message link at its message, in the app and on the web', async () => {
    const turn = '00000000-0000-7000-8000-0000000000aa';
    history.replaceState(null, '', `/app/global/1111117Hxt1fAWDjN7TW/cv/1111117Hxt1fAWDjN7TX/?turn=${turn}&sequence=4`);
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)');
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
    await import('../src/link-handoff');
    expect(document.querySelector<HTMLAnchorElement>('#open-browser')!.href)
      .toBe(`http://localhost:8794/app/global/1111117Hxt1fAWDjN7TW/cv/1111117Hxt1fAWDjN7TX/?turn=${turn}&sequence=4`);
    expect(document.querySelector<HTMLAnchorElement>('#open-rally')!.href)
      .toBe(`rallywithai://workspace/global/1111117Hxt1fAWDjN7TW/canvases/1111117Hxt1fAWDjN7TX?turn=${turn}&sequence=4`);
  });

  it('opens a link whose message query is malformed on the plain Canvas', async () => {
    history.replaceState(null, '', '/app/global/1111117Hxt1fAWDjN7TW/cv/1111117Hxt1fAWDjN7TX/?turn=not-a-turn&sequence=0');
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)');
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
    await import('../src/link-handoff');
    expect(visible('#link-error')).toBe(false);
    expect(document.querySelector<HTMLAnchorElement>('#open-browser')!.href)
      .toBe('http://localhost:8794/app/global/1111117Hxt1fAWDjN7TW/cv/1111117Hxt1fAWDjN7TX/');
    expect(document.querySelector<HTMLAnchorElement>('#open-rally')!.href)
      .toBe('rallywithai://workspace/global/1111117Hxt1fAWDjN7TW/canvases/1111117Hxt1fAWDjN7TX');
  });
});
