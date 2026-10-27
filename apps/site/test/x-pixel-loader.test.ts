// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { loadXPixel, reportXDownloadIntent, runsXPixel } from '../src/x-pixel-loader';

afterEach(() => {
  document.head.innerHTML = '';
  delete (window as { twq?: unknown }).twq;
  document.cookie = '_twclid=; max-age=0; path=/';
});

describe('which pages run the X pixel', () => {
  it('runs on marketing pages in production', () => {
    expect(['/', '/start-fast/', '/compare/notion/', '/blog/', '/help/', '/trust/privacy/']
      .map((path) => runsXPixel('production', path, false, false))).toEqual([true, true, true, true, true, true]);
  });

  it('never runs on handoff pages, the not-found page, or outside production', () => {
    expect(['/download/', '/invite/', '/auth/desktop/', '/slack/link/', '/open/', '/app/workstreams/abc']
      .map((path) => runsXPixel('production', path, false, false))).toEqual([false, false, false, false, false, false]);
    expect([runsXPixel('production', '/x/', true, false), runsXPixel('development', '/', false, false), runsXPixel('staging', '/', false, false)])
      .toEqual([false, false, false]);
  });

  it('never runs for a browser sending Global Privacy Control', () => {
    expect(runsXPixel('production', '/', false, true)).toBe(false);
  });
});

describe('loading the X pixel', () => {
  it('loads X\'s script once and queues the pixel config', () => {
    loadXPixel(null);
    loadXPixel(null);
    expect([...document.head.querySelectorAll('script')].map((script) => [script.src, script.async]))
      .toEqual([['https://static.ads-twitter.com/uwt.js', true]]);
    expect((window as unknown as { twq: { queue: unknown[] } }).twq.queue).toEqual([['config', 'rg7j5'], ['config', 'rg7j5']]);
  });

  it('hands the ad click id to the pixel in its cookie', () => {
    loadXPixel('click-123');
    const cookie = document.cookie.split('; ').find((entry) => entry.startsWith('_twclid='))!;
    expect(JSON.parse(decodeURIComponent(cookie.slice('_twclid='.length))).twclid).toBe('click-123');
  });
});

describe('reporting a download intent to X', () => {
  it('queues the download event once the pixel has loaded', () => {
    loadXPixel(null);
    reportXDownloadIntent();
    expect((window as unknown as { twq: { queue: unknown[] } }).twq.queue).toEqual([['config', 'rg7j5'], ['event', 'tw-rg7j5-rg7j6', {}]]);
  });

  it('does nothing on a page where the pixel did not load', () => {
    expect(() => reportXDownloadIntent()).not.toThrow();
    expect((window as { twq?: unknown }).twq).toBeUndefined();
  });
});
