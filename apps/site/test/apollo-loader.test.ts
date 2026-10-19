// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadApollo, runsApollo } from '../src/apollo-loader';

afterEach(() => {
  document.head.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('Apollo landing-page tracking', () => {
  it('covers the homepage and every landing variant in production', () => {
    expect(['/', '/index.html', '/start-fast/', '/concepts/', '/concepts/horizon/', '/concepts/hero/']
      .map((path) => runsApollo('production', path))).toEqual([true, true, true, true, true, true]);
  });

  it('excludes other pages, handoffs, local development and previews', () => {
    expect(['/download/', '/invite/', '/auth/desktop/', '/slack/link/', '/open/', '/app/workstreams/id', '/404.html', '/trust/', '/blog/', '/help/', '/concepts/unknown/']
      .map((path) => runsApollo('production', path))).toEqual([false, false, false, false, false, false, false, false, false, false, false]);
    expect([runsApollo('development', '/'), runsApollo('staging', '/')]).toEqual([false, false]);
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
