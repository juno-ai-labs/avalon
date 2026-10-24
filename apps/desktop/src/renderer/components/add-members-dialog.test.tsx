import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AddMembersDialog } from './add-members-dialog';

function setup() {
  const api = {
    getWorkspaceInvitations: vi.fn(async () => [{ email: 'pending@example.com', status: 'pending' }]),
    getWorkspaceMembers: vi.fn(async () => [{ email: 'member@example.com', status: 'active' }]),
    createWorkspaceInvitation: vi.fn<(email: string, role: string) => Promise<object>>(async () => ({})),
  };
  const onClose = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><AddMembersDialog api={api as never} open onClose={onClose} /></QueryClientProvider>);
  return { api, onClose, field: screen.getByLabelText('Email addresses') };
}

describe('AddMembersDialog', () => {
  it('refuses a list holding an invalid address without sending anything', async () => {
    const { api, field } = setup();
    fireEvent.paste(field, { clipboardData: { getData: () => 'aspen@example.com, nope' } });
    fireEvent.click(screen.getByRole('button', { name: 'Invite 2 teammates' }));
    expect(await screen.findByRole('alertdialog')).toHaveTextContent('One or more of the addresses are not a valid email address.');
    expect(api.createWorkspaceInvitation).not.toHaveBeenCalled();
  });

  it('invites every new address as a member, skips those already in, and closes', async () => {
    const { api, onClose, field } = setup();
    fireEvent.paste(field, { clipboardData: { getData: () => 'Aspen@example.com; pending@example.com member@example.com,birch@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Invite 4 teammates' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(api.createWorkspaceInvitation.mock.calls).toEqual([['aspen@example.com', 'member'], ['birch@example.com', 'member']]);
  });

  it('stays open holding only the addresses that failed', async () => {
    const { api, onClose, field } = setup();
    api.createWorkspaceInvitation.mockImplementation(async (email: string) => {
      if (email === 'birch@example.com') throw new Error('refused');
      return {};
    });
    fireEvent.paste(field, { clipboardData: { getData: () => 'aspen@example.com birch@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Invite 2 teammates' }));
    expect(await screen.findByRole('alertdialog')).toHaveTextContent('Could not invite: birch@example.com.');
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByText('aspen@example.com')).not.toBeInTheDocument();
    expect(screen.getByText('birch@example.com')).toBeInTheDocument();
  });
});
