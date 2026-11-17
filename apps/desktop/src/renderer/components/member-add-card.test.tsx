import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../lib/api';
import { MemberAddCard } from './member-add-card';

const api = vi.hoisted(() => ({ addWorkspaceMember: vi.fn() }));
const viewer = vi.hoisted(() => ({ role: 'admin' as string | undefined }));
vi.mock('../lib/collaboration-session', () => ({ useOptionalCollaborationSession: () => ({ api, session: null }) }));
vi.mock('../lib/use-workspace', () => ({
  useWorkspaceQuery: () => ({ data: viewer.role === undefined ? undefined : { currentUser: { role: viewer.role } } }),
}));

function mount(onAdded = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><MemberAddCard member={{ email: 'nancy@example.com', name: 'Nancy' }} onAdded={onAdded} /></QueryClientProvider>);
  return onAdded;
}

beforeEach(() => { api.addWorkspaceMember.mockReset(); viewer.role = 'admin'; });

describe('the card that adds someone the agent named', () => {
  it('adds them as a member on an administrator\'s press and answers the question once', async () => {
    api.addWorkspaceMember.mockResolvedValue({ member: { userId: 'u-nancy', email: 'nancy@example.com', role: 'member' }, emailDelivery: 'sent' });
    const onAdded = mount();
    expect(screen.getByRole('article')).toHaveTextContent('nancy@example.comNancy');
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(onAdded).toHaveBeenCalledTimes(1));
    expect(api.addWorkspaceMember).toHaveBeenCalledWith('nancy@example.com', 'member');
    expect(screen.getByRole('button', { name: 'Added' })).toBeDisabled();
  });

  it('says so when they were added but their email could not be sent', async () => {
    api.addWorkspaceMember.mockResolvedValue({ member: { userId: 'u-nancy', email: 'nancy@example.com', role: 'member' }, emailDelivery: 'failed' });
    const onAdded = mount();
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(onAdded).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('article')).toHaveTextContent('Added, but their email could not be sent. Tell them to sign in with this address.');
  });

  it('counts someone already a member as added', async () => {
    api.addWorkspaceMember.mockRejectedValue(new ApiError('already', 409, 'already_workspace_member'));
    const onAdded = mount();
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(onAdded).toHaveBeenCalledTimes(1));
  });

  it('leaves the press to an administrator, and says who can', () => {
    viewer.role = 'member';
    const onAdded = mount();
    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled();
    expect(screen.getByRole('article')).toHaveTextContent('Only admins can add members.');
    expect(onAdded).not.toHaveBeenCalled();
  });

  it('says nothing about who can add while the role is still loading', () => {
    viewer.role = undefined;
    mount();
    expect(screen.getByRole('article')).not.toHaveTextContent('Only admins can add members.');
  });

  it('shows a refusal and does not answer the question', async () => {
    api.addWorkspaceMember.mockRejectedValue(new ApiError('An account holds that address without having verified it.', 409, 'member_address_unverified'));
    const onAdded = mount();
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(await screen.findByText('nancy@example.com could not be added')).toBeInTheDocument();
    expect(onAdded).not.toHaveBeenCalled();
    // The popup holds focus; the card behind it can be pressed again once it closes.
    expect(screen.getByRole('button', { name: 'Add', hidden: true })).toBeEnabled();
  });

  it('retries a failed answer without adding them again', async () => {
    api.addWorkspaceMember.mockResolvedValue({ member: { userId: 'u-nancy', email: 'nancy@example.com', role: 'member' }, emailDelivery: 'sent' });
    const onAdded = vi.fn<() => Promise<void>>().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
    mount(onAdded);
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(onAdded).toHaveBeenCalledTimes(2));
    expect(api.addWorkspaceMember).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole('button', { name: 'Added' })).toBeDisabled();
  });
});
