import * as Tooltip from '@radix-ui/react-tooltip';
import type { SidekickSourceRequestView, SidekickSourcesResult, UserId } from '@rally/contracts';
import { ErrorNoticeProvider } from '@rally/ui/components/error-notice';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../lib/api';
import { sidekickSourcesQueryKey } from '../lib/sidekick-sources';
import type { WakeTrigger } from '@rally/ui/components/sidekick-sources';
import { SidekickSourceRequestCard, SidekickWakesOn } from './sidekick-sources';

/*
 * The conversation's card and the Sidekick details' Wakes on section, through
 * the desktop adapter: what each reader is shown, who can press, and what an
 * answer and a withdrawal send.
 */

const api = vi.hoisted(() => ({
  getSidekickSources: vi.fn(),
  getConnections: vi.fn(),
  getConnectorOAuthAttempt: vi.fn(),
  readSidekickSourceRequests: vi.fn(),
  decideSidekickSourceRequest: vi.fn(),
  withdrawSidekickSource: vi.fn(),
}));
const ME = '00000000-0000-7000-8000-0000000000a1';
const ADAM = '00000000-0000-7000-8000-0000000000a2';
const MAYA = '00000000-0000-7000-8000-0000000000a3';
const PRIYA = '00000000-0000-7000-8000-0000000000a4';
const SIDEKICK = '00000000-0000-7000-8000-0000000000d1';
vi.mock('../lib/collaboration-session', () => ({
  useCollaborationSession: () => ({ api, session: { user: { id: ME, name: 'Me' } }, connectorSetup: {} }),
}));
// The connection action owns its OAuth flow and is tested with the connection card; here it records
// what it was asked to connect, starts the attempt the test names, and the test finishes the sign-in
// as an OAuth callback would.
const connection = vi.hoisted(() => ({
  start: vi.fn<() => Promise<string>>(), request: null as unknown, finish: () => undefined as void,
}));
vi.mock('./connector-mentions', () => ({
  connectorConnectionCardProvider: () => ({ provider: 'google' }),
  useConnectorConnectionAction: (request: unknown, _provider: unknown, options: { onNewlyConnected?: () => void }) => {
    connection.request = request;
    connection.finish = () => options.onNewlyConnected?.();
    return { start: connection.start, pending: false, attemptId: null, unavailable: false, checkingAvailability: false, accountRequired: false,
      accountOptions: undefined, selectedAccountId: '', selectAccount: () => undefined, error: undefined };
  },
}));

function request(id: string, userId: string, displayName: string, overrides: Partial<SidekickSourceRequestView> = {}): SidekickSourceRequestView {
  return {
    requestId: id, sidekickId: SIDEKICK, sidekickName: 'Deals', person: { userId: userId as UserId, displayName },
    connectorType: 'google', eventTypes: ['email.received'], condition: 'it is about a pre-seed round',
    state: 'pending', requestedByName: 'Adam', yours: userId === ME, createdAt: 1, decidedAt: null, ...overrides,
  };
}

let client: QueryClient;
function mount(ui: React.JSX.Element) {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><Tooltip.Provider><ErrorNoticeProvider>{ui}</ErrorNoticeProvider></Tooltip.Provider></QueryClientProvider>);
}

const row = (name: string): HTMLElement => screen.getByText(name).closest('li')!;
const pair = (name: string): Array<{ label: string | null; pressed: string | null; disabled: boolean }> =>
  within(row(name)).getAllByRole('button').map((button) => ({
    label: button.textContent, pressed: button.getAttribute('aria-pressed'), disabled: (button as HTMLButtonElement).disabled,
  }));

beforeEach(() => {
  for (const mock of Object.values(api)) mock.mockReset();
  connection.start.mockReset().mockResolvedValue('attempt-1');
  connection.request = null;
  connection.finish = () => undefined;
});

describe('the source request card in a conversation', () => {
  const card = { sidekickId: SIDEKICK, requestIds: ['r-me', 'r-adam', 'r-maya', 'r-priya', 'r-old'], asked: null };

  it('says what is asked, and draws each person\'s row from the live read: mine to press, everyone else\'s as their choice', async () => {
    api.readSidekickSourceRequests.mockResolvedValue([
      request('r-me', ME, 'Me'),
      request('r-adam', ADAM, 'Adam', { state: 'approved', decidedAt: 2 }),
      request('r-maya', MAYA, 'Maya'),
      request('r-priya', PRIYA, 'Priya', { state: 'declined', decidedAt: 3 }),
      request('r-old', MAYA, 'Maya Lin', { state: 'cancelled' }),
    ]);
    mount(<SidekickSourceRequestCard card={card} />);
    const article = await screen.findByRole('article', { name: 'Source request for Deals' });
    expect(api.readSidekickSourceRequests.mock.calls[0]![0]).toEqual(['r-me', 'r-adam', 'r-maya', 'r-priya', 'r-old']);
    expect(within(article).getByText('Start Deals from Gmail')).toBeInTheDocument();
    expect(within(article).getByText('Email received, only when “it is about a pre-seed round”')).toBeInTheDocument();
    expect(within(article).getByText('Asked by Adam. Only the person asked can answer.')).toBeInTheDocument();
    // Mine, pending: both live. The requester's own, which they approved: Approve filled.
    expect(pair('Me')).toEqual([
      { label: 'Decline', pressed: 'false', disabled: false },
      { label: 'Approve', pressed: 'false', disabled: false },
    ]);
    expect(pair('Adam')).toEqual([
      { label: 'Decline', pressed: 'false', disabled: true },
      { label: 'Approve', pressed: 'true', disabled: true },
    ]);
    // Somebody else's, pending: both shown, neither chosen, neither pressable.
    expect(pair('Maya')).toEqual([
      { label: 'Decline', pressed: 'false', disabled: true },
      { label: 'Approve', pressed: 'false', disabled: true },
    ]);
    expect(pair('Priya')).toEqual([
      { label: 'Decline', pressed: 'true', disabled: true },
      { label: 'Approve', pressed: 'false', disabled: true },
    ]);
    // Replaced by a newer ask: said so, with nothing to press.
    expect(row('Maya Lin')).toHaveTextContent('Replaced by a newer request');
    expect(within(row('Maya Lin')).queryByRole('button')).toBeNull();
  });

  it('paints what the tool answered until the read lands, as this viewer and with nothing pressable, then the live state', async () => {
    let land!: (requests: SidekickSourceRequestView[]) => void;
    api.readSidekickSourceRequests.mockImplementation(() => new Promise((resolve) => { land = resolve; }));
    // The tool's output is the asker's view: `yours` is Adam's, and Maya had not answered.
    mount(<SidekickSourceRequestCard card={{ sidekickId: SIDEKICK, requestIds: ['r-me', 'r-maya'], asked: [
      request('r-me', ME, 'Me', { yours: false }),
      request('r-maya', MAYA, 'Maya'),
    ] }} />);
    expect(screen.getByText('Start Deals from Gmail')).toBeInTheDocument();
    expect(within(row('Me')).getByText('You')).toBeInTheDocument();
    expect(pair('Me').map((button) => button.disabled)).toEqual([true, true]);
    expect(pair('Maya').map((button) => button.pressed)).toEqual(['false', 'false']);
    await act(async () => land([request('r-me', ME, 'Me'), request('r-maya', MAYA, 'Maya', { state: 'approved', decidedAt: 2 })]));
    await waitFor(() => expect(pair('Me').map((button) => button.disabled)).toEqual([false, false]));
    expect(pair('Maya').map((button) => button.pressed)).toEqual(['false', 'true']);
  });

  it('sends my approval for my request and fills Approve from the acknowledged answer', async () => {
    api.readSidekickSourceRequests.mockResolvedValue([request('r-me', ME, 'Me'), request('r-maya', MAYA, 'Maya')]);
    api.decideSidekickSourceRequest.mockResolvedValue(request('r-me', ME, 'Me', { state: 'approved', decidedAt: 5 }));
    mount(<SidekickSourceRequestCard card={{ sidekickId: SIDEKICK, requestIds: ['r-me', 'r-maya'], asked: null }} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Approve your Gmail for Deals' }));
    // The read behind the acknowledgement is still out: the fill is the answer's own.
    api.readSidekickSourceRequests.mockImplementation(() => new Promise(() => {}));
    await waitFor(() => expect(pair('Me')).toEqual([
      { label: 'Decline', pressed: 'false', disabled: true },
      { label: 'Approve', pressed: 'true', disabled: true },
    ]));
    expect(api.decideSidekickSourceRequest.mock.calls).toEqual([[SIDEKICK, 'r-me', 'approve']]);
    expect(pair('Maya').map((button) => button.pressed)).toEqual(['false', 'false']);
  });

  it('says a press is being sent while the answer is out, since the pair is never dimmed', async () => {
    api.readSidekickSourceRequests.mockResolvedValue([request('r-me', ME, 'Me')]);
    // The answer never comes back.
    api.decideSidekickSourceRequest.mockImplementation(() => new Promise(() => {}));
    mount(<SidekickSourceRequestCard card={{ sidekickId: SIDEKICK, requestIds: ['r-me'], asked: null }} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Approve your Gmail for Deals' }));
    const approve = await screen.findByRole('button', { name: 'Approve your Gmail for Deals', busy: true });
    expect(approve).toHaveTextContent('Approving…');
    expect(approve).toBeDisabled();
    // The other answer holds too, and says nothing of its own.
    const decline = screen.getByRole('button', { name: 'Decline your Gmail for Deals' });
    expect(decline).toHaveTextContent('Decline');
    expect(decline).toBeDisabled();
  });

  it('tells a person who approves with nothing connected which account to connect, in a popup, and leaves the request waiting', async () => {
    api.readSidekickSourceRequests.mockResolvedValue([request('r-me', ME, 'Me')]);
    api.decideSidekickSourceRequest.mockRejectedValue(new ApiError('Connect that account first.', 409, 'sidekick_source_connection_missing'));
    mount(<SidekickSourceRequestCard card={{ sidekickId: SIDEKICK, requestIds: ['r-me'], asked: null }} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Approve your Gmail for Deals' }));
    const popup = await screen.findByRole('alertdialog', { name: 'The request could not be answered' });
    expect(popup).toHaveTextContent('Connect your Gmail account first. There is nothing to allow until it is connected.');
    fireEvent.click(within(popup).getByRole('button', { name: 'OK' }));
    await waitFor(() => expect(pair('Me').map((button) => button.disabled)).toEqual([false, false]));
    expect(pair('Me').map((button) => button.pressed)).toEqual(['false', 'false']);
  });

  it('makes my own lapsed request one press: Reconnect Gmail and approve, which approves once the sign-in finishes', async () => {
    api.getConnections.mockResolvedValue([]);
    api.readSidekickSourceRequests.mockResolvedValue([
      request('r-me', ME, 'Me', { connection: 'reconnect_required' }),
      request('r-maya', MAYA, 'Maya', { connection: 'not_connected' }),
    ]);
    api.decideSidekickSourceRequest.mockResolvedValue(request('r-me', ME, 'Me', { state: 'approved', decidedAt: 5, connection: 'connected' }));
    mount(<SidekickSourceRequestCard card={{ sidekickId: SIDEKICK, requestIds: ['r-me', 'r-maya'], asked: null }} />);
    const both = await screen.findByRole('button', { name: 'Reconnect Gmail and approve your Gmail for Deals' });
    // The card says the one thing left for me, and my row has no separate Approve.
    expect(screen.getByRole('article')).toHaveTextContent('Reconnect Gmail and approve Deals');
    expect(screen.queryByRole('button', { name: 'Approve your Gmail for Deals' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Decline your Gmail for Deals' })).toBeEnabled();
    expect(connection.request).toEqual({ connectorId: 'google-mail-calendar', scope: 'personal' });
    // Everyone else is told what is left for that person.
    expect(row('Maya')).toHaveTextContent('Needs to connect Gmail');

    fireEvent.click(both);
    expect(connection.start).toHaveBeenCalledTimes(1);
    expect(api.decideSidekickSourceRequest).not.toHaveBeenCalled();
    // The sign-in finishes: the press's own attempt succeeded and the re-read says the account works.
    api.getConnectorOAuthAttempt.mockResolvedValue({ status: 'succeeded' });
    api.readSidekickSourceRequests.mockResolvedValue([request('r-me', ME, 'Me', { connection: 'connected' }), request('r-maya', MAYA, 'Maya', { connection: 'not_connected' })]);
    await act(async () => connection.finish());
    await waitFor(() => expect(api.decideSidekickSourceRequest).toHaveBeenCalledWith(SIDEKICK, 'r-me', 'approve'));
    expect(api.getConnectorOAuthAttempt).toHaveBeenCalledWith('attempt-1');
  });

  it('approves after a press even when the request reads connected before the sign-in\'s own callback', async () => {
    api.getConnections.mockResolvedValue([]);
    api.readSidekickSourceRequests.mockResolvedValue([request('r-me', ME, 'Me', { connection: 'not_connected' })]);
    api.decideSidekickSourceRequest.mockResolvedValue(request('r-me', ME, 'Me', { state: 'approved', decidedAt: 5, connection: 'connected' }));
    mount(<SidekickSourceRequestCard card={{ sidekickId: SIDEKICK, requestIds: ['r-me'], asked: null }} />);
    api.getConnectorOAuthAttempt.mockResolvedValue({ status: 'succeeded' });
    fireEvent.click(await screen.findByRole('button', { name: 'Connect Gmail and approve your Gmail for Deals' }));
    await waitFor(() => expect(connection.start).toHaveBeenCalledTimes(1));
    // A socket push re-reads the request first; the button leaves before any callback of its own.
    api.readSidekickSourceRequests.mockResolvedValue([request('r-me', ME, 'Me', { connection: 'connected' })]);
    await act(async () => client.invalidateQueries({ queryKey: sidekickSourcesQueryKey(SIDEKICK) }));
    await waitFor(() => expect(api.decideSidekickSourceRequest).toHaveBeenCalledWith(SIDEKICK, 'r-me', 'approve'));
  });

  it('takes the press back when its sign-in is denied, says so, and connecting later elsewhere approves nothing', async () => {
    api.getConnections.mockResolvedValue([]);
    api.readSidekickSourceRequests.mockResolvedValue([request('r-me', ME, 'Me', { connection: 'not_connected' })]);
    api.getConnectorOAuthAttempt.mockResolvedValue({ status: 'denied' });
    mount(<SidekickSourceRequestCard card={{ sidekickId: SIDEKICK, requestIds: ['r-me'], asked: null }} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Connect Gmail and approve your Gmail for Deals' }));
    await waitFor(() => expect(connection.start).toHaveBeenCalledTimes(1));
    // The person cancelled at Google's consent screen; the attempt ends and the card re-reads.
    await act(async () => connection.finish());
    expect(await screen.findByText('Gmail wasn’t connected, so nothing was approved. Try again when you’re ready.')).toBeInTheDocument();
    expect(api.getConnectorOAuthAttempt).toHaveBeenCalledWith('attempt-1');
    // Later they connect Gmail in Settings while this card is still open.
    api.readSidekickSourceRequests.mockResolvedValue([request('r-me', ME, 'Me', { connection: 'connected' })]);
    await act(async () => client.invalidateQueries({ queryKey: sidekickSourcesQueryKey(SIDEKICK) }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Approve your Gmail for Deals' })).toBeEnabled());
    expect(api.decideSidekickSourceRequest).not.toHaveBeenCalled();
  });

  it('records no consent when the sign-in could not start: connecting later elsewhere approves nothing', async () => {
    api.getConnections.mockResolvedValue([]);
    api.readSidekickSourceRequests.mockResolvedValue([request('r-me', ME, 'Me', { connection: 'not_connected' })]);
    api.getConnectorOAuthAttempt.mockResolvedValue({ status: 'succeeded' });
    connection.start.mockRejectedValue(new Error('Rally could not reach Google.'));
    mount(<SidekickSourceRequestCard card={{ sidekickId: SIDEKICK, requestIds: ['r-me'], asked: null }} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Connect Gmail and approve your Gmail for Deals' }));
    await waitFor(() => expect(connection.start).toHaveBeenCalledTimes(1));
    // They give up and connect from the conversation's own connection card instead.
    api.readSidekickSourceRequests.mockResolvedValue([request('r-me', ME, 'Me', { connection: 'connected' })]);
    await act(async () => connection.finish());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Approve your Gmail for Deals' })).toBeEnabled());
    expect(api.decideSidekickSourceRequest).not.toHaveBeenCalled();
  });

  it('spends the press when its sign-in succeeds but the account still does not carry the events', async () => {
    api.getConnections.mockResolvedValue([]);
    api.readSidekickSourceRequests.mockResolvedValue([request('r-me', ME, 'Me', { connection: 'not_connected' })]);
    api.getConnectorOAuthAttempt.mockResolvedValue({ status: 'succeeded' });
    mount(<SidekickSourceRequestCard card={{ sidekickId: SIDEKICK, requestIds: ['r-me'], asked: null }} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Connect Gmail and approve your Gmail for Deals' }));
    await waitFor(() => expect(connection.start).toHaveBeenCalledTimes(1));
    // Signed in, but without the mail grant (unticked at Google): the re-read still says not connected.
    const reads = api.readSidekickSourceRequests.mock.calls.length;
    await act(async () => connection.finish());
    await waitFor(() => expect(api.readSidekickSourceRequests.mock.calls.length).toBeGreaterThan(reads + 1));
    // Days later the grant is added in Settings while the card is open: that is not this press.
    api.readSidekickSourceRequests.mockResolvedValue([request('r-me', ME, 'Me', { connection: 'connected' })]);
    await act(async () => client.invalidateQueries({ queryKey: sidekickSourcesQueryKey(SIDEKICK) }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Approve your Gmail for Deals' })).toBeEnabled());
    expect(api.decideSidekickSourceRequest).not.toHaveBeenCalled();
  });

  it('names the step in the title only where a button does it: a connector no card connects points at Settings', async () => {
    api.readSidekickSourceRequests.mockResolvedValue([request('r-me', ME, 'Me', { connection: 'not_connected', connect: { scope: 'personal', card: null } })]);
    mount(<SidekickSourceRequestCard card={{ sidekickId: SIDEKICK, requestIds: ['r-me'], asked: null }} />);
    expect(await screen.findByText('Connect Gmail in Settings, then approve here')).toBeInTheDocument();
    expect(screen.getByText('Start Deals from Gmail')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /and approve/ })).toBeNull();
  });

  it('takes the press back on Decline: a sign-in finishing afterwards approves nothing', async () => {
    api.getConnections.mockResolvedValue([]);
    api.readSidekickSourceRequests.mockResolvedValue([request('r-me', ME, 'Me', { connection: 'not_connected' })]);
    api.decideSidekickSourceRequest.mockResolvedValue(request('r-me', ME, 'Me', { state: 'pending', connection: 'not_connected' }));
    mount(<SidekickSourceRequestCard card={{ sidekickId: SIDEKICK, requestIds: ['r-me'], asked: null }} />);
    api.getConnectorOAuthAttempt.mockResolvedValue({ status: 'succeeded' });
    fireEvent.click(await screen.findByRole('button', { name: 'Connect Gmail and approve your Gmail for Deals' }));
    await waitFor(() => expect(connection.start).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: 'Decline your Gmail for Deals' }));
    await waitFor(() => expect(api.decideSidekickSourceRequest).toHaveBeenCalledWith(SIDEKICK, 'r-me', 'decline'));
    api.readSidekickSourceRequests.mockResolvedValue([request('r-me', ME, 'Me', { connection: 'connected' })]);
    await act(async () => connection.finish());
    await waitFor(() => expect(api.readSidekickSourceRequests.mock.calls.length).toBeGreaterThan(1));
    expect(api.decideSidekickSourceRequest.mock.calls.map((call) => call[2])).toEqual(['decline']);
  });

  it('leaves an Organization-only connector to an admin: no connect press, and Approve waits', async () => {
    api.getConnections.mockResolvedValue([]);
    api.readSidekickSourceRequests.mockResolvedValue([request('r-me', ME, 'Me', {
      connectorType: 'granola', eventTypes: ['note.generated'], connection: 'not_connected', connect: { scope: 'workspace', card: null } })]);
    mount(<SidekickSourceRequestCard card={{ sidekickId: SIDEKICK, requestIds: ['r-me'], asked: null }} />);
    expect(await screen.findByText('Needs an admin to connect Granola for the Organization in Settings')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /and approve/ })).toBeNull();
    expect(screen.getByRole('article')).not.toHaveTextContent('Connect Granola and approve');
    expect(connection.start).not.toHaveBeenCalled();
  });

  it('sends no approval when my account is connected some other way while the card is open', async () => {
    api.getConnections.mockResolvedValue([]);
    api.readSidekickSourceRequests.mockResolvedValue([request('r-me', ME, 'Me', { connection: 'not_connected' })]);
    mount(<SidekickSourceRequestCard card={{ sidekickId: SIDEKICK, requestIds: ['r-me'], asked: null }} />);
    await screen.findByRole('button', { name: 'Connect Gmail and approve your Gmail for Deals' });
    api.readSidekickSourceRequests.mockResolvedValue([request('r-me', ME, 'Me', { connection: 'connected' })]);
    await act(async () => connection.finish());
    // The ordinary Approve comes back, unpressed: connecting was not consent on its own.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Approve your Gmail for Deals' })).toBeEnabled());
    expect(api.decideSidekickSourceRequest).not.toHaveBeenCalled();
    expect(api.getConnectorOAuthAttempt).not.toHaveBeenCalled();
  });

  it('re-reads when the Sidekick\'s sources are invalidated, which is what the socket\'s pushes do', async () => {
    api.readSidekickSourceRequests.mockResolvedValue([request('r-maya', MAYA, 'Maya')]);
    mount(<SidekickSourceRequestCard card={{ sidekickId: SIDEKICK, requestIds: ['r-maya'], asked: null }} />);
    await waitFor(() => expect(pair('Maya').map((button) => button.pressed)).toEqual(['false', 'false']));
    api.readSidekickSourceRequests.mockResolvedValue([request('r-maya', MAYA, 'Maya', { state: 'declined', decidedAt: 4 })]);
    await act(async () => client.invalidateQueries({ queryKey: sidekickSourcesQueryKey(SIDEKICK) }));
    await waitFor(() => expect(pair('Maya').map((button) => button.pressed)).toEqual(['true', 'false']));
  });

  it('keeps a failed read behind a Details button rather than interrupting the feed', async () => {
    api.readSidekickSourceRequests.mockRejectedValue(new Error('Read unavailable'));
    mount(<SidekickSourceRequestCard card={{ sidekickId: SIDEKICK, requestIds: ['r-maya'], asked: null }} />);
    expect(await screen.findByText('This request is not available.')).toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    expect(await screen.findByRole('alertdialog', { name: 'The request could not be loaded' })).toHaveTextContent('Read unavailable');
  });
});

describe('the Sidekick details\' Wakes on section', () => {
  const triggers: WakeTrigger[] = [
    { key: 'schedule', icon: null, summary: 'Every Friday at 2:00 PM' },
    { key: 'mail', icon: null, summary: 'When mail arrives about a round', listensFor: { connectorType: 'google', eventTypes: ['email.received'] } },
    { key: 'slack', icon: null, summary: 'When #deals mentions a round', listensFor: { connectorType: 'slack', eventTypes: ['message.posted'] },
      organizationAccount: { connectorType: 'slack', name: 'Rally Slack' } },
  ];
  const sources = (overrides: Partial<SidekickSourcesResult> = {}): SidekickSourcesResult => ({
    sidekickId: SIDEKICK,
    sources: [
      { person: { userId: ME as UserId, displayName: 'Me' }, connectionId: 'c-me', connectionName: 'me@rally.test', connectorType: 'google',
        eventTypes: ['email.received'], condition: 'it is about a pre-seed round', available: true, yours: true },
      { person: { userId: MAYA as UserId, displayName: 'Maya' }, connectionId: 'c-maya', connectionName: 'maya@rally.test', connectorType: 'google',
        eventTypes: ['email.received', 'calendar.event_changed'], condition: null, available: false, yours: false },
    ],
    requests: [
      request('r-me', ME, 'Me', { connectorType: 'slack', eventTypes: ['message.posted'], condition: null }),
      request('r-priya', PRIYA, 'Priya', { state: 'declined', decidedAt: 3 }),
    ],
    ...overrides,
  });
  const MAIL = 'Accounts for When mail arrives about a round';
  const SLACK = 'Accounts for When #deals mentions a round';
  const section = (): HTMLElement => screen.getByRole('region', { name: 'Wakes on' });
  const item = (list: string, name: string): HTMLElement =>
    within(within(section()).getByRole('list', { name: list })).getByText(name).closest('li')!;
  const wakesOn = <SidekickWakesOn id={SIDEKICK} triggers={triggers} />;

  it('lists each trigger with its condition, and under each event trigger the accounts that feed it: the Organization\'s, each person\'s source, and each person asked', async () => {
    api.getSidekickSources.mockResolvedValue(sources());
    mount(wakesOn);
    await screen.findByRole('list', { name: MAIL });
    expect(within(within(section()).getByRole('list', { name: 'Triggers' })).getAllByText(/^(Every|When) /u).map((line) => line.textContent))
      .toEqual(['Every Friday at 2:00 PM', 'When mail arrives about a round', 'When #deals mentions a round']);
    // A schedule is fed by no account.
    expect(within(section()).queryByRole('list', { name: 'Accounts for Every Friday at 2:00 PM' })).toBeNull();
    expect(item(MAIL, 'Me')).toHaveTextContent('MeYoume@rally.test · Email receivedOnly when “it is about a pre-seed round”Stop allowing');
    expect(item(MAIL, 'Maya')).toHaveTextContent('Mayamaya@rally.test · Email received, Calendar event changedUnavailable — restore Organization membership');
    // Only the viewer's own source can be withdrawn here.
    expect(within(item(MAIL, 'Maya')).queryByRole('button')).toBeNull();
    expect(item(MAIL, 'Priya')).toHaveTextContent('PriyaAsked by Adam · Email received in GmailOnly when “it is about a pre-seed round”Declined');
    expect(within(item(MAIL, 'Priya')).queryByRole('button')).toBeNull();
    // The Organization's connection needs nobody's source, and the viewer's own pending request is theirs to answer.
    expect(item(SLACK, 'Rally Slack')).toHaveTextContent('Rally SlackOrganization account');
    expect(item(SLACK, 'Me')).toHaveTextContent('Asked by Adam · Message posted in Slack');
    expect(within(item(SLACK, 'Me')).getAllByRole('button').map((button) => button.getAttribute('aria-label')))
      .toEqual(['Decline your Slack for Deals', 'Approve your Slack for Deals']);
    // Each account sits under the trigger it feeds and nowhere else.
    expect(within(within(section()).getByRole('list', { name: SLACK })).queryByText('Maya')).toBeNull();
    expect(within(section()).queryByRole('list', { name: 'Other accounts' })).toBeNull();
  });

  it('keeps an account no trigger listens for in view, under Other accounts, where its person can still take it back', async () => {
    api.getSidekickSources.mockResolvedValue(sources({
      sources: [{ person: { userId: ME as UserId, displayName: 'Me' }, connectionId: 'c-cal', connectionName: 'me@rally.test', connectorType: 'google',
        eventTypes: ['calendar.event_changed'], condition: null, available: true, yours: true }],
      requests: [],
    }));
    mount(wakesOn);
    await screen.findByRole('list', { name: 'Other accounts' });
    expect(item('Other accounts', 'Me')).toHaveTextContent('MeYoume@rally.test · Calendar event changedStop allowing');
    expect(within(section()).getByText('Allowed or asked for events no trigger above listens for.')).toBeInTheDocument();
    expect(within(section()).queryByRole('list', { name: MAIL })).toBeNull();
  });

  it('holds my Approve while my account lapsed and points me at the request\'s conversation, with no connect card of its own', async () => {
    api.getSidekickSources.mockResolvedValue(sources({ requests: [request('r-me', ME, 'Me', { connection: 'reconnect_required' })] }));
    mount(wakesOn);
    await screen.findByRole('list', { name: MAIL });
    expect(within(item(MAIL, 'Asked by Adam · Email received in Gmail'))
      .getByText('Reconnect Gmail from the request in its conversation first')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Connect card/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Approve your Gmail for Deals' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Decline your Gmail for Deals' })).toBeEnabled();
  });

  it('tells me an admin connects an Organization-only connector, rather than sending me to the conversation', async () => {
    api.getSidekickSources.mockResolvedValue(sources({ sources: [], requests: [request('r-me', ME, 'Me', {
      connectorType: 'granola', eventTypes: ['note.generated'], connection: 'not_connected', connect: { scope: 'workspace', card: null } })] }));
    mount(wakesOn);
    await screen.findByRole('list', { name: 'Other accounts' });
    expect(item('Other accounts', 'Me')).toHaveTextContent('Needs an admin to connect Granola');
    expect(item('Other accounts', 'Me')).not.toHaveTextContent('from the request in its conversation');
  });

  it('says so under an event trigger no person\'s account feeds, and not under one the Organization\'s connection does', async () => {
    let answer: (result: SidekickSourcesResult) => void = () => undefined;
    api.getSidekickSources.mockReturnValue(new Promise<SidekickSourcesResult>((resolve) => { answer = resolve; }));
    mount(wakesOn);
    const mail = (): HTMLElement => within(section()).getByText('When mail arrives about a round').closest('li')!;
    expect(within(mail()).getByRole('status')).toHaveTextContent('Loading accounts…');
    answer(sources({ sources: [], requests: [] }));
    await waitFor(() => expect(mail()).toHaveTextContent('When mail arrives about a roundNo person’s account lets these events in.'));
    expect(within(section()).getAllByText('No person’s account lets these events in.')).toHaveLength(1);
    expect(item(SLACK, 'Rally Slack')).toBeInTheDocument();
  });

  it('withdraws my own source by its connection and drops it on the acknowledgement', async () => {
    api.getSidekickSources.mockResolvedValue(sources());
    api.withdrawSidekickSource.mockResolvedValue({ withdrawn: true });
    mount(wakesOn);
    fireEvent.click(await screen.findByRole('button', { name: 'Stop allowing me@rally.test' }));
    // The read behind the acknowledgement is still out.
    api.getSidekickSources.mockImplementation(() => new Promise(() => {}));
    await waitFor(() => expect(within(within(section()).getByRole('list', { name: MAIL })).queryByText('me@rally.test · Email received')).toBeNull());
    expect(api.withdrawSidekickSource.mock.calls).toEqual([[SIDEKICK, 'c-me']]);
    expect(item(MAIL, 'Maya')).toBeInTheDocument();
  });

  it('declines my own request from the details and reads it as declined', async () => {
    api.getSidekickSources.mockResolvedValue(sources());
    api.decideSidekickSourceRequest.mockResolvedValue(
      request('r-me', ME, 'Me', { connectorType: 'slack', eventTypes: ['message.posted'], condition: null, state: 'declined', decidedAt: 6 }),
    );
    mount(wakesOn);
    fireEvent.click(await screen.findByRole('button', { name: 'Decline your Slack for Deals' }));
    api.getSidekickSources.mockImplementation(() => new Promise(() => {}));
    await waitFor(() => expect(item(SLACK, 'Me')).toHaveTextContent('Declined'));
    expect(api.decideSidekickSourceRequest.mock.calls).toEqual([[SIDEKICK, 'r-me', 'decline']]);
    expect(within(item(SLACK, 'Me')).queryByRole('button')).toBeNull();
  });

  it('names a refused answer in a popup: a request somebody already settled', async () => {
    api.getSidekickSources.mockResolvedValue(sources());
    api.decideSidekickSourceRequest.mockRejectedValue(new ApiError('settled', 409, 'sidekick_source_request_settled'));
    mount(wakesOn);
    fireEvent.click(await screen.findByRole('button', { name: 'Approve your Slack for Deals' }));
    expect(await screen.findByRole('alertdialog', { name: 'The request could not be answered' })).toHaveTextContent('This request was already answered.');
  });
});
