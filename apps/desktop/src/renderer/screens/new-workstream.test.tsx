import { MESSAGE_MAX_CHARACTERS, MESSAGE_TOO_LONG_MESSAGE, asProjectId, type ProjectDirectory } from '@rally/contracts';
import * as Tooltip from '@radix-ui/react-tooltip';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Workspace, WorkstreamSummary } from '../lib/types';
import { clearAllDrafts } from '../lib/draft-cache';
import { mentionOptionCopy } from '../test/mention-option-copy';
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
const featureFlags = vi.hoisted(() => ({
  current: { suggestedWorkEnabled: true },
}));

vi.mock('../lib/use-client-feature-flags', () => ({
  useClientFeatureFlags: () => ({ data: featureFlags.current }),
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
  name: 'Rally Studio',
  region: 'global',
  timezone: 'America/Los_Angeles',
  currentUser,
};
const createdWorkstream = {
  workstream: workstream('new-workstream', 'Prepare the launch brief', 'running'),
  turnId: 'message-new-workstream',
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
    participantUserIds: [],
    participantExtraCount: 0,
    preview: `${title} preview`,
    ...overrides,
  };
}

function personalProjectDirectory(projectId: ReturnType<typeof asProjectId>): ProjectDirectory {
  return {
    waterline: 1,
    items: [{
      id: projectId,
      name: 'Hiring',
      iconKey: 'briefcase',
      colorKey: 'blue',
      scope: 'personal',
      status: 'active',
      presentationRevision: 1,
      audienceGeneration: 1,
      lifecycleGeneration: 1,
      participants: [currentUser, teammate].map((member) => ({ userId: member.id, state: 'active', generation: 1 })),
      workstreamIds: [],
      defaultResourceIds: [],
      createdAt: '2026-08-27T00:00:00.000Z',
      updatedAt: '2026-08-27T00:00:00.000Z',
    }],
  };
}

function renderScreen(projects: ProjectDirectory = { waterline: 0, items: [] }): QueryClient {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  queryClient.setQueryData(['projects'], projects);
  render(
    <Tooltip.Provider delayDuration={0}>
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

function renderProjectScreen(
  projectId: string,
  projects: ProjectDirectory = { waterline: 0, items: [] },
  nextProjectId?: string,
): QueryClient {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  queryClient.setQueryData(['projects'], projects);
  render(
    <Tooltip.Provider delayDuration={0}>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[`/projects/${projectId}/workstreams/new`]}>
          {nextProjectId && <Link to={`/projects/${nextProjectId}/workstreams/new`}>New work stream in another project</Link>}
          <Routes>
            <Route element={<NewWorkstreamScreen projectId="route" workspace={workspace} />} path="/projects/:projectId/workstreams/new" />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </Tooltip.Provider>,
  );
  return queryClient;
}

async function openComposerActions(): Promise<void> {
  const trigger = await screen.findByRole('button', { name: 'Composer actions' });
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
}

async function openModelMenu(): Promise<void> {
  // The pill in the composer's own toolbar, not the composer-actions menu: the
  // model control has one home in every layout now.
  const trigger = await screen.findByRole('button', { name: /^Model:/u });
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
}

function closeOpenMenus(): void {
  fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
  fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
}

async function selectModel(name: string): Promise<void> {
  const item = await screen.findByRole('menuitemradio', { name });
  fireEvent.click(item);
}

describe('New work-stream home', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    applicationSettings.current = { lockdownMode: false, lockdownAvailable: false, debugEnabled: false };
    featureFlags.current = { suggestedWorkEnabled: true };
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
      provider: 'rally_upload',
      mimeType: 'text/plain',
      watchEnabled: false,
      watchStatus: 'unsupported',
      contentAvailable: true,
      sizeBytes: 5,
    });
  });

  it('opens directly on the composer without the retired Welcome back home', async () => {
    renderScreen();

    expect(await screen.findByRole('textbox', { name: 'Opening work-stream message' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: /Welcome back/u })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Needs attention' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Suggested work' })).not.toBeInTheDocument();
    expect(api.getWorkOpportunities).not.toHaveBeenCalled();
    expect(workspaceSocket.listWorkstreams).not.toHaveBeenCalled();
  });

  it('given a project launcher, when the first message is submitted, then it omits home sections and sends the project gate', async () => {
    const projectId = asProjectId('00000000-0000-7000-8000-0000000000f2');
    const projects = personalProjectDirectory(projectId);
    renderProjectScreen(projectId, projects);

    expect(await screen.findByRole('textbox', { name: 'Opening work-stream message' })).toBeVisible();
    expect(screen.queryByRole('region', { name: 'Needs attention' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Suggested work' })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Add people' })).not.toBeInTheDocument());
    expect(screen.queryByTitle('Participants are managed by the project')).not.toBeInTheDocument();
    const modifier = document.querySelector('.participant-modifier');
    if (!(modifier instanceof HTMLElement)) throw new Error('participant modifier missing');
    const face = modifier.querySelector('.avatar-stack-item');
    if (!(face instanceof HTMLElement)) throw new Error('participant face missing');
    fireEvent.pointerMove(face, { pointerType: 'mouse' });
    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip).toHaveTextContent('Participants are managed by the project');
    expect(tooltip).not.toHaveTextContent('Morgan Ellis');
    expect(tooltip).not.toHaveTextContent('Samantha Lee');
    const composer = screen.getByRole('textbox', { name: 'Opening work-stream message' });
    fireEvent.change(composer, { target: { value: 'Prepare the hiring plan' } });
    fireEvent.keyDown(composer, { key: 'Enter' });

    await waitFor(() => expect(api.createWorkstream).toHaveBeenCalledWith(expect.objectContaining({
      projectId,
      participantIds: [teammate.id],
    })));
  });

  it('uses the shared mention, attachment, and dictation controls', async () => {
    renderScreen();

    expect(await screen.findByRole('button', { name: 'Composer actions' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Start voice input' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Mention a participant' })).not.toBeInTheDocument();
    await openComposerActions();
    expect(await screen.findByRole('menuitem', { name: 'Attach files' })).toBeVisible();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });

    const composer = screen.getByRole('textbox', { name: 'Opening work-stream message' });
    fireEvent.change(composer, { target: { value: '@' } });

    // GrokBot opens the same inline list from an @ typed at the caret rather
    // than reserving permanent toolbar space for a mention button.
    expect(await screen.findByRole('listbox', { name: 'Mentions' })).toBeVisible();
    expect(composer).toHaveValue('@');
    expect(screen.queryByRole('dialog', { name: 'Add people' })).not.toBeInTheDocument();
  });

  it('walks the mention list and submits the identity behind the person Enter picks', async () => {
    const queryClient = renderScreen();
    const composer = await screen.findByRole('textbox', { name: 'Opening work-stream message' });

    fireEvent.focus(composer);
    fireEvent.change(composer, { target: { value: 'ask @' } });

    const listbox = await screen.findByRole('listbox', { name: 'Mentions' });
    const options = within(listbox).getAllByRole('option');
    const firstOption = options[0];
    if (!firstOption) throw new Error('Expected at least one mention option');
    await within(firstOption).findByText('AJ');
    expect(options.map(mentionOptionCopy)).toEqual([
      { badge: 'Person', description: 'adam@example.com', label: 'Morgan Ellis' },
      { badge: 'Person', description: 'samantha@example.com', label: 'Samantha Lee' },
    ]);
    expect(options[0]).toHaveAccessibleName('Morgan Ellis — adam@example.com — Person');
    expect(options[1]).toHaveAccessibleName('Samantha Lee — samantha@example.com — Person');
    expect(options.map((option) => option.getAttribute('aria-selected'))).toEqual(['true', 'false']);

    fireEvent.keyDown(composer, { key: 'ArrowDown' });
    expect(within(listbox).getAllByRole('option').map((option) => option.getAttribute('aria-selected'))).toEqual(['false', 'true']);

    fireEvent.keyDown(composer, { key: 'Enter' });

    await waitFor(() => expect(composer).toHaveValue('ask @Samantha Lee '));
    expect(screen.queryByRole('listbox', { name: 'Mentions' })).not.toBeInTheDocument();
    // A mention is also an audience decision, so the person is seated before
    // the work stream exists and the identity travels with the visible text.
    expect(screen.getByRole('button', { name: 'Remove Samantha Lee' })).toBeVisible();
    fireEvent.keyDown(composer, { key: 'Enter' });
    await waitFor(() => expect(api.createWorkstream).toHaveBeenCalledWith(expect.objectContaining({
      openingMessage: 'ask @Samantha Lee',
      participantIds: ['user-2'],
      operationId: expect.any(String),
      mentions: [{
        type: 'person',
        label: 'Samantha Lee',
        userId: 'user-2',
        connectorType: null,
        startOffset: 4,
        endOffset: 17,
      }],
    })));
    await waitFor(() => expect(queryClient.getQueryData(['ordered-transcript', 'new-workstream']))
      .toMatchObject({ ranges: [{ turns: [{ blocks: [{
        mentions: [{
          type: 'person',
          userId: 'user-2',
          startOffset: 4,
          endOffset: 17,
        }],
      }] }] }] }));
  });

  it('keeps a non-active membership out of both the mention list and the dialog', async () => {
    api.getWorkspaceMembers.mockResolvedValue([
      currentUser,
      { ...teammate, status: 'invited' },
      { id: 'user-3', name: 'Rae Okafor', email: 'rae@example.com', timezone: 'America/Los_Angeles', status: 'active' },
    ]);
    renderScreen();
    const composer = await screen.findByRole('textbox', { name: 'Opening work-stream message' });

    fireEvent.focus(composer);
    fireEvent.change(composer, { target: { value: 'ask @' } });

    // Picking someone here puts them in the create request, and the work-stream
    // endpoints refuse a membership that is not active.
    const listbox = await screen.findByRole('listbox', { name: 'Mentions' });
    const options = within(listbox).getAllByRole('option');
    const firstOption = options[0];
    if (!firstOption) throw new Error('Expected at least one mention option');
    await within(firstOption).findByText('AJ');
    expect(options.map(mentionOptionCopy)).toEqual([
      { badge: 'Person', description: 'adam@example.com', label: 'Morgan Ellis' },
      { badge: 'Person', description: 'rae@example.com', label: 'Rae Okafor' },
    ]);
    expect(options[0]).toHaveAccessibleName('Morgan Ellis — adam@example.com — Person');
    expect(options[1]).toHaveAccessibleName('Rae Okafor — rae@example.com — Person');

    fireEvent.keyDown(composer, { key: 'Escape' });
    const peopleSearch = screen.getByRole('combobox', { name: 'Search people' });
    fireEvent.focus(peopleSearch);
    expect(screen.queryByRole('option', { name: 'Samantha Lee — samantha@example.com' })).not.toBeInTheDocument();
    expect(await screen.findByRole('option', { name: 'Rae Okafor — rae@example.com' })).toBeVisible();
  });

  it('takes no draft with it when the caret leaves the mention the list belongs to', async () => {
    renderScreen();
    const composer = await screen.findByRole('textbox', { name: 'Opening work-stream message' }) as HTMLTextAreaElement;

    fireEvent.focus(composer);
    fireEvent.change(composer, { target: { value: 'hello @Sam', selectionStart: 10, selectionEnd: 10 } });
    expect(await screen.findByRole('listbox', { name: 'Mentions' })).toBeVisible();

    // ArrowLeft five times: no value changes, so nothing recomputed the query,
    // and the row the list still highlights is measured from an `@` the caret
    // has left. Enter here used to insert at `lastIndexOf('@') === -1`, eating
    // the character before the caret and adding a participant nobody aimed at.
    composer.setSelectionRange(5, 5);
    fireEvent.keyDown(composer, { key: 'Enter' });

    await waitFor(() => expect(composer).toHaveValue('hello @Sam'));
    expect(screen.getByRole('combobox', { name: 'Search people' })).toBeVisible();
  });

  it('names the highlighted row to assistive technology while the list is open', async () => {
    renderScreen();
    const composer = await screen.findByRole('textbox', { name: 'Opening work-stream message' });

    expect(composer).not.toHaveAttribute('aria-activedescendant');
    fireEvent.focus(composer);
    fireEvent.change(composer, { target: { value: 'ask @' } });

    const listbox = await screen.findByRole('listbox', { name: 'Mentions' });
    const options = within(listbox).getAllByRole('option');
    // Focus stays in the draft, so this is the only thing that tells a screen
    // reader which row Enter would take.
    expect(composer).toHaveAttribute('aria-activedescendant', options[0]!.id);
    expect(composer).toHaveAttribute('aria-controls', 'launch-mention-listbox');

    fireEvent.keyDown(composer, { key: 'ArrowDown' });
    expect(composer).toHaveAttribute('aria-activedescendant', within(listbox).getAllByRole('option')[1]!.id);

    fireEvent.keyDown(composer, { key: 'Escape' });
    expect(composer).not.toHaveAttribute('aria-activedescendant');
  });

  it('dismisses the mention list with Escape and leaves the draft alone', async () => {
    renderScreen();
    const composer = await screen.findByRole('textbox', { name: 'Opening work-stream message' });

    fireEvent.focus(composer);
    fireEvent.change(composer, { target: { value: 'ask @Sam' } });
    expect(await screen.findByRole('listbox', { name: 'Mentions' })).toBeVisible();

    fireEvent.keyDown(composer, { key: 'Escape' });

    expect(screen.queryByRole('listbox', { name: 'Mentions' })).not.toBeInTheDocument();
    expect(composer).toHaveValue('ask @Sam');
    expect(screen.getByRole('combobox', { name: 'Search people' })).toBeVisible();
  });

  it('keeps recipient selection above the composer and sends selected people', async () => {
    renderScreen();

    act(() => screen.getByRole('combobox', { name: 'Search people' }).focus());
    fireEvent.click(await screen.findByRole('option', { name: 'Samantha Lee — samantha@example.com' }));
    expect(screen.getByRole('button', { name: 'Remove Samantha Lee' })).toBeVisible();
    expect(screen.getByRole('combobox', { name: 'Search people' })).toHaveAttribute('placeholder', 'Add people');
    const composer = screen.getByRole('textbox', { name: 'Opening work-stream message' });
    fireEvent.change(composer, { target: { value: '  Prepare the launch brief  ' } });
    fireEvent.keyDown(composer, { key: 'Enter' });

    await waitFor(() => expect(api.createWorkstream).toHaveBeenCalledWith({
      openingMessage: 'Prepare the launch brief',
      participantIds: ['user-2'],
      operationId: expect.any(String),
      // The create request travels under the trace id the screen printed;
      // asserted as present rather than by value so the exact-shape check that
      // proves `modelOverride` is absent keeps working.
      requestId: expect.any(String),
    }));
    const request = api.createWorkstream.mock.calls[0]?.[0];
    expect(request?.operationId).toBe(request?.requestId);
  });

  it.each(['workspace', 'project'] as const)('focuses the message composer when the %s launcher opens', async (scope) => {
    const projectId = asProjectId('00000000-0000-7000-8000-0000000000f2');
    const queryClient = scope === 'workspace'
      ? renderScreen()
      : renderProjectScreen(projectId, personalProjectDirectory(projectId));

    expect(screen.getByRole('textbox', { name: 'Opening work-stream message' })).toHaveFocus();
    expect(screen.queryByRole('listbox', { name: 'People' })).not.toBeInTheDocument();
    await waitFor(() => expect(queryClient.getQueryState(['workspace-members'])?.status).toBe('success'));
    expect(screen.queryByRole('listbox', { name: 'People' })).not.toBeInTheDocument();
  });

  it('focuses the message when navigating between project launchers', async () => {
    const firstId = asProjectId('00000000-0000-7000-8000-0000000000f2');
    const secondId = asProjectId('00000000-0000-7000-8000-0000000000f3');
    renderProjectScreen(firstId, {
      waterline: 1,
      items: [...personalProjectDirectory(firstId).items, ...personalProjectDirectory(secondId).items],
    }, secondId);
    const firstComposer = screen.getByRole('textbox', { name: 'Opening work-stream message' });
    expect(firstComposer).toHaveFocus();
    const nextProject = screen.getByRole('link', { name: 'New work stream in another project' });
    act(() => nextProject.focus());
    fireEvent.click(nextProject);

    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Opening work-stream message' })).toHaveFocus());
  });

  it('shows an empty recipient result when the workspace has no available members', async () => {
    api.getWorkspaceMembers.mockResolvedValue([currentUser]);
    renderScreen();

    act(() => screen.getByRole('combobox', { name: 'Search people' }).focus());
    expect(await screen.findByText('Everyone available is selected')).toBeVisible();
    expect(screen.queryByRole('option')).not.toBeInTheDocument();
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
    await openModelMenu();
    expect(await screen.findByRole('menuitemradio', { name: 'Default' })).toHaveAttribute('aria-checked', 'true');
    closeOpenMenus();
    const composer = screen.getByRole('textbox', { name: 'Opening work-stream message' });
    fireEvent.change(composer, { target: { value: 'Prepare the launch brief' } });
    fireEvent.keyDown(composer, { key: 'Enter' });

    await waitFor(() => expect(api.createWorkstream).toHaveBeenCalledWith({
      openingMessage: 'Prepare the launch brief',
      participantIds: [],
      operationId: expect.any(String),
      requestId: expect.any(String),
    }));
  });

  it('pins the work stream to the model chosen in developer mode', async () => {
    applicationSettings.current = { lockdownMode: false, lockdownAvailable: false, debugEnabled: true };
    renderScreen();

    await openModelMenu();
    await selectModel('GPT-5.6 Sol');
    closeOpenMenus();
    const composer = screen.getByRole('textbox', { name: 'Opening work-stream message' });
    fireEvent.change(composer, { target: { value: 'Prepare the launch brief' } });
    fireEvent.keyDown(composer, { key: 'Enter' });

    await waitFor(() => expect(api.createWorkstream).toHaveBeenCalledWith({
      openingMessage: 'Prepare the launch brief',
      participantIds: [],
      operationId: expect.any(String),
      modelOverride: 'openai/gpt-5.6-sol',
      requestId: expect.any(String),
    }));
  });

  it('pins the flag’s own default model as a deliberate, visible choice', async () => {
    applicationSettings.current = { lockdownMode: false, lockdownAvailable: false, debugEnabled: true };
    renderScreen();

    // The model the flag already serves is still a choice someone can make, and
    // making it has to look different from never having touched the control —
    // which it would not if unpinned borrowed the flag's answer as its label.
    // Grok 4.3 is that model; it is deliberately not the menu's first entry,
    // since the families are ordered newest first.
    await openModelMenu();
    await selectModel('Grok 4.3');
    closeOpenMenus();

    const composer = screen.getByRole('textbox', { name: 'Opening work-stream message' });
    fireEvent.change(composer, { target: { value: 'Prepare the launch brief' } });
    fireEvent.keyDown(composer, { key: 'Enter' });
    await waitFor(() => expect(api.createWorkstream).toHaveBeenCalledWith({
      openingMessage: 'Prepare the launch brief',
      participantIds: [],
      operationId: expect.any(String),
      modelOverride: 'x-ai/grok-4.3',
      requestId: expect.any(String),
    }));
  });

  it('releases a pin back to the flag without leaving the screen', async () => {
    applicationSettings.current = { lockdownMode: false, lockdownAvailable: false, debugEnabled: true };
    renderScreen();

    await openModelMenu();
    await selectModel('DeepSeek V4 Pro');
    closeOpenMenus();
    await openModelMenu();
    await selectModel('Default');
    closeOpenMenus();

    const composer = screen.getByRole('textbox', { name: 'Opening work-stream message' });
    fireEvent.change(composer, { target: { value: 'Prepare the launch brief' } });
    fireEvent.keyDown(composer, { key: 'Enter' });
    await waitFor(() => expect(api.createWorkstream).toHaveBeenCalledWith({
      openingMessage: 'Prepare the launch brief',
      participantIds: [],
      operationId: expect.any(String),
      requestId: expect.any(String),
    }));
  });

  it('releases the pin when developer mode is turned off under it', async () => {
    applicationSettings.current = { lockdownMode: false, lockdownAvailable: false, debugEnabled: true };
    renderScreen();

    await openModelMenu();
    await selectModel('GPT-5.6 Luna');
    closeOpenMenus();

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
      operationId: expect.any(String),
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
      operationId: expect.any(String),
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
      operationId: expect.any(String),
      attachmentIds: ['resource-notes'],
      requestId: expect.any(String),
    }));
    expect(screen.getByRole('button', { name: 'Composer actions' })).toBeDisabled();
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
    expect(queryClient.getQueryData(['ordered-transcript', 'new-workstream'])).toMatchObject({
      ranges: [{ turns: [{
        turnId: createdWorkstream.turnId,
        clientMessageId: createdWorkstream.clientMessageId,
        blocks: [{ text: 'Prepare the launch brief' }],
      }] }],
    });
  });

  it('carries a pinned model onto the seeded run and the seeded pin, so the arrival is neither Default nor unpinned', async () => {
    applicationSettings.current = { lockdownMode: false, lockdownAvailable: false, debugEnabled: true };
    const queryClient = renderScreen();

    await openModelMenu();
    await selectModel('DeepSeek V4 Pro');
    closeOpenMenus();

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
      // The pin beside the run, because they answer different questions and the
      // pill makes both claims: the run says which model, this says the model
      // is fixed. `created.workstream` is a summary and does not carry the
      // column, so without the seed stating it a work stream pinned a moment
      // ago describes itself as following the flag until the refetch lands.
      modelOverride: 'deepseek/deepseek-v4-pro',
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
    expect(screen.getByRole('status', { name: 'Rally is working' })).toBeVisible();
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

    await screen.findByRole('status', { name: 'Rally is working' });
    expect(screen.getByRole('textbox', { name: 'Opening work-stream message' })).toBe(composer);
  });

  // A message over the ceiling is refused here rather than by the server, and
  // the difference is not latency. The create path reserves an email address
  // and writes its D1 rows before anything reads the message's length, so a
  // request that was always going to be refused leaves those behind for a work
  // stream that never exists — and the launch surface would have opened on it.
  it('refuses a message over the ceiling without sending it or opening a work stream', async () => {
    renderScreen();

    const composer = await screen.findByRole('textbox', { name: 'Opening work-stream message' });
    fireEvent.change(composer, { target: { value: 'x'.repeat(MESSAGE_MAX_CHARACTERS + 1) } });
    fireEvent.keyDown(composer, { key: 'Enter' });

    expect(await screen.findByText(MESSAGE_TOO_LONG_MESSAGE)).toBeVisible();
    expect(api.createWorkstream).not.toHaveBeenCalled();
    expect(screen.queryByRole('status', { name: 'Rally is working' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /Welcome back/u })).not.toBeInTheDocument();
    // Still in the composer. The person has to shorten it, which they cannot do
    // to text the screen has taken away from them.
    expect(composer).toHaveValue('x'.repeat(MESSAGE_MAX_CHARACTERS + 1));
  });

  it('sends a message at exactly the ceiling', async () => {
    api.createWorkstream.mockReturnValue(new Promise(() => undefined));
    renderScreen();

    const composer = await screen.findByRole('textbox', { name: 'Opening work-stream message' });
    fireEvent.change(composer, { target: { value: 'x'.repeat(MESSAGE_MAX_CHARACTERS) } });
    fireEvent.keyDown(composer, { key: 'Enter' });

    await waitFor(() => expect(api.createWorkstream).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(MESSAGE_TOO_LONG_MESSAGE)).not.toBeInTheDocument();
  });

  it('clears the refusal on the next keystroke', async () => {
    renderScreen();

    const composer = await screen.findByRole('textbox', { name: 'Opening work-stream message' });
    fireEvent.change(composer, { target: { value: 'x'.repeat(MESSAGE_MAX_CHARACTERS + 1) } });
    fireEvent.keyDown(composer, { key: 'Enter' });
    await screen.findByText(MESSAGE_TOO_LONG_MESSAGE);

    fireEvent.change(composer, { target: { value: 'Prepare the launch brief' } });

    expect(screen.queryByText(MESSAGE_TOO_LONG_MESSAGE)).not.toBeInTheDocument();
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
    expect(screen.queryByRole('status', { name: 'Rally is working' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /Welcome back/u })).not.toBeInTheDocument();
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

  it('does not restore submitted mention spans into a newer draft after creation fails', async () => {
    let rejectCreate!: (error: Error) => void;
    api.createWorkstream.mockReturnValueOnce(new Promise((_resolve, reject) => {
      rejectCreate = reject;
    }));
    renderScreen();

    const composer = await screen.findByRole('textbox', { name: 'Opening work-stream message' });
    fireEvent.change(composer, { target: { value: 'ask @' } });
    fireEvent.keyDown(composer, { key: 'ArrowDown' });
    fireEvent.keyDown(composer, { key: 'Enter' });
    await waitFor(() => expect(composer).toHaveValue('ask @Samantha Lee '));
    fireEvent.keyDown(composer, { key: 'Enter' });
    await screen.findByRole('status', { name: 'Rally is working' });

    fireEvent.change(composer, { target: { value: 'A newer draft' } });
    act(() => rejectCreate(new Error('offline')));

    await waitFor(() => expect(composer).toHaveValue('A newer draft'));
    expect(await screen.findByText('offline')).toBeVisible();
    api.createWorkstream.mockReturnValueOnce(new Promise(() => undefined));
    fireEvent.keyDown(composer, { key: 'Enter' });
    await waitFor(() => expect(api.createWorkstream).toHaveBeenCalledTimes(2));
    expect(api.createWorkstream.mock.calls[1]?.[0]).toEqual(expect.not.objectContaining({ mentions: expect.anything() }));
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
    // Send stays on screen now and goes disabled instead of unmounting, which
    // is the same signal that the composer has registered the emptying.
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
