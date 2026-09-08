import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkstreamSummary } from '../lib/types';
import { WorkstreamLandingScreen } from './workstream-landing';

const socket = vi.hoisted(() => ({ state: 'connecting' }));
vi.mock('../lib/workspace-socket', () => ({ useWorkspaceSocket: () => socket }));

const directory = vi.hoisted(() => ({ data: undefined as WorkstreamSummary[] | undefined, error: null as Error | null }));
vi.mock('../lib/use-workstreams-query', () => ({ useWorkstreamsQuery: () => directory }));

function stream(id: string, pinPosition: number | null, lastActivityAt: string): WorkstreamSummary {
  return {
    id, pinPosition, lastActivityAt, title: id, titleStatus: 'settled', scope: 'workspace',
    harnessStatus: 'completed', latestAttentionSequenceNumber: 0, readThroughSequenceNumber: 0,
    manualUnreadFromSequenceNumber: null, manualUnreadGeneration: 0, hasUnread: false,
    firstUnreadSequenceNumber: null, nextPendingWakeup: null, participantUserIds: [], participantExtraCount: 0,
  };
}

function Destination(): React.JSX.Element {
  return <div data-testid="destination">{useLocation().pathname}</div>;
}

function Router({ initial = '/' }: { initial?: string }): React.JSX.Element {
  return <MemoryRouter initialEntries={[initial]}><Routes>
    <Route element={<WorkstreamLandingScreen />} path="/" />
    <Route element={<Destination />} path="*" />
  </Routes></MemoryRouter>;
}

describe('default work-stream landing', () => {
  beforeEach(() => { directory.data = undefined; directory.error = null; socket.state = 'connecting'; });

  it('waits for the directory and opens the first pin, not the newest arrival', async () => {
    const view = render(<Router />);
    expect(screen.getByRole('status')).toHaveTextContent('Opening work streams');
    expect(screen.queryByTestId('destination')).toBeNull();
    directory.data = [stream('recent', null, '2026-09-05'), stream('second-pin', 1, '2026-09-04'), stream('first-pin', 0, '2026-08-01')];
    view.rerender(<Router />);
    expect(await screen.findByTestId('destination')).toHaveTextContent('/workstreams/first-pin');
    directory.data = [stream('different-pin', 0, '2026-09-06')];
    view.rerender(<Router />);
    expect(screen.getByTestId('destination')).toHaveTextContent('/workstreams/first-pin');
  });

  it('uses sidebar recency order when there are no pins', async () => {
    directory.data = [stream('older', null, '2026-08-01'), stream('newest', null, '2026-09-05')];
    render(<Router />);
    expect(await screen.findByTestId('destination')).toHaveTextContent('/workstreams/newest');
  });

  it('opens the composer only for a loaded empty directory', async () => {
    directory.data = [];
    render(<Router />);
    expect(await screen.findByTestId('destination')).toHaveTextContent('/workstreams/new');
  });

  it('surfaces a failed opening socket before the directory query is enabled', () => {
    socket.state = 'unavailable';
    render(<Router />);
    expect(screen.getByText(/Unable to connect to your workspace/u)).toBeVisible();
    expect(screen.queryByTestId('destination')).toBeNull();
  });

  it('does not treat a directory failure as an empty workspace', () => {
    directory.error = new Error('Directory unavailable');
    render(<Router />);
    expect(screen.getByText('Directory unavailable')).toBeVisible();
    expect(screen.queryByTestId('destination')).toBeNull();
  });
});
