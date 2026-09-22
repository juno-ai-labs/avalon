// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  vi.resetModules();
  document.body.innerHTML = '';
  history.replaceState(null, '', '/');
});

describe('download-token browser handler', () => {
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

  it.each([
    'token=bad',
    `token=${'a'.repeat(64)}&token=${'b'.repeat(64)}`,
    '',
  ])('does not offer a download for an incomplete or ambiguous fragment: %s', async (fragment) => {
    history.replaceState(null, '', `/download/#${fragment}`);
    document.body.innerHTML = '<form id="download-form" hidden><input id="download-token"></form><p id="download-error" hidden></p>';

    await import('../src/download');

    expect(document.querySelector<HTMLFormElement>('form')!.hidden).toBe(true);
    expect(document.querySelector<HTMLElement>('#download-error')!.hidden).toBe(false);
    expect(location.hash).toBe('');
  });
});
