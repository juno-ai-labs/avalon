// @vitest-environment jsdom
// @vitest-environment-options {"url": "https://rallywith.ai/?twclid=ad-click-1"}
import { expect, it, vi } from 'vitest';

it('hands an X ad click id to the pixel before the URL is cleaned, and reports download and sign-up clicks to X', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 503 })));
  document.body.innerHTML = '<a data-site-action="download-hero" href="#">Download the macOS app</a>'
    + '<a data-site-action="web-app-hero" href="https://app.rallywith.ai/">Sign up now</a>'
    + '<a data-site-action="sign-in-header" href="https://app.rallywith.ai/">Sign in</a>';
  // jsdom cannot follow a link to another origin.
  document.addEventListener('click', (event) => event.preventDefault());

  await import('../src/site-entry');

  expect(location.search).toBe('');
  const cookie = document.cookie.split('; ').find((entry) => entry.startsWith('_twclid='))!;
  expect(JSON.parse(decodeURIComponent(cookie.slice('_twclid='.length))).twclid).toBe('ad-click-1');

  for (const link of document.querySelectorAll('a')) link.click();
  expect((window as unknown as { twq: { queue: unknown[] } }).twq.queue).toEqual([
    ['config', 'rg7j5'],
    ['event', 'tw-rg7j5-rg7j6', {}],
    ['event', 'tw-rg7j5-ri4zl', {}],
    ['event', 'tw-rg7j5-ri4zl', {}],
  ]);
});
