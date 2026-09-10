// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { accessCopy } from '../src/access-copy';

beforeEach(() => { vi.resetModules(); document.body.innerHTML = ''; history.replaceState(null, '', '/'); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); delete window.turnstile; document.head.querySelectorAll('script[src*="challenges.cloudflare.com"]').forEach((script) => script.remove()); });

describe('early-access browser handlers', () => {
  it('hands a single valid fragment token to an explicit POST and removes it from history', async () => {
    const token = 'a'.repeat(64);
    history.replaceState(null, '', `/download/#token=${token}`);
    document.body.innerHTML = '<form id="download-form" method="post" hidden><input id="download-token"></form><p id="download-error" hidden></p>';
    await import('../src/download');
    const form = document.querySelector<HTMLFormElement>('form')!;
    expect(form.hidden).toBe(false);
    expect(form.method).toBe('post');
    expect(form.action).toBe('http://127.0.0.1:8787/access/downloads/redeem');
    expect(document.querySelector<HTMLInputElement>('input')!.value).toBe(token);
    expect(location.hash).toBe('');
  });

  it.each(['token=bad', `token=${'a'.repeat(64)}&token=${'b'.repeat(64)}`, ''])('does not offer a download for an incomplete or ambiguous fragment: %s', async (fragment) => {
    history.replaceState(null, '', `/download/#${fragment}`);
    document.body.innerHTML = '<form id="download-form" hidden><input id="download-token"></form><p id="download-error" hidden></p>';
    await import('../src/download');
    expect(document.querySelector<HTMLFormElement>('form')!.hidden).toBe(true);
    expect(document.querySelector<HTMLElement>('#download-error')!.hidden).toBe(false);
    expect(location.hash).toBe('');
  });

  it('explains permanent acknowledgement rejection without asking for another send', async () => {
    document.body.innerHTML = '<form id="access-request"><input id="access-email" type="email" required value="team@example.com"><button id="access-submit">Get early access</button></form><p id="access-status"></p>';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ error: { code: 'access_email_rejected' } }, { status: 502 }));
    await import('../src/landing');
    document.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await vi.waitFor(() => expect(document.querySelector('#access-status')!.textContent).toBe(accessCopy.rejected));
    expect(document.querySelector<HTMLFormElement>('form')!.hidden).toBe(false);
  });

  it('explains that an uncertain email needs review without promising another send', async () => {
    document.body.innerHTML = '<form id="access-request"><input id="access-email" type="email" required value="team@example.com"><button id="access-submit">Get early access</button></form><p id="access-status"></p>';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ error: { code: 'access_email_review_required' } }, { status: 503 }));
    await import('../src/landing');
    document.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await vi.waitFor(() => expect(document.querySelector('#access-status')!.textContent).toBe(accessCopy.reviewRequired));
    expect(document.querySelector<HTMLElement>('#access-status')!.dataset.state).toBe('error');
  });

  it('keeps a saved-email failure retryable, then shows success after a new request', async () => {
    document.body.innerHTML = '<form id="access-request"><input id="access-email" type="email" required value="team@example.com"><button id="access-submit" disabled>Get early access</button></form><p id="access-status" tabindex="-1"></p>';
    const fetch = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(Response.json({ error: { code: 'access_email_failed' } }, { status: 502 }))
      .mockResolvedValueOnce(Response.json({ accepted: true }, { status: 202 }));
    await import('../src/landing');
    const form = document.querySelector<HTMLFormElement>('form')!;
    const button = document.querySelector<HTMLButtonElement>('button')!;
    const status = document.querySelector<HTMLElement>('#access-status')!;
    const submit = () => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    submit(); submit();
    expect(button.disabled).toBe(true);
    await vi.waitFor(() => expect(status.textContent).toBe(accessCopy.savedFailure), { timeout: 5_000 });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(status.dataset.state).toBe('error');
    expect(form.hidden).toBe(false);
    expect(button.disabled).toBe(false);
    submit();
    await vi.waitFor(() => expect(status.textContent).toBe(accessCopy.success), { timeout: 5_000 });
    expect(status.dataset.state).toBe('success');
    expect(form.hidden).toBe(true);
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toEqual({ email: 'team@example.com', turnstileToken: 'local-development' });
  });
});


it('requires a verified browser token, resets it on failure, and submits only the fresh token', async () => {
  vi.stubGlobal('location', new URL('https://rallywith.ai/'));
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('__RALLY_TURNSTILE_SITE_KEY__', 'test-site-key');
  document.body.innerHTML = '<div id="access-challenge"></div><form id="access-request"><input id="access-email" type="email" required value="team@example.com"><button id="access-submit" disabled>Get early access</button></form><p id="access-status"></p>';
  let callbacks: Parameters<NonNullable<typeof window.turnstile>['render']>[1] | undefined;
  const reset = vi.fn();
  window.turnstile = { render: (_container, options) => { callbacks = options; return 'widget'; }, reset };
  const http = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json({ error: { code: 'access_verification_failed' } }, { status: 400 }))
    .mockResolvedValueOnce(Response.json({ accepted: true }, { status: 202 }));
  await import('../src/landing');
  const form = document.querySelector<HTMLFormElement>('form')!;
  const button = document.querySelector<HTMLButtonElement>('button')!;
  form.dispatchEvent(new Event('submit', { cancelable: true }));
  expect(http).not.toHaveBeenCalled(); expect(button.disabled).toBe(true);
  document.head.querySelector('script[src*="challenges.cloudflare.com"]')!.dispatchEvent(new Event('load'));
  callbacks!.callback('first-proof');
  expect(button.disabled).toBe(false);
  form.dispatchEvent(new Event('submit', { cancelable: true }));
  await vi.waitFor(() => expect(reset).toHaveBeenCalledWith('widget'));
  expect(button.disabled).toBe(true);
  callbacks!.callback('fresh-proof');
  form.dispatchEvent(new Event('submit', { cancelable: true }));
  await vi.waitFor(() => expect(form.hidden).toBe(true));
  expect(JSON.parse(String(http.mock.calls[1]![1]!.body))).toEqual({ email: 'team@example.com', turnstileToken: 'fresh-proof' });
  expect(document.querySelector<HTMLElement>('#access-challenge')!.hidden).toBe(true);
});

describe('invisible challenge', () => {
  type Observe = (entries: { contentRect: { height: number } }[]) => void;
  const setUp = async () => {
    vi.stubGlobal('location', new URL('https://rallywith.ai/'));
    vi.stubGlobal('__RALLY_TURNSTILE_SITE_KEY__', 'test-site-key');
    const observers: Observe[] = [];
    vi.stubGlobal('ResizeObserver', class { constructor(callback: Observe) { observers.push(callback); } observe() {} disconnect() {} });
    document.body.innerHTML = '<style>.access-challenge { margin: 0 auto; } .access-challenge[data-revealed] { margin-bottom: 16px; }</style><div id="access-challenge" class="access-challenge"></div><p id="access-challenge-note" aria-live="polite"></p>';
    let options: Parameters<NonNullable<typeof window.turnstile>['render']>[1] | undefined;
    const reset = vi.fn();
    window.turnstile = { render: (_container, value) => { options = value; return 'widget'; }, reset };
    const { accessChallenge } = await import('../src/access-challenge');
    const onChange = vi.fn();
    const onError = vi.fn();
    const challenge = accessChallenge(onChange, onError);
    document.head.querySelector('script[src*="challenges.cloudflare.com"]')!.dispatchEvent(new Event('load'));
    const container = document.querySelector<HTMLElement>('#access-challenge')!;
    const note = document.querySelector<HTMLElement>('#access-challenge-note')!;
    const resize = (height: number) => observers.forEach((observe) => observe([{ contentRect: { height } }]));
    return { options: options!, reset, onChange, onError, challenge, container, note, resize };
  };

  it('asks Cloudflare for an interaction-only widget and passes a silent proof without reserving any room', async () => {
    const { options, onChange, onError, container, note, resize } = await setUp();
    expect(options.appearance).toBe('interaction-only');
    resize(0);
    options.callback('silent-proof');
    expect(onChange).toHaveBeenLastCalledWith('silent-proof');
    expect(container.dataset.revealed).toBeUndefined();
    expect(getComputedStyle(container).marginBottom).toBe('0px');
    expect(note.textContent).toBe('');
    expect(onError).not.toHaveBeenCalled();
  });

  it('reserves room and announces the widget while it is rendered, ends the announcement on proof, and releases the room when Cloudflare hides it again', async () => {
    const { options, container, note, resize } = await setUp();
    resize(65);
    expect(container.dataset.revealed).toBe('');
    expect(getComputedStyle(container).marginBottom).toBe('16px');
    expect(note.textContent).toBe(accessCopy.verification);
    options.callback('interactive-proof');
    expect(note.textContent).toBe('');
    expect(container.dataset.revealed).toBe('');
    resize(0);
    expect(container.dataset.revealed).toBeUndefined();
    expect(getComputedStyle(container).marginBottom).toBe('0px');
    expect(note.textContent).toBe('');
  });

  it('drops the token and resets the widget on request', async () => {
    const { reset, onChange, challenge } = await setUp();
    challenge.reset();
    expect(onChange).toHaveBeenLastCalledWith(null);
    expect(reset).toHaveBeenCalledWith('widget');
  });
});
