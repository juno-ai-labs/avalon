import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { RallyApi } from '../lib/api';
import { ScopeSharingPanel } from './scope-sharing-panel';

const workspaceId = '00000000-0000-4000-8000-000000000001';
const parentId = '00000000-0000-4000-8000-000000000002';
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it.each(['0', '00000000-0000-4000-8000-000000000003'])('shares only conversation %s and reuses the email batch identity on retry', async (substreamId) => {
  const api = new RallyApi('https://api.test', null);
  const diagnostic = 'router invitation failure: operation leaked';
  const create = vi.spyOn(api, 'createScopeInvitations')
    .mockRejectedValueOnce(new Error(diagnostic))
    .mockResolvedValue({ status: 'created', invitations: [] });
  const options = vi.spyOn(api, 'getScopeSharingOptions');
  const invitations = vi.spyOn(api, 'listScopeInvitations');
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
  expect(screen.queryByText(diagnostic)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Share' }));
  await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
  expect(create.mock.calls[1]).toEqual(create.mock.calls[0]);
  expect(create.mock.calls[0]?.[0]).toMatchObject({
    emails: ['ada@example.test', 'bob@example.test', 'carol@example.test', 'dave@example.test'],
    targets: [{ kind: 'conversation', workspaceId, parentId, substreamId }], completeWorkstream: false,
  });
  expect(options).not.toHaveBeenCalled();
  expect(invitations).not.toHaveBeenCalled();
  expect(grants).not.toHaveBeenCalled();
  expect(screen.queryByRole('checkbox')).toBeNull();
  client.clear();
});

it('keeps invalid addresses as authored validation without calling the API', async () => {
  const api = new RallyApi('https://api.test', null);
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
