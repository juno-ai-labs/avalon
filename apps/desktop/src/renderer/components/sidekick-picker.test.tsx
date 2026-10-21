import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as Tooltip from '@radix-ui/react-tooltip';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SidekickPicker } from './sidekick-picker';

const api = vi.hoisted(() => ({ getSidekicks: vi.fn(), getSidekickRecommendationOptions: vi.fn(), setRecommendedSidekick: vi.fn() }));
const capabilities = vi.hoisted(() => ({ setup: true }));
const openSidekicks = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('../lib/platform', () => ({
  desktopBridge: () => ({ openSidekicks }),
  desktopServicesAvailable: () => false,
}));
vi.mock('../lib/collaboration-session', () => ({ useOptionalCollaborationSession: () => null,
  useCollaborationSession: () => ({ api, session: { user: { id: 'person' } }, createSidekick: capabilities.setup ? () => openSidekicks('new') : null }) }));

function renderPicker(client = new QueryClient()) {
  return render(<Tooltip.Provider><QueryClientProvider client={client}><SidekickPicker workstreamId="room" substreamId="0" /></QueryClientProvider></Tooltip.Provider>);
}

describe('Sidekick recommendation picker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capabilities.setup = true;
    api.getSidekicks.mockResolvedValue([]);
    api.getSidekickRecommendationOptions.mockImplementation(async () => ({ canManage: true,
      items: (await api.getSidekicks() as Array<{ id: string; scope: string; name: string; description: string }> )
        .filter((item) => item.scope === 'workspace').map((item) => ({ ...item, available: true, attached: false })),
    }));
  });

  it('withholds parent management when the canonical capability is denied', async () => {
    api.getSidekickRecommendationOptions.mockResolvedValue({ canManage: false, items: [] });
    const client = new QueryClient();
    renderPicker(client);
    expect(api.getSidekickRecommendationOptions).not.toHaveBeenCalled();
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Add Sidekick' }), { button: 0, ctrlKey: false });
    await waitFor(() => expect(client.getQueryData(['sidekick-recommendation-options', 'room', '0'])).toMatchObject({ canManage: false }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Add Sidekick', hidden: true })).not.toBeInTheDocument());
    expect(screen.queryByRole('menuitem', { name: 'Create new Sidekick', hidden: true })).not.toBeInTheDocument();
  });

  it('keeps existing Sidekick attachment available without a setup capability', async () => {
    capabilities.setup = false;
    api.getSidekicks.mockResolvedValue([{ id: 'helper', scope: 'workspace', name: 'Shared guide', description: '' }]);
    renderPicker();
    fireEvent.pointerDown(await screen.findByRole('button', { name: 'Add Sidekick' }), { button: 0, ctrlKey: false });
    expect(await screen.findByRole('menuitem', { name: 'Attach existing Sidekick' })).toBeVisible();
    expect(screen.queryByRole('menuitem', { name: 'Create new Sidekick' })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('menuitem', { name: 'Attach existing Sidekick' })).not.toHaveAttribute('aria-disabled', 'true'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Attach existing Sidekick' }));
    expect(await screen.findByRole('button', { name: 'Shared guide' })).toBeVisible();
  });
  it('keeps an in-flight attachment bound to its original workstream after navigation', async () => {
    api.getSidekicks.mockResolvedValue([{ id: 'helper', scope: 'workspace', name: 'Guide', description: '' }]);
    const recommended = [{ id: 'helper', name: 'Guide', description: '', available: true }];
    let resolveAttach!: (value: typeof recommended) => void;
    api.setRecommendedSidekick.mockReturnValue(new Promise((resolve) => { resolveAttach = resolve; }));
    const client = new QueryClient();
    const view = renderPicker(client);
    fireEvent.pointerDown(await screen.findByRole('button', { name: 'Add Sidekick' }), { button: 0, ctrlKey: false });
    await screen.findByRole('menuitem', { name: 'Attach existing Sidekick' });
    await waitFor(() => expect(screen.getByRole('menuitem', { name: 'Attach existing Sidekick' })).not.toHaveAttribute('aria-disabled', 'true'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Attach existing Sidekick' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Guide' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Guide' })).toBeDisabled());
    view.rerender(<Tooltip.Provider><QueryClientProvider client={client}><SidekickPicker workstreamId="other" substreamId="0" /></QueryClientProvider></Tooltip.Provider>);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await act(async () => { resolveAttach(recommended); });
    await waitFor(() => expect(client.getQueryData(['recommended-sidekicks', 'room', '0'])).toEqual(recommended));
    expect(client.getQueryData(['recommended-sidekicks', 'other', '0'])).toBeUndefined();
  });

  it('keeps an in-flight attachment pending when the picker is reopened', async () => {
    api.getSidekickRecommendationOptions.mockResolvedValue({ canManage: true, items: [
      { id: 'helper', name: 'Guide', description: '', available: true, attached: false },
    ] });
    const recommended = [{ id: 'helper', name: 'Guide', description: '', available: true }];
    let resolveAttach!: (value: typeof recommended) => void;
    api.setRecommendedSidekick.mockReturnValue(new Promise((resolve) => { resolveAttach = resolve; }));
    renderPicker(new QueryClient({ defaultOptions: { queries: { retry: false } } }));

    fireEvent.pointerDown(await screen.findByRole('button', { name: 'Add Sidekick' }), { button: 0, ctrlKey: false });
    await waitFor(() => expect(screen.getByRole('menuitem', { name: 'Attach existing Sidekick' })).not.toHaveAttribute('aria-disabled', 'true'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Attach existing Sidekick' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Guide' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Guide' })).toBeDisabled());

    fireEvent.click(screen.getByRole('button', { name: 'Close dialog' }));
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Add Sidekick' }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Attach existing Sidekick' }));
    expect(await screen.findByRole('button', { name: 'Guide' })).toBeDisabled();
    expect(api.setRecommendedSidekick).toHaveBeenCalledTimes(1);

    await act(async () => { resolveAttach(recommended); });
  });

  it('does not let an older read overwrite a successful attachment', async () => {
    api.getSidekicks.mockResolvedValue([{ id: 'helper', scope: 'workspace', name: 'Guide', description: '' }]);
    const recommended = [{ id: 'helper', name: 'Guide', description: '', available: true }];
    api.setRecommendedSidekick.mockResolvedValue(recommended);
    const client = new QueryClient();
    let resolveRead!: (value: typeof recommended) => void;
    const read = client.fetchQuery({ queryKey: ['recommended-sidekicks', 'room', '0'], queryFn: () => new Promise<typeof recommended>((resolve) => { resolveRead = resolve; }) }).catch(() => undefined);
    renderPicker(client);
    fireEvent.pointerDown(await screen.findByRole('button', { name: 'Add Sidekick' }), { button: 0, ctrlKey: false });
    await screen.findByRole('menuitem', { name: 'Attach existing Sidekick' });
    await waitFor(() => expect(screen.getByRole('menuitem', { name: 'Attach existing Sidekick' })).not.toHaveAttribute('aria-disabled', 'true'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Attach existing Sidekick' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Guide' }));
    await waitFor(() => expect(client.getQueryData(['recommended-sidekicks', 'room', '0'])).toEqual(recommended));
    await act(async () => { resolveRead([]); await read; });
    expect(client.getQueryData(['recommended-sidekicks', 'room', '0'])).toEqual(recommended);
  });

  it('lists organization Sidekicks, searches, and updates the shared recommendation query', async () => {
    api.getSidekicks.mockResolvedValue([
      { id: 'workspace-helper', scope: 'workspace', name: 'Writing guide', description: 'House style' },
      { id: 'personal-helper', scope: 'personal', name: 'Private notes', description: '' },
    ]);
    const recommended = [{ id: 'workspace-helper', name: 'Writing guide', description: 'House style', available: true }];
    api.setRecommendedSidekick.mockResolvedValue(recommended);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderPicker(client);
    fireEvent.pointerDown(await screen.findByRole('button', { name: 'Add Sidekick' }), { button: 0, ctrlKey: false });
    await screen.findByRole('menuitem', { name: 'Attach existing Sidekick' });
    await waitFor(() => expect(screen.getByRole('menuitem', { name: 'Attach existing Sidekick' })).not.toHaveAttribute('aria-disabled', 'true'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Attach existing Sidekick' }));
    expect(await screen.findByRole('button', { name: 'Writing guide' })).toBeVisible();
    expect(screen.queryByText('Private notes')).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox', { name: 'Search organization Sidekicks' }), { target: { value: 'missing' } });
    expect(screen.getByText('No organization Sidekicks found.')).toBeVisible();
    fireEvent.change(screen.getByRole('textbox', { name: 'Search organization Sidekicks' }), { target: { value: 'writing' } });
    fireEvent.click(screen.getByRole('button', { name: 'Writing guide' }));
    await waitFor(() => expect(client.getQueryData(['recommended-sidekicks', 'room', '0'])).toEqual(recommended));
    expect(api.setRecommendedSidekick).toHaveBeenCalledWith('room', 'workspace-helper', true, '0');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('keeps route diagnostics out of the picker when options cannot load', async () => {
    const diagnostic = 'INTERNAL ROUTER RESPONSE: requested API route does not exist; shard=17';
    api.getSidekickRecommendationOptions.mockRejectedValueOnce(new Error(diagnostic));
    renderPicker(new QueryClient({ defaultOptions: { queries: { retry: false } } }));

    fireEvent.pointerDown(await screen.findByRole('button', { name: 'Add Sidekick' }), { button: 0, ctrlKey: false });

    expect(await screen.findByText('Sidekick options couldn’t be loaded.')).toBeVisible();
    expect(screen.queryByText(diagnostic)).not.toBeInTheDocument();
  });

  it('keeps mutation diagnostics out of the picker when attachment fails', async () => {
    const diagnostic = 'provider mutation failed: durable object 9a2';
    const laterLoadDiagnostic = 'router failed while refreshing Sidekick options';
    api.getSidekickRecommendationOptions.mockResolvedValue({ canManage: true, items: [
      { id: 'helper', name: 'Guide', description: '', available: true, attached: false },
    ] });
    api.setRecommendedSidekick.mockRejectedValueOnce(new Error(diagnostic));
    renderPicker(new QueryClient({ defaultOptions: { queries: { retry: false } } }));

    fireEvent.pointerDown(await screen.findByRole('button', { name: 'Add Sidekick' }), { button: 0, ctrlKey: false });
    await waitFor(() => expect(screen.getByRole('menuitem', { name: 'Attach existing Sidekick' })).not.toHaveAttribute('aria-disabled', 'true'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Attach existing Sidekick' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Guide' }));

    expect(await screen.findByText('That Sidekick couldn’t be added.')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    expect(screen.queryByText(diagnostic)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Close dialog' }));
    api.getSidekickRecommendationOptions.mockRejectedValueOnce(new Error(laterLoadDiagnostic));
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Add Sidekick' }), { button: 0, ctrlKey: false });
    expect(await screen.findByText('Sidekick options couldn’t be loaded.')).toBeVisible();
    expect(screen.queryByText('That Sidekick couldn’t be added.')).not.toBeInTheDocument();
    expect(screen.queryByText(laterLoadDiagnostic)).not.toBeInTheDocument();
  });

  it('opens the existing new-Sidekick composer from the dropdown', async () => {
    const client = new QueryClient();
    renderPicker(client);
    fireEvent.pointerDown(await screen.findByRole('button', { name: 'Add Sidekick' }), { button: 0, ctrlKey: false });
    const create = await screen.findByRole('menuitem', { name: 'Create new Sidekick' });
    await waitFor(() => expect(create).not.toHaveAttribute('aria-disabled', 'true'));
    fireEvent.click(create);
    expect(openSidekicks).toHaveBeenCalledWith('new');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
  it('shows an Add Sidekick tooltip on hover', async () => {
    renderPicker();
    fireEvent.pointerMove(await screen.findByRole('button', { name: 'Add Sidekick' }), { pointerType: 'mouse' });
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Add Sidekick');
  });
});
