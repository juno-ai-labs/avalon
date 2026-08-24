import * as Tooltip from '@radix-ui/react-tooltip';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Workspace, WorkstreamSummary } from '../lib/types';
import { clearAllDrafts } from '../lib/draft-cache';
import { NewWorkstreamScreen } from './new-workstream';

const api = vi.hoisted(() => ({
  createWorkstream: vi.fn(),
  deleteDraftResource: vi.fn(),
  getWorkspaceMembers: vi.fn(),
  getWorkOpportunities: vi.fn(),
  recordWorkOpportunityImpressions: vi.fn(),
  dismissWorkOpportunity: vi.fn(),
  startWorkOpportunity: vi.fn(),
  uploadResource: vi.fn(),
}));

vi.mock('../lib/app-session', () => ({ useAppSession: () => ({ api }) }));

const workspaceSocket = vi.hoisted(() => ({
  createMessage: vi.fn(),
  listWorkstreams: vi.fn(),
  sidebarConnect: { generation: 1, nextCursor: null },
  state: 'connected' as const,
}));

vi.mock('../lib/workspace-socket', () => ({
  useWorkspaceSocket: () => workspaceSocket,
}));

// The composer offers its model selector only while Application → Developer →
// Debug enabled is on, so this bridge is what turns the control on and off.
const applicationSettings = vi.hoisted(() => ({
  current: { lockdownMode: false, lockdownAvailable: false, debugEnabled: false },
  listeners: new Set<(settings: unknown) => void>(),
}));

vi.mock('../lib/platform', () => ({
  desktopBridge: () => ({
    getApplicationSettings: () => Promise.resolve(applicationSettings.current),
    onApplicationSettingsChanged: (listener: (settings: unknown) => void) => {
      applicationSettings.listeners.add(listener);
      return () => applicationSettings.listeners.delete(listener);
    },
  }),
}));

/** The main-process broadcast a change in the Settings window arrives on. */
function announceApplicationSettings(settings: typeof applicationSettings.current): void {
  applicationSettings.current = settings;
  act(() => {
    for (const listener of applicationSettings.listeners) listener(settings);
  });
}

const currentUser = { id: 'user-1', name: 'Morgan Ellis', email: 'adam@example.com', timezone: 'America/Los_Angeles' };
const teammate = { id: 'user-2', name: 'Samantha Lee', email: 'samantha@example.com', timezone: 'America/Los_Angeles' };
const workspace: Workspace = {
  id: 'workspace-1',
  name: 'Avalon Studio',
  region: 'global',
  timezone: 'America/Los_Angeles',
  logAgentInference: false,
  currentUser,
};
const createdWorkstream = {
  workstream: workstream('new-workstream', 'Prepare the launch brief', 'running'),
  messageId: 'message-new-workstream',
  clientMessageId: 'client-new-workstream',
  createdAt: '2026-07-31T20:00:00.000Z',
  harnessRunId: 'run-new-workstream',
};

function workstream(
  id: string,
  title: string,
  harnessStatus: WorkstreamSummary['harnessStatus'],
  overrides: Partial<WorkstreamSummary> = {},
): WorkstreamSummary {
  return {
    id,
    title,
    titleStatus: 'settled',
    origin: 'ad_hoc',
    harnessStatus,
    scope: 'workspace',
    lastActivityAt: '2026-07-31T20:00:00.000Z',
    latestAttentionSequenceNumber: 0,
    readThroughSequenceNumber: 0,
    manualUnreadFromSequenceNumber: null,
    manualUnreadGeneration: 0,
    hasUnread: false,
    firstUnreadSequenceNumber: null,
    nextPendingWakeup: null,
    pinPosition: null,
    preview: `${title} preview`,
    ...overrides,
  };
}

function renderScreen(): QueryClient {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  render(
    <Tooltip.Provider>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/workstreams/new']}>
          <Routes>
            <Route element={<NewWorkstreamScreen workspace={workspace} />} path="/workstreams/new" />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </Tooltip.Provider>,
  );
  return queryClient;
}

describe('New work-stream home', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    applicationSettings.current = { lockdownMode: false, lockdownAvailable: false, debugEnabled: false };
    applicationSettings.listeners.clear();
    await clearAllDrafts();
    vi.stubGlobal('ResizeObserver', class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    });
    api.getWorkspaceMembers.mockResolvedValue([currentUser, teammate]);
    const directoryPage = {
      items: [
        workstream('waiting', 'Board decision', 'needs_input'),
        workstream('running', 'Pricing restructure', 'running'),
        workstream('completed', 'Release notes', 'completed'),
        workstream('failed', 'Broken connector', 'failed'),
      ],
      nextCursor: null,
    };
    workspaceSocket.listWorkstreams.mockResolvedValue(directoryPage);
    api.getWorkOpportunities.mockResolvedValue([]);
    api.recordWorkOpportunityImpressions.mockResolvedValue(undefined);
    api.dismissWorkOpportunity.mockResolvedValue(undefined);
    api.startWorkOpportunity.mockResolvedValue(createdWorkstream);
    api.createWorkstream.mockResolvedValue(createdWorkstream);
    api.deleteDraftResource.mockResolvedValue(undefined);
    api.uploadResource.mockResolvedValue({
      id: 'resource-notes',
      title: 'notes.txt',
      resourceType: 'uploaded_file',
      provider: 'avalon_upload',
      mimeType: 'text/plain',
      watchEnabled: false,
      watchStatus: 'unsupported',
      contentAvailable: true,
      sizeBytes: 5,
    });
  });

  it('shows only work streams waiting for input', async () => {
    renderScreen();

    expect(await screen.findByRole('heading', { name: 'Welcome back, Adam' })).toBeVisible();
    const attention = await screen.findByRole('region', { name: 'Needs attention' });
    expect(within(attention).getByRole('link', { name: /Board decision/u })).toHaveAttribute('href', '/workstreams/waiting');
    expect(within(attention).getByText('Needs input')).toBeVisible();
    expect(screen.queryByText('Pricing restructure')).not.toBeInTheDocument();
    expect(screen.queryByText('Release notes')).not.toBeInTheDocument();
    expect(screen.queryByText('Broken connector')).not.toBeInTheDocument();
  });

  it('lists a work stream this person has never opened, newest activity first', async () => {
    workspaceSocket.listWorkstreams.mockResolvedValue({
      items: [
        workstream('waiting', 'Board decision', 'needs_input', { lastActivityAt: '2026-07-31T18:00:00.000Z' }),
        // Running, so nothing about the work stream itself puts it here: it is
        // listed because this person was added and has not opened it.
        workstream('unseen', 'Warehouse migration', 'running', {
          lastActivityAt: '2026-07-31T20:00:00.000Z',
          unseen: true,
        }),
        workstream('running', 'Pricing restructure', 'running', { lastActivityAt: '2026-07-31T21:00:00.000Z' }),
      ],
      nextCursor: null,
    });
    renderScreen();

    const attention = await screen.findByRole('region', { name: 'Needs attention' });
    const rows = within(attention).getAllByRole('link');
    expect(rows.map((row) => row.getAttribute('href')))
      .toEqual(['/workstreams/unseen', '/workstreams/waiting']);
    // The marker says the room is new rather than what its run is doing.
    expect(within(rows[0]!).getByText('New to you')).toBeInTheDocument();
    expect(within(rows[0]!).queryByText('Running')).not.toBeInTheDocument();
    expect(screen.queryByText('Pricing restructure')).not.toBeInTheDocument();
  });

  it('lists the work streams that mention this person and the ones they have not read', async () => {
    workspaceSocket.listWorkstreams.mockResolvedValue({
      items: [
        workstream('mentioned', 'Launch blockers', 'running', {
          lastActivityAt: '2026-07-31T21:00:00.000Z',
          youAreMentioned: true,
          hasUnread: true,
        }),
        workstream('unread', 'Vendor contract', 'completed', {
          lastActivityAt: '2026-07-31T19:00:00.000Z',
          hasUnread: true,
        }),
        workstream('read', 'Pricing restructure', 'running', { lastActivityAt: '2026-07-31T22:00:00.000Z' }),
      ],
      nextCursor: null,
    });
    renderScreen();

    const attention = await screen.findByRole('region', { name: 'Needs attention' });
    const rows = within(attention).getAllByRole('link');
    expect(rows.map((row) => row.getAttribute('href')))
      .toEqual(['/workstreams/mentioned', '/workstreams/unread']);
    expect(within(rows[0]!).getByText('You were mentioned')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('Unread')).toBeInTheDocument();
    // Nothing is asking anything of this person here, however recently it moved.
    expect(screen.queryByText('Pricing restructure')).not.toBeInTheDocument();
  });

  it('shows only the short ranked prompt, records its impression, and starts the displayed version', async () => {
    api.getWorkOpportunities.mockResolvedValue([{
      id: '00000000-0000-7000-8000-000000000099',
      version: 3,
      displayPrompt: 'Prepare the follow-up for the unresolved launch blocker',
      icon: 'brand-slack',
      sourceLabel: 'From slack',
    }]);
    renderScreen();

    const suggestions = await screen.findByRole('region', { name: 'Suggested work' });
    expect(within(suggestions).getByText('Prepare the follow-up for the unresolved launch blocker')).toBeVisible();
    expect(within(suggestions).getByText('From slack')).toBeVisible();
    await waitFor(() => expect(api.recordWorkOpportunityImpressions).toHaveBeenCalledWith([
      '00000000-0000-7000-8000-000000000099',
    ]));

    fireEvent.click(within(suggestions).getByRole('button', {
      name: 'Prepare the follow-up for the unresolved launch blocker',
    }));
    await waitFor(() => expect(api.startWorkOpportunity).toHaveBeenCalledWith(
      '00000000-0000-7000-8000-000000000099',
      3,
      expect.any(String),
      'workspace_home',
      1,
    ));
  });

  it('uses the shared mention, attachment, and dictation controls', async () => {
    renderScreen();

    expect(await screen.findByRole('button', { name: 'Mention a participant or connection' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Attach a file' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Click or hold to dictate' })).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Mention a participant or connection' }));
    expect(await screen.findByRole('dialog', { name: 'Add people' })).toBeVisible();
  });

  it('keeps participant selection above the composer and sends selected people', async () => {
    renderScreen();

    const modifier = await screen.findByRole('button', { name: 'Manage participants: Morgan Ellis' });
    expect(modifier).toBeVisible();
    fireEvent.click(modifier);

    const dialog = await screen.findByRole('dialog', { name: 'Add people' });
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /Samantha Lee/u }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Done' }));

    expect(screen.getByRole('button', { name: 'Manage participants: Morgan Ellis, Samantha Lee' })).toHaveTextContent('Morgan Ellis, Samantha Lee');
    expect(screen.getByRole('button', { name: 'Add people' })).toBeVisible();
    const composer = screen.getByRole('textbox', { name: 'Opening work-stream message' });
    fireEvent.change(composer, { target: { value: '  Prepare the launch brief  ' } });
    fireEvent.keyDown(composer, { key: 'Enter' });

    await waitFor(() => expect(api.createWorkstream).toHaveBeenCalledWith({
      openingMessage: 'Prepare the launch brief',
      participantIds: ['user-2'],
      // The create request travels under the trace id the screen printed;
      // asserted as present rather than by value so the exact-shape check that
      // proves `modelOverride` is absent keeps working.
      requestId: expect.any(String),
    }));
  });

  it('focuses the first member when the participant picker opens', async () => {
    renderScreen();

    fireEvent.click(await screen.findByRole('button', { name: 'Manage participants: Morgan Ellis' }));

    const dialog = await screen.findByRole('dialog', { name: 'Add people' });
    await waitFor(() => expect(within(dialog).getByRole('checkbox', { name: /Samantha Lee/u })).toHaveFocus());
    expect(within(dialog).getByRole('button', { name: 'Close dialog' })).not.toHaveFocus();
  });

  it('focuses Done when the participant picker has no available members', async () => {
    api.getWorkspaceMembers.mockResolvedValue([currentUser]);
    renderScreen();

    fireEvent.click(await screen.findByRole('button', { name: 'Manage participants: Morgan Ellis' }));

    const dialog = await screen.findByRole('dialog', { name: 'Add people' });
    expect(within(dialog).queryByRole('checkbox')).not.toBeInTheDocument();
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Done' })).toHaveFocus());
    expect(within(dialog).getByRole('button', { name: 'Close dialog' })).not.toHaveFocus();
  });

  it('hides the model selector unless developer mode is on', async () => {
    renderScreen();

    await screen.findByRole('textbox', { name: 'Opening work-stream message' });
    expect(screen.queryByRole('button', { name: /^Model:/ })).not.toBeInTheDocument();
  });

  it('sends no model override until developer mode picks one', async () => {
    applicationSettings.current = { lockdownMode: false, lockdownAvailable: false, debugEnabled: true };
    renderScreen();

    // Unpinned is its own state, named for what it is rather than for a model
    // the renderer cannot know the flag will serve.
    await screen.findByRole('button', { name: 'Model: Default (follows the agent-model-workstream flag)' });
    const composer = screen.getByRole('textbox', { name: 'Opening work-stream message' });
    fireEvent.change(composer, { target: { value: 'Prepare the launch brief' } });
    fireEvent.keyDown(composer, { key: 'Enter' });

    await waitFor(() => expect(api.createWorkstream).toHaveBeenCalledWith({
      openingMessage: 'Prepare the launch brief',
      participantIds: [],
      requestId: expect.any(String),
    }));
  });

  it('pins the work stream to the model chosen in developer mode', async () => {
    applicationSettings.current = { lockdownMode: false, lockdownAvailable: false, debugEnabled: true };
    renderScreen();

    const selector = await screen.findByRole('button', { name: 'Model: Default (follows the agent-model-workstream flag)' });
    fireEvent.pointerDown(selector, { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'DeepSeek V4 Pro' }));

    await screen.findByRole('button', { name: 'Model: DeepSeek V4 Pro' });
    const composer = screen.getByRole('textbox', { name: 'Opening work-stream message' });
    fireEvent.change(composer, { target: { value: 'Prepare the launch brief' } });
    fireEvent.keyDown(composer, { key: 'Enter' });

    await waitFor(() => expect(api.createWorkstream).toHaveBeenCalledWith({
      openingMessage: 'Prepare the launch brief',
      participantIds: [],
      modelOverride: 'deepseek/deepseek-v4-pro',
      requestId: expect.any(String),
    }));
  });

  it('pins the flag’s own default model as a deliberate, visible choice', async () => {
    applicationSettings.current = { lockdownMode: false, lockdownAvailable: false, debugEnabled: true };
    renderScreen();

    // The first listed model is still a choice someone can make, and making it
    // has to look different from never having touched the control — which it
    // would not if unpinned borrowed that model's value.
    const selector = await screen.findByRole('button', { name: 'Model: Default (follows the agent-model-workstream flag)' });
    fireEvent.pointerDown(selector, { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'Grok 4.3' }));
    await screen.findByRole('button', { name: 'Model: Grok 4.3' });

    const composer = screen.getByRole('textbox', { name: 'Opening work-stream message' });
    fireEvent.change(composer, { target: { value: 'Prepare the launch brief' } });
    fireEvent.keyDown(composer, { key: 'Enter' });
    await waitFor(() => expect(api.createWorkstream).toHaveBeenCalledWith({
      openingMessage: 'Prepare the launch brief',
      participantIds: [],
      modelOverride: 'x-ai/grok-4.3',
      requestId: expect.any(String),
    }));
  });

  it('releases a pin back to the flag without leaving the screen', async () => {
    applicationSettings.current = { lockdownMode: false, lockdownAvailable: false, debugEnabled: true };
    renderScreen();

    const selector = await screen.findByRole('button', { name: 'Model: Default (follows the agent-model-workstream flag)' });
    fireEvent.pointerDown(selector, { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'DeepSeek V4 Pro' }));
    await screen.findByRole('button', { name: 'Model: DeepSeek V4 Pro' });

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Model: DeepSeek V4 Pro' }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'Default' }));
    await screen.findByRole('button', { name: 'Model: Default (follows the agent-model-workstream flag)' });

    const composer = screen.getByRole('textbox', { name: 'Opening work-stream message' });
    fireEvent.change(composer, { target: { value: 'Prepare the launch brief' } });
    fireEvent.keyDown(composer, { key: 'Enter' });
    await waitFor(() => expect(api.createWorkstream).toHaveBeenCalledWith({
      openingMessage: 'Prepare the launch brief',
      participantIds: [],
      requestId: expect.any(String),
    }));
  });

  it('releases the pin when developer mode is turned off under it', async () => {
    applicationSettings.current = { lockdownMode: false, lockdownAvailable: false, debugEnabled: true };
    renderScreen();

    const selector = await screen.findByRole('button', { name: 'Model: Default (follows the agent-model-workstream flag)' });
    fireEvent.pointerDown(selector, { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'GPT-5.6 Luna' }));
    await screen.findByRole('button', { name: 'Model: GPT-5.6 Luna' });

    // The control goes away with the preference. A pin surviving it would keep
    // pinning every work stream started here with nothing on screen saying so.
    announceApplicationSettings({ lockdownMode: false, lockdownAvailable: false, debugEnabled: false });
    await waitFor(() => expect(screen.queryByRole('button', { name: /^Model:/ })).not.toBeInTheDocument());

    const composer = screen.getByRole('textbox', { name: 'Opening work-stream message' });
    fireEvent.change(composer, { target: { value: 'Prepare the launch brief' } });
    fireEvent.keyDown(composer, { key: 'Enter' });

    await waitFor(() => expect(api.createWorkstream).toHaveBeenCalledWith({
      openingMessage: 'Prepare the launch brief',
      participantIds: [],
      requestId: expect.any(String),
    }));
  });

  it('clears the submitted message before the create request settles and blocks duplicate submission', async () => {
    let resolveCreate!: (value: typeof createdWorkstream) => void;
    api.createWorkstream.mockReturnValue(new Promise((resolve) => {
      resolveCreate = resolve;
    }));
    renderScreen();

    const composer = await screen.findByRole('textbox', { name: 'Opening work-stream message' });
    fireEvent.change(composer, { target: { value: 'Create this once' } });
    fireEvent.keyDown(composer, { key: 'Enter' });
    fireEvent.keyDown(composer, { key: 'Enter' });

    expect(composer).toHaveValue('');
    await waitFor(() => expect(api.createWorkstream).toHaveBeenCalledTimes(1));
    expect(api.createWorkstream).toHaveBeenCalledWith({
      openingMessage: 'Create this once',
      participantIds: [],
      requestId: expect.any(String),
    });

    resolveCreate(createdWorkstream);
    await waitFor(() => expect(api.createWorkstream).toHaveBeenCalledTimes(1));
  });

  it('freezes shared attachment actions while work-stream creation is pending', async () => {
    api.createWorkstream.mockReturnValue(new Promise(() => undefined));
    renderScreen();

    const file = new File(['notes'], 'notes.txt', { type: 'text/plain' });
    fireEvent.change(document.querySelector<HTMLInputElement>('input[type="file"]')!, {
      target: { files: [file] },
    });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Remove notes.txt' })).toBeEnabled());
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Opening work-stream message' }), { key: 'Enter' });

    await waitFor(() => expect(api.createWorkstream).toHaveBeenCalledWith({
      openingMessage: '',
      participantIds: [],
      attachmentIds: ['resource-notes'],
      requestId: expect.any(String),
    }));
    expect(screen.getByRole('button', { name: 'Attach a file' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Remove notes.txt' })).toBeDisabled();
  });

  it('seeds the new work-stream detail and opening message before navigation', async () => {
    const queryClient = renderScreen();
    const composer = await screen.findByRole('textbox', { name: 'Opening work-stream message' });
    fireEvent.change(composer, { target: { value: 'Prepare the launch brief' } });
    fireEvent.keyDown(composer, { key: 'Enter' });

    await waitFor(() => expect(queryClient.getQueryData(['workstream', 'new-workstream'])).toMatchObject({
      id: 'new-workstream',
      participants: [{ id: currentUser.id, role: 'creator' }],
    }));
    expect(queryClient.getQueryData(['messages', 'new-workstream'])).toEqual([
      expect.objectContaining({
        id: createdWorkstream.messageId,
        clientMessageId: createdWorkstream.clientMessageId,
        text: 'Prepare the launch brief',
      }),
    ]);
  });

  it('carries a pinned model onto the seeded run so the arrival does not read Default', async () => {
    applicationSettings.current = { lockdownMode: false, lockdownAvailable: false, debugEnabled: true };
    const queryClient = renderScreen();

    const selector = await screen.findByRole('button', { name: 'Model: Default (follows the agent-model-workstream flag)' });
    fireEvent.pointerDown(selector, { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'DeepSeek V4 Pro' }));
    await screen.findByRole('button', { name: 'Model: DeepSeek V4 Pro' });

    const composer = screen.getByRole('textbox', { name: 'Opening work-stream message' });
    fireEvent.change(composer, { target: { value: 'Prepare the launch brief' } });
    fireEvent.keyDown(composer, { key: 'Enter' });

    // The work-stream screen reads the model off this seeded run. Without it the
    // pill the composer was just showing reads **Default** for the frames
    // between the navigation and the first refetch, which is the flash this
    // seeding exists to prevent — and the pin is the only thing on the client
    // that can answer before the server has recorded a run model.
    await waitFor(() => expect(queryClient.getQueryData(['workstream', 'new-workstream'])).toMatchObject({
      latestHarnessRun: { model: 'deepseek/deepseek-v4-pro' },
    }));
  });

  it('opens the work stream on the keystroke rather than on the response', async () => {
    api.createWorkstream.mockReturnValue(new Promise(() => undefined));
    renderScreen();

    const composer = await screen.findByRole('textbox', { name: 'Opening work-stream message' });
    fireEvent.change(composer, { target: { value: 'Prepare the launch brief' } });
    fireEvent.keyDown(composer, { key: 'Enter' });

    const turn = await screen.findByRole('article', { name: 'Message from Morgan Ellis' });
    expect(within(turn).getByText('Prepare the launch brief')).toBeVisible();
    expect(screen.getByRole('status', { name: 'Avalon is working' })).toBeVisible();
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Welcome back, Adam' })).not.toBeInTheDocument());
  });

  // The hand-off is built on the composer being one object across both states.
  // Remounting it would restart its own state and split the transition into two
  // elements swapping places, which is the thing the animation exists to avoid.
  it('carries the same composer across the hand-off', async () => {
    api.createWorkstream.mockReturnValue(new Promise(() => undefined));
    renderScreen();

    const composer = await screen.findByRole('textbox', { name: 'Opening work-stream message' });
    fireEvent.change(composer, { target: { value: 'Prepare the launch brief' } });
    fireEvent.keyDown(composer, { key: 'Enter' });

    await screen.findByRole('status', { name: 'Avalon is working' });
    expect(screen.getByRole('textbox', { name: 'Opening work-stream message' })).toBe(composer);
  });

  // A create carrying only files is one `submit` accepts, and its turn is a
  // bubble of tiles. Showing no turn for it would let the files appear at the
  // navigation, which is the jump the launch surface exists to remove.
  it('shows the opening turn for a create carrying only attachments', async () => {
    api.createWorkstream.mockReturnValue(new Promise(() => undefined));
    renderScreen();

    fireEvent.change(document.querySelector<HTMLInputElement>('input[type="file"]')!, {
      target: { files: [new File(['notes'], 'notes.txt', { type: 'text/plain' })] },
    });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Create work stream' })).toBeEnabled());
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Opening work-stream message' }), { key: 'Enter' });

    // The tile shows the extension and exposes the same preview action as the
    // sent turn will once the message is persisted.
    const turn = await screen.findByRole('article', { name: 'Message from Morgan Ellis' });
    expect(within(turn).getByRole('button', { name: 'Preview notes.txt' })).toBeInTheDocument();
  });

  it('takes back the optimistic work stream when creation fails', async () => {
    api.createWorkstream.mockRejectedValueOnce(new Error('offline'));
    renderScreen();

    const composer = await screen.findByRole('textbox', { name: 'Opening work-stream message' });
    fireEvent.change(composer, { target: { value: 'Prepare the launch brief' } });
    fireEvent.keyDown(composer, { key: 'Enter' });

    expect(await screen.findByText('offline')).toBeVisible();
    expect(screen.queryByRole('article', { name: 'Message from Morgan Ellis' })).not.toBeInTheDocument();
    expect(screen.queryByRole('status', { name: 'Avalon is working' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Welcome back, Adam' })).toBeVisible();
  });

  // Without the seeded run the work timer the launch surface has been running
  // disappears on arrival and only returns when the refetch answers, which is
  // the one thing that still read as a navigation.
  it('seeds the created run so the work timer keeps counting across the swap', async () => {
    const queryClient = renderScreen();
    const composer = await screen.findByRole('textbox', { name: 'Opening work-stream message' });
    fireEvent.change(composer, { target: { value: 'Prepare the launch brief' } });
    fireEvent.keyDown(composer, { key: 'Enter' });

    await waitFor(() => expect(queryClient.getQueryData(['workstream', 'new-workstream'])).toMatchObject({
      latestHarnessRunId: 'run-new-workstream',
      latestHarnessRun: { id: 'run-new-workstream', status: 'running' },
    }));
    const detail = queryClient.getQueryData<{ latestHarnessRun?: { startedAt?: string } }>(['workstream', 'new-workstream']);
    // The submit instant the surface counted from, not the response's — that is
    // what makes the timer continuous rather than restarting at the navigation.
    expect(Date.parse(detail!.latestHarnessRun!.startedAt!)).toBeLessThanOrEqual(Date.now());
    expect(detail!.latestHarnessRun!.startedAt).not.toBe(createdWorkstream.createdAt);
  });

  it('opens suggested work onto the same surface, with no turn and no unsent draft', async () => {
    api.getWorkOpportunities.mockResolvedValue([{
      id: '00000000-0000-7000-8000-000000000099',
      version: 3,
      displayPrompt: 'Prepare the follow-up for the unresolved launch blocker',
      icon: 'brand-slack',
      sourceLabel: 'From slack',
    }]);
    api.startWorkOpportunity.mockReturnValue(new Promise(() => undefined));
    renderScreen();

    const composer = await screen.findByRole('textbox', { name: 'Opening work-stream message' });
    fireEvent.change(composer, { target: { value: 'A different thing I have not sent' } });
    const suggestions = await screen.findByRole('region', { name: 'Suggested work' });
    fireEvent.click(within(suggestions).getByRole('button', {
      name: 'Prepare the follow-up for the unresolved launch blocker',
    }));

    expect(await screen.findByRole('status', { name: 'Avalon is working' })).toBeVisible();
    // The opening turn of suggested work is the selecting member's, but its text
    // is the brief the server expanded, which this screen has never seen — so
    // there is nothing here that could stand in for it.
    expect(screen.queryByRole('article', { name: 'Message from Morgan Ellis' })).not.toBeInTheDocument();
    // And the draft belongs to a work stream nobody has started.
    expect(composer).toHaveValue('');
  });

  // Without seeding, the work-stream screen has neither query and shows its
  // full-screen `Opening work stream…` state — cutting away from a surface that
  // was already showing this work stream.
  it('seeds the destination for suggested work so it does not land on the loading orb', async () => {
    api.getWorkOpportunities.mockResolvedValue([{
      id: '00000000-0000-7000-8000-000000000099',
      version: 3,
      displayPrompt: 'Prepare the follow-up for the unresolved launch blocker',
      icon: 'brand-slack',
      sourceLabel: 'From slack',
    }]);
    const queryClient = renderScreen();

    const suggestions = await screen.findByRole('region', { name: 'Suggested work' });
    fireEvent.click(within(suggestions).getByRole('button', {
      name: 'Prepare the follow-up for the unresolved launch blocker',
    }));

    await waitFor(() => expect(queryClient.getQueryData(['workstream', 'new-workstream'])).toMatchObject({
      id: 'new-workstream',
      latestHarnessRun: { id: 'run-new-workstream', status: 'running' },
    }));
    expect(api.startWorkOpportunity).toHaveBeenCalledWith(
      '00000000-0000-7000-8000-000000000099', 3, expect.any(String), 'workspace_home', 1,
    );
    // Empty rather than invented: the opening turn belongs to the agent and
    // arrives with the refetch.
    expect(queryClient.getQueryData(['messages', 'new-workstream'])).toEqual([]);
    expect(queryClient.getQueryData(['messages-cursor', 'new-workstream'])).toBeNull();
  });

  it('gives the draft back when suggested work fails to start', async () => {
    api.getWorkOpportunities.mockResolvedValue([{
      id: '00000000-0000-7000-8000-000000000099',
      version: 3,
      displayPrompt: 'Prepare the follow-up for the unresolved launch blocker',
      icon: 'brand-slack',
      sourceLabel: 'From slack',
    }]);
    api.startWorkOpportunity.mockRejectedValueOnce(new Error('offline'));
    renderScreen();

    const composer = await screen.findByRole('textbox', { name: 'Opening work-stream message' });
    fireEvent.change(composer, { target: { value: 'A different thing I have not sent' } });
    const suggestions = await screen.findByRole('region', { name: 'Suggested work' });
    fireEvent.click(within(suggestions).getByRole('button', {
      name: 'Prepare the follow-up for the unresolved launch blocker',
    }));

    await waitFor(() => expect(screen.queryByRole('status', { name: 'Avalon is working' })).not.toBeInTheDocument());
    expect(screen.getByRole('heading', { name: 'Welcome back, Adam' })).toBeVisible();
    expect(composer).toHaveValue('A different thing I have not sent');
  });

  // The composer is controlled, so an empty value shown over a held draft is one
  // keystroke away from being written back over it.
  it('does not let a keystroke during a suggested-work launch eat the held draft', async () => {
    api.getWorkOpportunities.mockResolvedValue([{
      id: '00000000-0000-7000-8000-000000000099',
      version: 3,
      displayPrompt: 'Prepare the follow-up for the unresolved launch blocker',
      icon: 'brand-slack',
      sourceLabel: 'From slack',
    }]);
    let settleStart = (): void => undefined;
    api.startWorkOpportunity.mockReturnValue(new Promise((_resolve, reject) => {
      settleStart = () => reject(new Error('offline'));
    }));
    renderScreen();

    const composer = await screen.findByRole('textbox', { name: 'Opening work-stream message' });
    fireEvent.change(composer, { target: { value: 'Keep this' } });
    const suggestions = await screen.findByRole('region', { name: 'Suggested work' });
    fireEvent.click(within(suggestions).getByRole('button', {
      name: 'Prepare the follow-up for the unresolved launch blocker',
    }));
    await screen.findByRole('status', { name: 'Avalon is working' });

    fireEvent.change(composer, { target: { value: 'typed while launching' } });
    settleStart();

    await waitFor(() => expect(composer).toHaveValue('Keep this'));
  });

  it('restores an immediately cleared message when creation fails without replacing a newer draft', async () => {
    api.createWorkstream.mockRejectedValueOnce(new Error('offline'));
    renderScreen();

    const composer = await screen.findByRole('textbox', { name: 'Opening work-stream message' });
    fireEvent.change(composer, { target: { value: 'Retry this request' } });
    fireEvent.keyDown(composer, { key: 'Enter' });

    expect(composer).toHaveValue('');
    await waitFor(() => expect(composer).toHaveValue('Retry this request'));
    expect(await screen.findByText('offline')).toBeVisible();
  });

  it('brings back the drafted message and its attachment after the screen is reopened', async () => {
    renderScreen();
    const composer = await screen.findByRole('textbox', { name: 'Opening work-stream message' });
    fireEvent.change(composer, { target: { value: 'Draft the launch brief' } });
    fireEvent.change(document.querySelector<HTMLInputElement>('input[type="file"]')!, {
      target: { files: [new File(['notes'], 'notes.txt', { type: 'text/plain' })] },
    });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Remove notes.txt' })).toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Create work stream' })).toBeEnabled());
    cleanup();

    renderScreen();

    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Opening work-stream message' }))
      .toHaveValue('Draft the launch brief'));
    expect(await screen.findByRole('button', { name: 'Remove notes.txt' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create work stream' })).toBeEnabled();
  });

  it('forgets the cached draft once the composer is emptied', async () => {
    renderScreen();
    const composer = await screen.findByRole('textbox', { name: 'Opening work-stream message' });
    fireEvent.change(composer, { target: { value: 'Draft the launch brief' } });
    fireEvent.change(document.querySelector<HTMLInputElement>('input[type="file"]')!, {
      target: { files: [new File(['notes'], 'notes.txt', { type: 'text/plain' })] },
    });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Create work stream' })).toBeEnabled());

    fireEvent.click(screen.getByRole('button', { name: 'Remove notes.txt' }));
    fireEvent.change(composer, { target: { value: '' } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Create work stream' })).toBeDisabled());
    cleanup();

    renderScreen();

    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Opening work-stream message' })).toHaveValue(''));
    expect(screen.queryByRole('button', { name: 'Remove notes.txt' })).not.toBeInTheDocument();
  });

  it('keeps taking attachments after one is already pending, including from a drop', async () => {
    renderScreen();
    await screen.findByRole('textbox', { name: 'Opening work-stream message' });
    fireEvent.change(document.querySelector<HTMLInputElement>('input[type="file"]')!, {
      target: { files: [new File(['first'], 'first.txt', { type: 'text/plain' })] },
    });
    await screen.findByRole('button', { name: 'Remove first.txt' });

    fireEvent.change(document.querySelector<HTMLInputElement>('input[type="file"]')!, {
      target: { files: [new File(['second'], 'second.txt', { type: 'text/plain' })] },
    });
    await screen.findByRole('button', { name: 'Remove second.txt' });
    fireEvent.drop(document.querySelector('.workstream-composer')!, {
      dataTransfer: { files: [new File(['third'], 'third.txt', { type: 'text/plain' })], types: ['Files'] },
    });

    expect(await screen.findByRole('button', { name: 'Remove third.txt' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove first.txt' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove second.txt' })).toBeInTheDocument();
  });
});
