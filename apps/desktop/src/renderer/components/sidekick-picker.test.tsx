import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as Tooltip from '@radix-ui/react-tooltip';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SidekickPicker } from './sidekick-picker';

const api = vi.hoisted(() => ({ getSidekicks: vi.fn(), setRecommendedSidekick: vi.fn() }));
const openSidekicks = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('../lib/platform', () => ({ desktopBridge: () => ({ openSidekicks }) }));
vi.mock('../lib/app-session', () => ({ useAppSession: () => ({ api, session: { user: { id: 'person' } } }) }));

function renderPicker(client = new QueryClient()) {
  return render(<Tooltip.Provider><QueryClientProvider client={client}><SidekickPicker workstreamId="room" participantIds={['person']} /></QueryClientProvider></Tooltip.Provider>);
}

describe('Sidekick recommendation picker', () => {
  it('lists workspace Sidekicks, searches, and updates the shared recommendation query', async () => {
    api.getSidekicks.mockResolvedValue([
      { id: 'workspace-helper', scope: 'workspace', name: 'Writing guide', description: 'House style' },
      { id: 'personal-helper', scope: 'personal', name: 'Private notes', description: '' },
    ]);
    const recommended = [{ id: 'workspace-helper', name: 'Writing guide', description: 'House style', available: true }];
    api.setRecommendedSidekick.mockResolvedValue(recommended);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderPicker(client);
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Add Sidekick' }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Attach existing Sidekick' }));
    expect(await screen.findByRole('button', { name: 'Writing guide' })).toBeVisible();
    expect(screen.queryByText('Private notes')).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox', { name: 'Search workspace Sidekicks' }), { target: { value: 'missing' } });
    expect(screen.getByText('No workspace Sidekicks found.')).toBeVisible();
    fireEvent.change(screen.getByRole('textbox', { name: 'Search workspace Sidekicks' }), { target: { value: 'writing' } });
    fireEvent.click(screen.getByRole('button', { name: 'Writing guide' }));
    await waitFor(() => expect(client.getQueryData(['recommended-sidekicks', 'room'])).toEqual(recommended));
    expect(api.setRecommendedSidekick).toHaveBeenCalledWith('room', 'workspace-helper', true);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
  it('opens the existing new-Sidekick composer from the dropdown', async () => {
    const client = new QueryClient();
    renderPicker(client);
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Add Sidekick' }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Create new Sidekick' }));
    expect(openSidekicks).toHaveBeenCalledWith('new');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
  it('shows an Add Sidekick tooltip on hover', async () => {
    renderPicker();
    fireEvent.pointerMove(screen.getByRole('button', { name: 'Add Sidekick' }), { pointerType: 'mouse' });
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Add Sidekick');
  });
});
