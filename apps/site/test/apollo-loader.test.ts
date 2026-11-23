// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadApollo, runsApollo } from '../src/apollo-loader';

afterEach(() => {
  document.head.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('Apollo public-site tracking', () => {
  it.each(['/', '/index.html', '/canvases/', '/sidekicks/', '/for/recruiters/', '/marketplace/', '/blog/', '/help/', '/trust/privacy/', '/some-new-page/'])('covers production page %s', (path) => {
    expect(runsApollo('production', path, false, false)).toBe(true);
  });

  it.each(['/download/', '/invite/', '/auth/desktop/', '/slack/link/', '/open/', '/app/workstreams/id', '/404.html', '/APP/id', '/download'])('excludes credential or not-found path %s', (path) => {
    expect(runsApollo('production', path, false, false)).toBe(false);
  });

  it('excludes mistyped handoff links that land on the not-found page', () => {
    expect(runsApollo('production', '/invte/', true, false)).toBe(false);
  });

  it.each(['development', 'staging'] as const)('excludes %s visits', (environment) => {
    expect(runsApollo(environment, '/', false, false)).toBe(false);
  });

  it('honors Global Privacy Control', () => {
    expect(runsApollo('production', '/', false, true)).toBe(false);
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
