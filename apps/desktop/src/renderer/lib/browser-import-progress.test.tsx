import "../../../../../tests/isolated-region";
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserImportProgress as Progress } from '../../common/browser-import';
import type { WorkstreamSummary } from './types';

const harness = vi.hoisted(() => ({
  listener: null as ((progress: Progress) => void) | null,
}));
vi.mock('./platform', () => ({
  desktopBridge: () => ({
    onBrowserImportProgress: (listener: (progress: Progress) => void) => {
      harness.listener = listener;
      return () => { harness.listener = null; };
    },
  }),
}));

import { BrowserImportProgress } from './browser-import-progress';
import { WORKSTREAMS_QUERY_KEY, setCachedWorkstreams } from './workstreams-cache';
import { WorkstreamScreen } from '../screens/workstream';

const id = '019a0000-0000-7000-8000-00000000c1a1';

function Path(): React.JSX.Element {
  return <output data-testid="path">{useLocation().pathname}</output>;
}

function mount(): QueryClient {
  const client = new QueryClient();
  setCachedWorkstreams(client, []);
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/spaces/earlier']}>
        <BrowserImportProgress />
        <Path />
        <Routes>
          <Route element={<WorkstreamScreen />} path="/workstreams/:id" />
          <Route element={null} path="*" />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return client;
}

const rows = (client: QueryClient) => client.getQueryData<WorkstreamSummary[]>(WORKSTREAMS_QUERY_KEY) ?? [];
const send = (progress: Progress) => act(() => { harness.listener?.(progress); });

describe('an import made in the import window, seen from the main window', () => {
  beforeEach(() => { harness.listener = null; });

  it('lists the Channel as pending and opens it on an importing screen while the create runs', () => {
    const client = mount();

    send({ phase: 'importing', workstreamId: id, title: 'Launch plan', spaceId: 'space-a' });

    expect(rows(client)).toEqual([expect.objectContaining({
      id, title: 'Launch plan', spaceIds: ['space-a'], pending: true, pendingOrigin: 'import',
    })]);
    expect(screen.getByTestId('path')).toHaveTextContent(`/workstreams/${id}`);
    expect(screen.getByRole('status', { name: 'Importing conversation…' })).toBeInTheDocument();
    expect(screen.getByText('Importing conversation…', { selector: '.conversation-opening-caption' })).toBeVisible();
  });

  it('settles the row when the import lands', () => {
    const client = mount();
    send({ phase: 'importing', workstreamId: id, title: 'Launch plan', spaceId: 'space-a' });

    send({ phase: 'imported', workstreamId: id });

    const [row] = rows(client);
    expect(row).toMatchObject({ id, title: 'Launch plan' });
    expect(row?.pending).toBeUndefined();
  });

  it('takes the row away and returns to where the window was when the import fails', () => {
    const client = mount();
    send({ phase: 'importing', workstreamId: id, title: 'Launch plan', spaceId: 'space-a' });

    send({ phase: 'failed', workstreamId: id });

    expect(rows(client)).toEqual([]);
    expect(screen.getByTestId('path')).toHaveTextContent('/spaces/earlier');
  });
});
