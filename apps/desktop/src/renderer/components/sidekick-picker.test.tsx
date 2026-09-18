import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as Tooltip from '@radix-ui/react-tooltip';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SidekickPicker } from './sidekick-picker';

const api = vi.hoisted(() => ({ getSidekicks: vi.fn(), setRecommendedSidekick: vi.fn() }));
const openSidekicks = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('../lib/platform', () => ({
  desktopBridge: () => ({ openSidekicks }),
  desktopServicesAvailable: () => false,
}));
vi.mock('../lib/app-session', () => ({ useAppSession: () => ({ api, session: { user: { id: 'person' } } }) }));

function renderPicker(client = new QueryClient()) {
  return render(<Tooltip.Provider><QueryClientProvider client={client}><SidekickPicker workstreamId="room" participantIds={['person']} /></QueryClientProvider></Tooltip.Provider>);
}

describe('Sidekick recommendation picker', () => {
  it('keeps an in-flight attachment bound to its original workstream after navigation', async () => {
    api.getSidekicks.mockResolvedValue([{ id: 'helper', scope: 'workspace', name: 'Guide', description: '' }]);
    const recommended = [{ id: 'helper', name: 'Guide', description: '', available: true }];
    let resolveAttach!: (value: typeof recommended) => void;
    api.setRecommendedSidekick.mockReturnValue(new Promise((resolve) => { resolveAttach = resolve; }));
    const client = new QueryClient();
    const view = renderPicker(client);
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Add Sidekick' }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Attach existing Sidekick' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Guide' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Guide' })).toBeDisabled());
    view.rerender(<Tooltip.Provider><QueryClientProvider client={client}><SidekickPicker workstreamId="other" participantIds={['person']} /></QueryClientProvider></Tooltip.Provider>);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await act(async () => { resolveAttach(recommended); });
    await waitFor(() => expect(client.getQueryData(['recommended-sidekicks', 'room'])).toEqual(recommended));
    expect(client.getQueryData(['recommended-sidekicks', 'other'])).toBeUndefined();
  });

  it('does not let an older read overwrite a successful attachment', async () => {
    api.getSidekicks.mockResolvedValue([{ id: 'helper', scope: 'workspace', name: 'Guide', description: '' }]);
    const recommended = [{ id: 'helper', name: 'Guide', description: '', available: true }];
    api.setRecommendedSidekick.mockResolvedValue(recommended);
    const client = new QueryClient();
    let resolveRead!: (value: typeof recommended) => void;
    const read = client.fetchQuery({ queryKey: ['recommended-sidekicks', 'room'], queryFn: () => new Promise<typeof recommended>((resolve) => { resolveRead = resolve; }) }).catch(() => undefined);
    renderPicker(client);
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Add Sidekick' }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Attach existing Sidekick' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Guide' }));
    await waitFor(() => expect(client.getQueryData(['recommended-sidekicks', 'room'])).toEqual(recommended));
    await act(async () => { resolveRead([]); await read; });
    expect(client.getQueryData(['recommended-sidekicks', 'room'])).toEqual(recommended);
  });

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
