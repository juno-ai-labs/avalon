import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../lib/api';
import { AddMembersDialog } from './add-members-dialog';

function setup() {
  const api = {
    getWorkspaceMembers: vi.fn(async () => [{ email: 'member@example.com', status: 'active' }]),
    addWorkspaceMember: vi.fn<(email: string, role: string) => Promise<object>>(async () => ({})),
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
    fireEvent.click(screen.getByRole('button', { name: 'Add 2 teammates' }));
    expect(await screen.findByRole('alertdialog')).toHaveTextContent('One or more of the addresses are not a valid email address.');
    expect(api.addWorkspaceMember).not.toHaveBeenCalled();
  });

  it('adds every address that is not already a member, an address an older invitation waits for among them, and closes', async () => {
    const { api, onClose, field } = setup();
    fireEvent.paste(field, { clipboardData: { getData: () => 'Aspen@example.com; pending@example.com member@example.com,birch@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add 4 teammates' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    // Adding retires an invitation still waiting for an address, so that address is added too.
    expect(api.addWorkspaceMember.mock.calls).toEqual([['aspen@example.com', 'member'], ['pending@example.com', 'member'], ['birch@example.com', 'member']]);
  });

  it('stays open saying who was added but not emailed, so the person adding can tell them', async () => {
    const { api, onClose, field } = setup();
    api.addWorkspaceMember.mockResolvedValue({ member: {}, emailDelivery: 'failed' });
    fireEvent.paste(field, { clipboardData: { getData: () => 'aspen@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add 1 teammate' }));
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Added, but the email to aspen@example.com could not be sent. Tell them to sign in to Rally with that address.');
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('stays open holding only the addresses that failed', async () => {
    const { api, onClose, field } = setup();
    api.addWorkspaceMember.mockImplementation(async (email: string) => {
      if (email === 'birch@example.com') throw new Error('refused');
      return {};
    });
    fireEvent.paste(field, { clipboardData: { getData: () => 'aspen@example.com birch@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add 2 teammates' }));
    expect(await screen.findByRole('alertdialog')).toHaveTextContent('Could not add: birch@example.com (refused).');
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByText('aspen@example.com')).not.toBeInTheDocument();
    expect(screen.getByText('birch@example.com')).toBeInTheDocument();
  });

  it('counts an address someone else added meanwhile as added', async () => {
    const { api, onClose, field } = setup();
    api.addWorkspaceMember.mockRejectedValue(new ApiError('already', 409, 'already_workspace_member'));
    fireEvent.paste(field, { clipboardData: { getData: () => 'aspen@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add 1 teammate' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  });
});
