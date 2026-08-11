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
  getWorkstreams: vi.fn(),
  getWorkOpportunities: vi.fn(),
  recordWorkOpportunityImpressions: vi.fn(),
  dismissWorkOpportunity: vi.fn(),
  startWorkOpportunity: vi.fn(),
  uploadResource: vi.fn(),
}));

vi.mock('../lib/app-session', () => ({ useAppSession: () => ({ api }) }));

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
};

function workstream(id: string, title: string, harnessStatus: WorkstreamSummary['harnessStatus']): WorkstreamSummary {
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
    preview: `${title} preview`,
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
    api.getWorkstreams.mockResolvedValue([
      workstream('waiting', 'Board decision', 'needs_input'),
      workstream('running', 'Pricing restructure', 'running'),
      workstream('completed', 'Release notes', 'completed'),
      workstream('failed', 'Broken connector', 'failed'),
    ]);
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

  it('shows only work streams explicitly waiting for input', async () => {
    renderScreen();

    expect(await screen.findByRole('heading', { name: 'Welcome back, Adam' })).toBeVisible();
    const waiting = await screen.findByRole('region', { name: 'Waiting for input' });
    expect(within(waiting).getByRole('link', { name: /Board decision/u })).toHaveAttribute('href', '/workstreams/waiting');
    expect(within(waiting).getByText('Needs input')).toBeVisible();
    expect(screen.queryByText('Pricing restructure')).not.toBeInTheDocument();
    expect(screen.queryByText('Release notes')).not.toBeInTheDocument();
    expect(screen.queryByText('Broken connector')).not.toBeInTheDocument();
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
    }));
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
