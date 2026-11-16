import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../lib/api';
import { MemberAddCard } from './member-add-card';

const api = vi.hoisted(() => ({ addWorkspaceMember: vi.fn() }));
const viewer = vi.hoisted(() => ({ admin: true }));
vi.mock('../lib/collaboration-session', () => ({ useOptionalCollaborationSession: () => ({ api, session: null }) }));
vi.mock('../lib/use-workspace', () => ({ useViewerIsWorkspaceAdmin: () => viewer.admin }));

function mount(onAdded = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><MemberAddCard member={{ email: 'nancy@example.com', name: 'Nancy' }} onAdded={onAdded} /></QueryClientProvider>);
  return onAdded;
}

beforeEach(() => { api.addWorkspaceMember.mockReset(); viewer.admin = true; });

describe('the card that adds someone the agent named', () => {
  it('adds them as a member on an administrator\'s press and answers the question once', async () => {
    api.addWorkspaceMember.mockResolvedValue({ member: { userId: 'u-nancy', email: 'nancy@example.com', role: 'member' }, emailDelivery: 'sent' });
    const onAdded = mount();
    expect(screen.getByRole('article')).toHaveTextContent('Nancynancy@example.com');
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(onAdded).toHaveBeenCalledTimes(1));
    expect(api.addWorkspaceMember).toHaveBeenCalledWith('nancy@example.com', 'member');
    expect(screen.getByRole('button', { name: 'Added' })).toBeDisabled();
  });

  it('counts someone already a member as added', async () => {
    api.addWorkspaceMember.mockRejectedValue(new ApiError('already', 409, 'already_workspace_member'));
    const onAdded = mount();
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(onAdded).toHaveBeenCalledTimes(1));
  });

  it('leaves the press to an administrator, and says who can', () => {
    viewer.admin = false;
    const onAdded = mount();
    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled();
    expect(screen.getByRole('article')).toHaveTextContent('Only admins can add members.');
    expect(onAdded).not.toHaveBeenCalled();
  });
});
