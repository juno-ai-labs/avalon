import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { RallyApi } from '../lib/api';
import { ScopeSharingPanel } from './scope-sharing-panel';

const workspaceId = '00000000-0000-4000-8000-000000000001';
const parentId = '00000000-0000-4000-8000-000000000002';
const substreamId = '00000000-0000-4000-8000-000000000003';
const invitationId = '00000000-0000-4000-8000-000000000004';
const target = { kind: 'conversation', workspaceId, parentId, substreamId };
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('retries the same email batch and revokes its pending invitation through the scoped API', async () => {
  const attempts: Array<Record<string, unknown>> = [];
  let accepted = false, revoked = false;
  const summary = () => ({ id: invitationId, email: 'guest@example.test', targets: [target],
    expiresAt: null, revision: revoked ? 2 : 1, status: revoked ? 'revoked' : 'pending', acceptedByUserId: null });
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/grants/list')) return Response.json({ status: 'ready', grants: [] });
    if (path.endsWith('/options')) return Response.json({ scopes: [{ target, title: 'This substream' }], completeWorkstreamTargets: null });
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    if (path === '/sharing/list') {
      return Response.json((body.target as { kind: string }).kind === 'workstream'
        ? { status: 'denied', reason: 'sharing_required' }
        : { status: 'ready', invitations: accepted ? [summary()] : [] });
    }
    if (path === '/sharing') {
      attempts.push(body);
      if (attempts.length === 1) return Response.json({ error: { code: 'unavailable', message: 'Try again' } }, { status: 503 });
      accepted = true; return Response.json({ status: 'created', invitations: [summary()] });
    }
    expect(path).toBe(`/sharing/${parentId}/${invitationId}`);
    expect(init?.method).toBe('DELETE'); expect(body).toEqual({ expectedRevision: 1 });
    revoked = true; return Response.json({ status: 'revoked', invitation: summary() });
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><ScopeSharingPanel api={new RallyApi('https://api.test', null)}
    workspaceId={workspaceId} parentId={parentId} substreamId={substreamId} /></QueryClientProvider>);
  fireEvent.change(screen.getByRole('textbox', { name: 'Email addresses' }), { target: { value: 'Guest@example.test guest@example.test' } });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Send invitations' })).not.toBeDisabled());
  fireEvent.click(screen.getByRole('button', { name: 'Send invitations' }));
  await screen.findByText('Try again');
  await waitFor(() => expect(screen.getByRole('button', { name: 'Send invitations' })).not.toBeDisabled());
  fireEvent.click(screen.getByRole('button', { name: 'Send invitations' }));
  await screen.findByText('Invited guest@example.test.');
  expect(attempts).toHaveLength(2);
  expect(attempts[1]).toEqual(attempts[0]);
  expect(attempts[0]).toMatchObject({ emails: ['guest@example.test'], targets: [target], expiresAt: null });
  expect(screen.queryByRole('checkbox', { name: /Complete workstream/ })).toBeNull();
  fireEvent.click(await screen.findByRole('button', { name: 'Revoke invitation for guest@example.test' }));
  await waitFor(() => expect(screen.getByText('guest@example.test — revoked')).toBeTruthy());
  client.clear();
});

it('offers complete workstream coverage only with the owner-provided restricted scopes', async () => {
  let sent: unknown;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    if (new URL(String(input)).pathname.endsWith('/grants/list')) return Response.json({ status: 'ready', grants: [] });
    if (new URL(String(input)).pathname.endsWith('/options')) return Response.json({ scopes: [
      { target: { kind: 'workstream', workspaceId, parentId }, title: 'Main and inheriting substreams' },
      { target, title: 'This substream' }], completeWorkstreamTargets: [{ kind: 'workstream', workspaceId, parentId }, target] });
    const body = JSON.parse(String(init?.body)) as { targets: unknown[] };
    if (new URL(String(input)).pathname === '/sharing/list') return Response.json({ status: 'ready', invitations: [] });
    sent = body.targets;
    return Response.json({ status: 'created', invitations: [{ id: invitationId, email: 'guest@example.test', targets: body.targets,
      expiresAt: null, status: 'pending', revision: 1, acceptedByUserId: null }] });
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><ScopeSharingPanel api={new RallyApi('https://api.test', null)}
    workspaceId={workspaceId} parentId={parentId} substreamId={substreamId} /></QueryClientProvider>);
  fireEvent.click(await screen.findByRole('checkbox', { name: 'Complete workstream, including existing restricted substreams' }));
  expect(screen.getByText('Includes every existing substream and its resources. Future restricted substreams need their own share.')).toBeTruthy();
  fireEvent.change(screen.getByRole('textbox', { name: 'Email addresses' }), { target: { value: 'guest@example.test' } });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Send invitations' })).not.toBeDisabled());
  fireEvent.click(screen.getByRole('button', { name: 'Send invitations' }));
  await screen.findByText('Invited guest@example.test.');
  expect(sent).toEqual([{ kind: 'workstream', workspaceId, parentId }, target]);
  client.clear();
});

it('shares multiple independent conversations without adding workstream authority', async () => {
  const main = { ...target, substreamId: '0' };
  let sent: unknown;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/grants/list')) return Response.json({ status: 'ready', grants: [] });
    if (path.endsWith('/options')) return Response.json({ scopes: [
      { target: main, title: 'Main' }, { target, title: 'This substream' }], completeWorkstreamTargets: null });
    if (path.endsWith('/list')) return Response.json({ status: 'ready', invitations: [] });
    const body = JSON.parse(String(init?.body)) as { targets: unknown[]; completeWorkstream: boolean };
    sent = body.targets; expect(body.completeWorkstream).toBe(false);
    return Response.json({ status: 'created', invitations: [{ id: invitationId, email: 'guest@example.test', targets: body.targets,
      expiresAt: null, status: 'pending', revision: 1, acceptedByUserId: null }] });
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><ScopeSharingPanel api={new RallyApi('https://api.test', null)}
    workspaceId={workspaceId} parentId={parentId} substreamId={substreamId} /></QueryClientProvider>);
  fireEvent.click(await screen.findByRole('checkbox', { name: /^Main$/ }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Email addresses' }), { target: { value: 'guest@example.test' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send invitations' }));
  await screen.findByText('Invited guest@example.test.');
  expect(sent).toEqual([target, main]);
  client.clear();
});


it('removes only the displayed direct grant and preserves its operation identity on retry', async () => {
  const grant = { id: invitationId, userId: '00000000-0000-4000-8000-000000000005', target,
    active: true, revision: 3, membershipIncarnation: 'guest-membership' };
  const attempts: unknown[] = [];
  let removed = false;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/options')) return Response.json({ scopes: [{ target, title: 'This substream' }], completeWorkstreamTargets: null });
    if (path.endsWith('/grants/list')) return Response.json({ status: 'ready', grants: removed ? [] : [{ grant, name: 'Guest', email: 'guest@example.test' }] });
    if (path === '/sharing/list') return Response.json({ status: 'ready', invitations: [] });
    expect(path).toBe('/sharing/grants/revoke');
    attempts.push(JSON.parse(String(init?.body)));
    if (attempts.length === 1) return Response.json({ error: { code: 'unavailable', message: 'Retry removal' } }, { status: 503 });
    removed = true; return Response.json({ status: 'committed', grant: { ...grant, active: false, revision: 4 } });
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><ScopeSharingPanel api={new RallyApi('https://api.test', null)}
    workspaceId={workspaceId} parentId={parentId} substreamId={substreamId} /></QueryClientProvider>);
  fireEvent.click(await screen.findByRole('button', { name: 'Remove guest@example.test from This substream' }));
  await screen.findByText('Retry removal');
  fireEvent.click(screen.getByRole('button', { name: 'Remove guest@example.test from This substream' }));
  await waitFor(() => expect(screen.queryByRole('list', { name: 'Direct shares' })).toBeNull());
  expect(attempts).toHaveLength(2); expect(attempts[0]).toEqual(attempts[1]);
  expect(attempts[0]).toMatchObject({ target, userId: grant.userId, expectedRevision: 3 });
  client.clear();
});
