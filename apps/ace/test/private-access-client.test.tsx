// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AccessView } from '../src/client/private-access';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); vi.restoreAllMocks(); container.remove(); });

it('issues the selected timed grant and keeps its displayed lifetime when the next mode changes', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
    if (String(_input).includes('/downloads?')) return Response.json({ grants: [], nextCursor: null });
    if (init?.method !== 'POST') return Response.json({ requests: [], nextCursor: null });
    return Response.json({ id: 'grant', url: `https://rallywith.ai/download/#token=${'a'.repeat(64)}`, expiresAt: JSON.parse(String(init.body)).expiresAt });
  });
  await act(async () => root.render(<AccessView />));
  const select = container.querySelector('select')!;
  await act(async () => { select.value = 'timed'; select.dispatchEvent(new Event('change', { bubbles: true })); });
  const generate = Array.from(container.querySelectorAll('button')).find(b => b.textContent === 'Generate download link')!;
  expect(generate.disabled).toBe(true);
  const input = container.querySelector<HTMLInputElement>('input[type=datetime-local]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '2099-01-01T12:00');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(generate.disabled).toBe(false);
  await act(async () => generate.click());
  const posted = fetch.mock.calls.find(([, init]) => init?.method === 'POST')!;
  expect(JSON.parse(String(posted[1]?.body))).toEqual({ expiresAt: new Date('2099-01-01T12:00').toISOString() });
  const status = container.querySelector('[role=status]')!.textContent;
  expect(status).toContain('Repeat downloads until');
  await act(async () => { select.value = 'single'; select.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(container.querySelector('[role=status]')!.textContent).toBe(status);
  expect(container.querySelector<HTMLInputElement>('input[readonly]')!.value).toContain('#token=');
});
