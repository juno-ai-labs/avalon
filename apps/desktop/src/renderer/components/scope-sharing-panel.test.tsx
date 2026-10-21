import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import * as Tooltip from '@radix-ui/react-tooltip';
import { asSubstreamId, asUserId, asWorkspaceId } from '@rally/contracts';
import type { ScopeInvitationSummary } from '@rally/contracts/scope-grants';
import { ApiError, RallyApi } from '../lib/api';
import { ScopeSharingPanel, ShareConversationDialog } from './scope-sharing-panel';

const workspaceId = '00000000-0000-4000-8000-000000000001';
const parentId = '00000000-0000-4000-8000-000000000002';
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

/** An API whose share list is empty, so a panel that only shares never reaches the network. */
function quietApi(): RallyApi {
  const api = new RallyApi('https://api.test', null);
  vi.spyOn(api, 'listScopeInvitations').mockResolvedValue({ status: 'ready', invitations: [] });
  return api;
}

it.each(['0', '00000000-0000-4000-8000-000000000003'])('shares only conversation %s and reuses the email batch identity on retry', async (substreamId) => {
  const api = quietApi();
  const diagnostic = 'router invitation failure: operation leaked';
  const create = vi.spyOn(api, 'createScopeInvitations')
    .mockRejectedValueOnce(new Error(diagnostic))
    .mockResolvedValue({ status: 'created', invitations: [] });
  const options = vi.spyOn(api, 'getScopeSharingOptions');
  const invitations = vi.mocked(api.listScopeInvitations);
  const grants = vi.spyOn(api, 'listManagedScopeGrants');
  const client = new QueryClient();
  render(<QueryClientProvider client={client}><ScopeSharingPanel api={api}
    workspaceId={workspaceId} parentId={parentId} substreamId={substreamId} /></QueryClientProvider>);
  expect(screen.getByRole('button', { name: 'Share' })).toBeDisabled();
  fireEvent.change(screen.getByRole('textbox', { name: 'Email addresses' }), {
    target: { value: 'Ada@example.test bob@example.test,carol@example.test;dave@example.test\nada@example.test' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Share' }));
  await screen.findByText('The conversation couldn’t be shared. Try again.');
  fireEvent.click(screen.getByRole('button', { name: 'OK' }));
  expect(screen.queryByText(diagnostic)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Share' }));
  await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
  expect(create.mock.calls[1]).toEqual(create.mock.calls[0]);
  expect(create.mock.calls[0]?.[0]).toMatchObject({
    emails: ['ada@example.test', 'bob@example.test', 'carol@example.test', 'dave@example.test'],
    targets: [{ kind: 'conversation', workspaceId, parentId, substreamId }], completeWorkstream: false,
  });
  // A created invitation leaves no confirmation behind: the emptied form is the
  // whole of what a container that stays open shows.
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Email addresses' })).toHaveValue(''));
  expect(screen.queryByRole('status')).toBeNull();
  expect(options).not.toHaveBeenCalled();
  // Read again after the share, so someone just shared with shows up.
  await waitFor(() => expect(invitations).toHaveBeenCalledTimes(2));
  expect(invitations.mock.calls[0]?.[0]).toEqual({ kind: 'conversation', workspaceId, parentId, substreamId });
  expect(grants).not.toHaveBeenCalled();
  expect(screen.queryByRole('checkbox')).toBeNull();
  client.clear();
});

it('keeps invalid addresses as authored validation without calling the API', async () => {
  const api = quietApi();
  const create = vi.spyOn(api, 'createScopeInvitations');
  const client = new QueryClient();
  render(<QueryClientProvider client={client}><ScopeSharingPanel api={api}
    workspaceId={workspaceId} parentId={parentId} substreamId="0" /></QueryClientProvider>);

  fireEvent.change(screen.getByRole('textbox', { name: 'Email addresses' }), { target: { value: 'not-an-email' } });
  fireEvent.click(screen.getByRole('button', { name: 'Share' }));

  expect(await screen.findByText('Enter valid email addresses, separated by spaces, commas, or semicolons.')).toBeVisible();
  expect(create).not.toHaveBeenCalled();
  client.clear();
});

it('dismisses the share dialog once the invitation is created, and not before', async () => {
  const api = quietApi();
  const create = vi.spyOn(api, 'createScopeInvitations')
    .mockRejectedValueOnce(new Error('router invitation failure'))
    .mockResolvedValue({ status: 'created', invitations: [] });
  const client = new QueryClient();
  function Host(): React.JSX.Element {
    const [open, setOpen] = useState(true);
    return <ShareConversationDialog api={api} workspaceId={workspaceId} parentId={parentId}
      substreamId="0" open={open} onOpenChange={setOpen} />;
  }
  render(<QueryClientProvider client={client}><Host /></QueryClientProvider>);

  fireEvent.change(screen.getByRole('textbox', { name: 'Email addresses' }), { target: { value: 'ada@example.test' } });
  fireEvent.click(screen.getByRole('button', { name: 'Share' }));

  // A failed share leaves the dialog open so the retry keeps the typed batch.
  await screen.findByText('The conversation couldn’t be shared. Try again.');
  fireEvent.click(screen.getByRole('button', { name: 'OK' }));
  expect(screen.getByRole('dialog', { name: 'Share conversation' })).toBeVisible();

  fireEvent.click(screen.getByRole('button', { name: 'Share' }));

  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Share conversation' })).toBeNull());
  expect(create).toHaveBeenCalledTimes(2);
  client.clear();
});

it('leaves a reopened dialog alone when the share it was closed during settles', async () => {
  const api = quietApi();
  type ScopeInvitationResult = Awaited<ReturnType<RallyApi['createScopeInvitations']>>;
  let settle: ((result: ScopeInvitationResult) => void) | undefined;
  const create = vi.spyOn(api, 'createScopeInvitations')
    .mockImplementation(() => new Promise<ScopeInvitationResult>((resolve) => { settle = resolve; }));
  const client = new QueryClient();
  function Host(): React.JSX.Element {
    const [open, setOpen] = useState(true);
    return <><button type="button" onClick={() => setOpen(true)}>Open share</button>
      <ShareConversationDialog api={api} workspaceId={workspaceId} parentId={parentId}
        substreamId="0" open={open} onOpenChange={setOpen} /></>;
  }
  render(<QueryClientProvider client={client}><Host /></QueryClientProvider>);

  fireEvent.change(screen.getByRole('textbox', { name: 'Email addresses' }), { target: { value: 'ada@example.test' } });
  fireEvent.click(screen.getByRole('button', { name: 'Share' }));
  await waitFor(() => expect(create).toHaveBeenCalledTimes(1));

  // Dismissed while the request is still in flight, then opened again for a
  // second recipient: the first share's success belongs to a panel that is gone.
  fireEvent.click(screen.getByRole('button', { name: 'Close dialog' }));
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Share conversation' })).toBeNull());
  fireEvent.click(screen.getByRole('button', { name: 'Open share' }));
  await screen.findByRole('dialog', { name: 'Share conversation' });
  fireEvent.change(screen.getByRole('textbox', { name: 'Email addresses' }), { target: { value: 'bob@example.test' } });

  await act(async () => { settle?.({ status: 'created', invitations: [] }); });
  await act(async () => { await Promise.resolve(); });

  expect(screen.getByRole('dialog', { name: 'Share conversation' })).toBeVisible();
  expect(screen.getByRole('textbox', { name: 'Email addresses' })).toHaveValue('bob@example.test');
  client.clear();
});

it('lists people who have not signed in yet as Guests, and removes one', async () => {
  const api = new RallyApi('https://api.test', null);
  const target = { kind: 'conversation' as const, workspaceId: asWorkspaceId(workspaceId), parentId, substreamId: asSubstreamId('0') };
  const waiting: ScopeInvitationSummary = { id: '00000000-0000-4000-8000-000000000010', email: 'new@example.test', targets: [target],
    expiresAt: null, status: 'pending', revision: 1, acceptedByUserId: null };
  const claimed: ScopeInvitationSummary = { ...waiting, id: '00000000-0000-4000-8000-000000000011', email: 'joined@example.test',
    status: 'accepted', acceptedByUserId: asUserId('00000000-0000-4000-8000-000000000012') };
  // Shared twice with the same address: two pending shares, one person.
  const again: ScopeInvitationSummary = { ...waiting, id: '00000000-0000-4000-8000-000000000013', revision: 3 };
  const list = vi.spyOn(api, 'listScopeInvitations')
    .mockResolvedValueOnce({ status: 'ready', invitations: [waiting, claimed, again] })
    .mockResolvedValue({ status: 'ready', invitations: [claimed] });
  const revoke = vi.spyOn(api, 'revokeScopeInvitation').mockResolvedValue({ status: 'revoked', invitation: { ...waiting, status: 'revoked', revision: 2 } });
  const client = new QueryClient();
  render(<QueryClientProvider client={client}><Tooltip.Provider><ScopeSharingPanel api={api}
    workspaceId={workspaceId} parentId={parentId} substreamId="0" /></Tooltip.Provider></QueryClientProvider>);

  const guests = await screen.findByLabelText('Guests who have not signed in yet');
  expect(guests).toHaveTextContent('new@example.test');
  expect(guests).toHaveTextContent('Guest');
  // Someone who already signed in is a participant now, not a pending Guest.
  expect(guests).not.toHaveTextContent('joined@example.test');
  expect(screen.getAllByRole('button', { name: 'Remove new@example.test' })).toHaveLength(1);

  fireEvent.click(screen.getByRole('button', { name: 'Remove new@example.test' }));
  // Removing the person revokes every share that would still let them in.
  await waitFor(() => expect(revoke).toHaveBeenCalledTimes(2));
  expect(revoke).toHaveBeenCalledWith(parentId, waiting.id, 1);
  expect(revoke).toHaveBeenCalledWith(parentId, again.id, 3);
  await waitFor(() => expect(screen.queryByLabelText('Guests who have not signed in yet')).toBeNull());
  expect(list).toHaveBeenCalledTimes(2);
  client.clear();
});

it('says when the Guests waiting to sign in could not be loaded, and retries', async () => {
  const api = new RallyApi('https://api.test', null);
  const list = vi.spyOn(api, 'listScopeInvitations')
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValue({ status: 'ready', invitations: [] });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><Tooltip.Provider><ScopeSharingPanel api={api}
    workspaceId={workspaceId} parentId={parentId} substreamId="0" /></Tooltip.Provider></QueryClientProvider>);
  expect(await screen.findByText('Guests waiting to sign in couldn’t be loaded.')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'OK' }));
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  await waitFor(() => expect(screen.queryByText('Guests waiting to sign in couldn’t be loaded.')).toBeNull());
  expect(list).toHaveBeenCalledTimes(2);
  client.clear();
});

it('says the person already joined when they signed in before Remove was clicked', async () => {
  const api = new RallyApi('https://api.test', null);
  const target = { kind: 'conversation' as const, workspaceId: asWorkspaceId(workspaceId), parentId, substreamId: asSubstreamId('0') };
  const waiting: ScopeInvitationSummary = { id: '00000000-0000-4000-8000-000000000010', email: 'new@example.test', targets: [target],
    expiresAt: null, status: 'pending', revision: 1, acceptedByUserId: null };
  vi.spyOn(api, 'listScopeInvitations').mockResolvedValue({ status: 'ready', invitations: [waiting] });
  vi.spyOn(api, 'revokeScopeInvitation').mockRejectedValue(
    new ApiError('Sharing changed. Refresh the available scopes and try again.', 409, 'scope_revision_conflict'));
  const client = new QueryClient();
  render(<QueryClientProvider client={client}><Tooltip.Provider><ScopeSharingPanel api={api}
    workspaceId={workspaceId} parentId={parentId} substreamId="0" /></Tooltip.Provider></QueryClientProvider>);
  fireEvent.click(await screen.findByRole('button', { name: 'Remove new@example.test' }));
  expect(await screen.findByText('They have already joined. Remove them from the participants instead.')).toBeVisible();
  client.clear();
});
