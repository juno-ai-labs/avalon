// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadApollo, runsApollo } from '../src/apollo-loader';

afterEach(() => {
  document.head.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('Apollo marketing-page tracking', () => {
  it('covers every production marketing page, including new pages', () => {
    expect(['/', '/index.html', '/canvases/', '/sidekicks/', '/compare/notion/', '/blog/', '/help/', '/trust/', '/some-new-page/']
      .map((path) => runsApollo('production', path, false))).toEqual([true, true, true, true, true, true, true, true, true]);
  });

  it('excludes credential paths in any case, not-found pages, local development and previews', () => {
    expect(['/download/', '/invite/', '/auth/desktop/', '/slack/link/', '/open/', '/app/workstreams/id', '/404.html', '/APP/id', '/download']
      .map((path) => runsApollo('production', path, false))).toEqual([false, false, false, false, false, false, false, false, false]);
    expect([runsApollo('production', '/invte/', true), runsApollo('development', '/', false), runsApollo('staging', '/', false)])
      .toEqual([false, false, false]);
  });

  it('loads asynchronously and initializes the supplied Apollo app after load', () => {
    const onLoad = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('trackingFunctions', { onLoad });
    loadApollo();
    const script = document.head.querySelector('script')!;
    expect(script.src).toMatch(/^https:\/\/assets\.apollo\.io\/micro\/website-tracker\/tracker\.iife\.js\?nocache=/u);
    expect(script.async).toBe(true);
    expect(script.defer).toBe(true);
    expect(onLoad).not.toHaveBeenCalled();
    script.dispatchEvent(new Event('load'));
    expect(onLoad).toHaveBeenCalledExactlyOnceWith({ appId: '6ad67a1c7cdf770018b4f9bc' });
  });
});
