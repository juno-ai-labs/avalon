import * as Tooltip from '@radix-ui/react-tooltip';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SidekickDelegation } from './sidekick-delegation';

const api = vi.hoisted(() => ({ getSidekickDelegates: vi.fn(), setMySidekickDelegation: vi.fn(), removeSidekickDelegate: vi.fn() }));
vi.mock('../lib/collaboration-session', () => ({ useCollaborationSession: () => ({ api }) }));
const person = { userId: 'maya', displayName: 'Maya', eligible: true };
let allowed: boolean;
let online: boolean;

function snapshot() {
  return { sidekickId: 'sidekick', creatorUserId: 'maya', creator: person, canManage: false,
    you: { userId: 'maya', allowed }, delegates: allowed ? [person] : [] };
}
function mount() {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <Tooltip.Provider><SidekickDelegation id="sidekick" /></Tooltip.Provider>
  </QueryClientProvider>);
}
beforeEach(() => {
  allowed = false; online = true;
  vi.spyOn(navigator, 'onLine', 'get').mockImplementation(() => online);
  api.getSidekickDelegates.mockReset().mockImplementation(async () => snapshot());
  api.setMySidekickDelegation.mockReset();
  api.removeSidekickDelegate.mockReset();
});

describe('Sidekick delegation controls', () => {
  it('keeps the confirmed list until the allow action is acknowledged and read back', async () => {
    let acknowledge!: () => void;
    api.setMySidekickDelegation.mockImplementation(() => new Promise((resolve) => {
      acknowledge = () => { allowed = true; resolve({ allowed: true }); };
    }));
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Allow this Sidekick to act as me' }));
    expect(screen.getByText('No one currently allows this Sidekick to act as them')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Saving…' })).toHaveAttribute('aria-disabled', 'true');
    await act(async () => acknowledge());
    expect(await screen.findByRole('button', { name: 'Stop allowing this Sidekick to act as me' })).toBeInTheDocument();
    expect(screen.getByText('You')).toBeInTheDocument();
    expect(screen.getByText('Creator')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Remove Maya/u })).not.toBeInTheDocument();
  });

  it('reads current authority after a lost response without automatically repeating consent', async () => {
    api.setMySidekickDelegation.mockImplementation(async () => { allowed = true; throw new Error('Response lost'); });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Allow this Sidekick to act as me' }));
    fireEvent.click(await screen.findByRole('button', { name: 'OK' }));
    expect(await screen.findByRole('button', { name: 'Stop allowing this Sidekick to act as me' })).toBeInTheDocument();
    expect(api.setMySidekickDelegation).toHaveBeenCalledTimes(1);
  });

  it('never queues an offline allow to send when the network returns', async () => {
    mount();
    const allow = await screen.findByRole('button', { name: 'Allow this Sidekick to act as me' });
    act(() => { online = false; window.dispatchEvent(new Event('offline')); });
    expect(screen.getByText(/Showing the last confirmed list/u)).toBeInTheDocument();
    fireEvent.click(allow);
    act(() => { online = true; window.dispatchEvent(new Event('online')); });
    await waitFor(() => expect(allow).not.toHaveAttribute('aria-disabled', 'true'));
    expect(api.setMySidekickDelegation).not.toHaveBeenCalled();
  });

  it('keeps a removed creator visibly identified without implying an active grant', async () => {
    allowed = true;
    api.getSidekickDelegates.mockImplementation(async () => ({ ...snapshot(), canManage: true, you: { userId: 'adam', allowed: false } }));
    let acknowledge!: () => void;
    api.removeSidekickDelegate.mockImplementation(() => new Promise((resolve) => {
      acknowledge = () => { allowed = false; resolve({ allowed: false }); };
    }));
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Remove Maya from delegation' }));
    expect(screen.getByRole('button', { name: 'Allow this Sidekick to act as me' })).not.toHaveAttribute('aria-disabled', 'true');
    await act(async () => acknowledge());
    expect(await screen.findByText('Not allowed')).toBeInTheDocument();
    expect(screen.getByText('Creator')).toBeInTheDocument();
    expect(screen.getByText('No one currently allows this Sidekick to act as them')).toBeInTheDocument();
  });

  it('requires a successful read before another mutation when reconciliation is unavailable', async () => {
    let refuseRead = false;
    api.getSidekickDelegates.mockImplementation(async () => {
      if (refuseRead) throw new Error('Read unavailable');
      return snapshot();
    });
    api.setMySidekickDelegation.mockImplementation(async () => { allowed = true; refuseRead = true; throw new Error('Response lost'); });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Allow this Sidekick to act as me' }));
    fireEvent.click(await screen.findByRole('button', { name: 'OK' }));
    const refresh = await screen.findByRole('button', { name: 'Refresh delegation' });
    expect(screen.getByText('No one currently allows this Sidekick to act as them')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Allow this Sidekick to act as me' })).toHaveAttribute('aria-disabled', 'true');
    refuseRead = false;
    fireEvent.click(refresh);
    expect(await screen.findByRole('button', { name: 'Stop allowing this Sidekick to act as me' })).toBeInTheDocument();
    expect(api.setMySidekickDelegation).toHaveBeenCalledTimes(1);
  });
});
