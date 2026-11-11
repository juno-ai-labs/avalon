import '../../../../../tests/isolated-region';
import * as Tooltip from '@radix-ui/react-tooltip';
import { ErrorNoticeProvider } from '@rally/ui/components/error-notice';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { BrowserProductAnalyticsSetting } from './browser-product-analytics-setting';

vi.mock('../lib/app-session', () => ({ useAppSession: () => ({
  region: 'global', session: { authentication: 'cookie', user: { id: 'person' }, workspace: null },
}) }));

function open() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><Tooltip.Provider><ErrorNoticeProvider>
    <BrowserProductAnalyticsSetting />
  </ErrorNoticeProvider></Tooltip.Provider></QueryClientProvider>);
}
beforeEach(() => { vi.unstubAllGlobals(); });

it('saves the account preference with cookies and reads the saved value on remount', async () => {
  let stored = { enabled: true, version: 4 };
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'PATCH') {
      expect(JSON.parse(init.body as string)).toEqual({ enabled: false, expectedVersion: 4 });
      stored = { enabled: false, version: 5 };
    }
    return Response.json(stored);
  });
  vi.stubGlobal('fetch', fetchMock);
  open();
  const toggle = await screen.findByRole('switch', { name: 'Product analytics' });
  await waitFor(() => expect(toggle).toBeEnabled());
  expect(toggle).toBeChecked();
  fireEvent.click(toggle);
  await waitFor(() => expect(toggle).not.toBeChecked());
  expect(fetchMock.mock.calls.some(([url, init]) => url === '/regional/global/browser/api/_/telemetry/preference'
    && init?.method === 'PATCH' && init.credentials === 'same-origin' && !new Headers(init.headers).has('Authorization'))).toBe(true);
  cleanup();
  open();
  await waitFor(() => expect(screen.getByRole('switch')).toBeEnabled());
  expect(screen.getByRole('switch')).not.toBeChecked();
});

it('adopts a newer account preference after a version conflict instead of overwriting it', async () => {
  let reads = 0;
  let patches = 0;
  vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'PATCH') {
      patches++;
      return Response.json({ error: { code: 'preference_conflict', message: 'Preference changed' } }, { status: 409 });
    }
    return Response.json({ enabled: true, version: ++reads === 1 ? 4 : 5 });
  }));
  open();
  await waitFor(() => expect(screen.getByRole('switch')).toBeEnabled());
  fireEvent.click(screen.getByRole('switch'));
  await waitFor(() => expect(reads).toBeGreaterThan(1));
  await waitFor(() => expect(screen.getByRole('switch')).toBeEnabled());
  expect(screen.getByRole('switch')).toBeChecked();
  expect(patches).toBe(1);
});

it('reports a failed write without claiming the preference was saved', async () => {
  vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => init?.method === 'PATCH'
    ? Response.json({ error: { code: 'preference_unavailable', message: 'Preference could not be saved' } }, { status: 503 })
    : Response.json({ enabled: true, version: 4 })));
  open();
  await waitFor(() => expect(screen.getByRole('switch')).toBeEnabled());
  fireEvent.click(screen.getByRole('switch'));
  expect(await screen.findByRole('alertdialog')).toHaveTextContent('Preference could not be saved');
  expect(screen.getByRole('switch', { hidden: true })).toBeChecked();
});
