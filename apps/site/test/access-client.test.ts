// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { accessCopy } from '../src/access-copy';

beforeEach(() => { vi.resetModules(); document.body.innerHTML = ''; history.replaceState(null, '', '/'); });
afterEach(() => { vi.restoreAllMocks(); });

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
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toEqual({ email: 'team@example.com' });
  });
});
