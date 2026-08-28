import * as Tooltip from '@radix-ui/react-tooltip';
import { AutomationAgentSnapshotSchema, type AutomationAgentSnapshot, type AutomationDraftStreamEvent } from '@rally/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useSyncExternalStore } from 'react';
import { Link, MemoryRouter, Route, Routes, useLocation, type InitialEntry } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, RallyApi } from '../lib/api';
import type { SocketState } from '../lib/use-workstream-socket';
import type { Workspace } from '../lib/types';
import { clearAllDrafts, readDraftText } from '../lib/draft-cache';
import { newAutomationDraftKey } from '../lib/draft-keys';
import { automationErrorCopy, NewAutomationScreen, retainableNarration } from './new-automation';
const api = vi.hoisted(() => ({
  admitAutomationDraftTurn: vi.fn(),
  automationDraftFromAgentSnapshot: vi.fn(),
  createAutomation: vi.fn(),
  deleteAutomation: vi.fn(),
  retryAutomationCompiler: vi.fn(),
  stopAutomationCompiler: vi.fn(),
  deleteDraftResource: vi.fn(),
  getAutomationAgentDraft: vi.fn(),
  getConnections: vi.fn(),
  getNotes: vi.fn(),
  getResourcePreviewContent: vi.fn(),
  getWorkspaceTemplates: vi.fn(),
  uploadResource: vi.fn(),
}));

/**
 * The feed the real hook produces, standing in for the socket only.
 * Everything above it is the product's own code: turns are admitted
 * through `admitAutomationDraftTurn`, the frames published here are
 * real `AutomationAgentSnapshot`s, and the adapter that turns one
 * into a conversation is the shipping one rather than a stub.
 */
const agentSocket = vi.hoisted(() => ({
  revision: 0,
  snapshot: null as AutomationAgentSnapshot | null,
  narration: '',
  streamEvents: [] as Array<{ sequence: number; event: AutomationDraftStreamEvent }>,
  state: 'connected' as SocketState,
  sequence: 0,
  listeners: new Set<() => void>(),
  publish(next: {
    snapshot?: AutomationAgentSnapshot | null;
    narration?: string;
    streamEvent?: AutomationDraftStreamEvent;
    state?: SocketState;
  }) {
    if ('snapshot' in next) this.snapshot = next.snapshot ?? null;
    if (next.narration !== undefined) this.narration = next.narration;
    if (next.state !== undefined) this.state = next.state;
    if (next.streamEvent) {
      this.sequence += 1;
      this.streamEvents = [...this.streamEvents, { sequence: this.sequence, event: next.streamEvent }];
    }
    this.revision += 1;
    for (const listener of this.listeners) listener();
  },
}));
const copyText = vi.hoisted(() => vi.fn());
// The composer reads Application → Developer → Debug enabled to decide whether
// to offer the model selector, so this bridge has to answer for it.
const applicationSettings = vi.hoisted(() => ({
  current: { lockdownMode: false, lockdownAvailable: false, debugEnabled: false },
}));
const featureFlags = vi.hoisted(() => ({
  current: { automationWorkspaceTemplatesEnabled: true },
}));

const session = vi.hoisted(() => ({
  user: { id: 'user-1', email: 'adam@juno-labs.com', name: 'Morgan Ellis' },
  workspace: { id: 'workspace-1', name: 'Juno Labs', region: 'global', role: 'owner' },
}));

const workspace: Workspace = {
  id: 'workspace-1',
  name: 'Juno Labs',
  region: 'global',
  timezone: 'America/Los_Angeles',
  currentUser: { id: 'user-1', name: 'Morgan Ellis', email: 'adam@juno-labs.com', timezone: 'America/Los_Angeles' },
};

const workspaceId = '00000000-0000-7000-8000-000000000001';
const userId = '00000000-0000-7000-8000-000000000002';
const draftOne = '00000000-0000-7000-8000-000000000101';
const draftNine = '00000000-0000-7000-8000-000000000109';
const runId = '00000000-0000-7000-8000-000000000201';
const elicitationId = '00000000-0000-7000-8000-000000000301';

/** A definition as AutomationAgent stores it, before the adapter reads it. */
function draftDefinition(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'Blog monitor',
    description: 'Checks a blog for new posts.',
    overview: 'Checks the configured blog every day.',
    instructions: 'Check the configured blog and report new posts.',
    triggers: [{ type: 'interval', intervalSeconds: 86_400, summary: 'Every 24 hours' }],
    requiredCapabilities: [],
    expectedOutputs: ['New post summary'],
    requestedDelivery: [],
    defaultBehavior: {},
    recommendedPlugins: [],
    memoryTables: [],
    suggestedScope: 'personal',
    followUpQuestion: null,
    elicitation: null,
    ready: false,
    ...overrides,
  };
}

interface AgentTurn {
  role: 'user' | 'assistant';
  content: string;
  clientMessageId?: string | null;
  attachmentIds?: string[];
}

let turnSequence = 0;
function agentSnapshot(input: {
  automationId: string;
  messages: AgentTurn[];
  definition?: Record<string, unknown> | null;
  activeCompilerRun?: Record<string, unknown> | null;
  narration?: string;
  pendingElicitationId?: string | null;
  eventSequence?: number;
  title?: string;
  lifecycle?: string;
}): AutomationAgentSnapshot {
  const run = input.activeCompilerRun ?? null;
  return AutomationAgentSnapshotSchema.parse({
    schemaVersion: 1,
    automationId: input.automationId,
    workspaceId,
    authorUserId: userId,
    region: 'global',
    lifecycle: input.lifecycle ?? 'draft',
    authorityGeneration: 1,
    title: input.title ?? 'New automation',
    definitionRevision: input.definition ? 1 : 0,
    definition: input.definition ?? null,
    messages: input.messages.map((message, index) => ({
      turnId: message.clientMessageId ?? `00000000-0000-7000-8000-0000000004${String(index).padStart(2, '0')}`,
      transcriptSequence: index + 1,
      role: message.role,
      authorUserId: message.role === 'user' ? userId : null,
      clientMessageId: message.clientMessageId ?? null,
      content: message.content,
      attachmentIds: message.attachmentIds ?? [],
      createdAt: 1_760_000_000_000 + index,
    })),
    activeCompilerRun: run,
    compilerCheckpoint: run ? { runId: String(run.id), narration: input.narration ?? '' } : null,
    pendingElicitation: input.pendingElicitationId
      ? { id: input.pendingElicitationId, definitionRevision: 1, payload: {} }
      : null,
    eventSequence: input.eventSequence ?? (turnSequence += 1),
  });
}

vi.mock('../lib/app-session', () => ({ useAppSession: () => ({ api, session }) }));
vi.mock('../lib/use-client-feature-flags', () => ({
  useClientFeatureFlags: () => ({ data: featureFlags.current }),
}));
vi.mock('../lib/use-automation-agent-socket', () => {
  return {
    useAutomationAgentSocket: () => {
      useSyncExternalStore(
        (listener) => {
          agentSocket.listeners.add(listener);
          return () => agentSocket.listeners.delete(listener);
        },
        () => agentSocket.revision,
        () => agentSocket.revision,
      );
      return {
        snapshot: agentSocket.snapshot,
        narration: agentSocket.narration,
        streamEvents: agentSocket.streamEvents,
        connected: agentSocket.state === 'connected',
        state: agentSocket.state,
      };
    },
  };
});
vi.mock('../lib/platform', () => ({
  desktopBridge: () => ({
    copyText,
    getApplicationSettings: () => Promise.resolve(applicationSettings.current),
    onApplicationSettingsChanged: () => () => undefined,
  }),
  // Rally's turns in this conversation carry the same actions the work-stream
  // feed does, including the two that save one to a file.
  desktopServicesAvailable: () => true,
}));
vi.mock('thinking-orbs', () => ({
  ThinkingOrb: ({ paused = false, state }: { paused?: boolean; state: string }) => (
    <span data-paused={String(paused)} data-state={state} data-testid="thinking-orb" />
  ),
}));

/** The address bar, readable from a test. A durable draft gets its own stable
 * automation path as soon as the first turn is admitted. */
function LocationProbe(): React.JSX.Element {
  const location = useLocation();
  return (
    <>
      <span data-testid="location-pathname">{location.pathname}</span>
      <span data-testid="location-search">{location.search}</span>
    </>
  );
}

function renderScreen(entry: InitialEntry = '/automations/new'): void {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  render(
    <Tooltip.Provider>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[entry]}>
          <LocationProbe />
          {/* The stable automation shell keeps this child mounted when the
              launcher adopts a durable draft id. */}
          <Link to="/automations/new">back to nothing</Link>
          <Link to={`/automations/${draftNine}`}>open draft 9</Link>
          <Routes>
            <Route element={<NewAutomationScreen workspace={workspace} />} path="/automations/:id" />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </Tooltip.Provider>,
  );
}

describe('New automation composer', () => {
  /**
   * How AutomationAgent answers the next turn: the definition it
   * settles on, what it says, and whether it stops to ask.
   * Tests set this rather than a compile-stream response, because a
   * turn is now admitted and answered by the agent's own snapshot.
   */
  let agentReply: {
    definition: Record<string, unknown> | null;
    assistantMessage: string;
    pendingElicitationId?: string | null;
  };
  let replies: Array<typeof agentReply> = [];
  /** What the agent has recorded per automation, as its transcript. */
  let conversations: Map<string, AgentTurn[]>;
  /** The definition the agent has settled for each automation. */
  let definitions: Map<string, Record<string, unknown> | null>;
  let settleTurn: (() => void) | null;
  let failTurn: ((message: string) => void) | null;
  let lastRun: { automationId: string; id: string; admittedTurnId: string } | null;

  beforeEach(async () => {
    vi.clearAllMocks();
    copyText.mockResolvedValue(undefined);
    // Restored here rather than at the end of the one test that changes it, so
    // a failure there cannot leak the role into every later test.
    session.workspace.role = 'owner';
    applicationSettings.current = { lockdownMode: false, lockdownAvailable: false, debugEnabled: false };
    featureFlags.current = { automationWorkspaceTemplatesEnabled: true };
    agentSocket.snapshot = null;
    agentSocket.narration = '';
    agentSocket.streamEvents = [];
    agentSocket.state = 'connected';
    agentSocket.sequence = 0;
    agentSocket.revision += 1;
    turnSequence = 0;
    conversations = new Map();
    definitions = new Map();
    settleTurn = null;
    failTurn = null;
    lastRun = null;
    replies = [];
    agentReply = {
      definition: draftDefinition({ followUpQuestion: 'What should the automation monitor?' }),
      assistantMessage: 'What should the automation monitor?',
      pendingElicitationId: elicitationId,
    };
    await clearAllDrafts();
    api.getConnections.mockResolvedValue([]);
    api.getNotes.mockResolvedValue([]);
    api.getWorkspaceTemplates.mockResolvedValue([]);
    api.deleteAutomation.mockResolvedValue(undefined);
    // The shipping adapter, not a stub: a test that replaced it proved
    // only that one mock had called another.
    const realApi = new RallyApi('https://api.rally.test', {
      accessToken: 'access-token-longer-than-twenty-characters',
      expiresAt: '2026-08-01T09:00:00.000Z',
      apiBaseUrl: 'https://api.rally.test',
      user: { id: userId, email: session.user.email, name: session.user.name },
      workspace: { id: workspaceId, name: 'Juno Labs', region: 'global', role: 'owner' },
    });
    api.automationDraftFromAgentSnapshot.mockImplementation((snapshot: AutomationAgentSnapshot) =>
      realApi.automationDraftFromAgentSnapshot(snapshot));
    // The agent's own read, which the screen makes for a resumed draft.
    api.getAutomationAgentDraft.mockImplementation(async (automationId: string) => {
      const messages = conversations.get(automationId);
      if (!messages) throw new ApiError('This draft’s conversation is no longer available.', 409, 'automation_draft_unavailable');
      return agentSnapshot({
        automationId,
        messages,
        definition: definitions.get(automationId) ?? null,
        pendingElicitationId: definitions.get(automationId)?.followUpQuestion ? elicitationId : null,
      });
    });

    /**
     * Admission, as the API performs it: the turn is recorded and a
     * compiler run is opened at once (202), and the answer arrives
     * later over the socket rather than on this promise.
     */
    api.admitAutomationDraftTurn.mockImplementation(async (input: {
      automationId?: string;
      clientCreationKey?: string;
      clientMessageId: string;
      content: string;
      attachmentIds: string[];
      inputMode: string;
    }) => {
      const automationId = input.automationId ?? draftOne;
      const messages: AgentTurn[] = [
        ...(conversations.get(automationId) ?? []),
        {
          role: 'user',
          content: input.content,
          clientMessageId: input.clientMessageId,
          attachmentIds: input.attachmentIds,
        },
      ];
      conversations.set(automationId, messages);
      const run = { id: runId, state: 'running', admittedTurnId: input.clientMessageId, errorCode: null, errorMessage: null };
      lastRun = { automationId, id: runId, admittedTurnId: input.clientMessageId };
      agentSocket.publish({
        snapshot: agentSnapshot({
          automationId,
          messages,
          // The definition the previous turn settled survives an
          // in-flight one, as the agent's own snapshot does.
          definition: definitions.get(automationId) ?? null,
          activeCompilerRun: run,
        }),
      });
      /** The agent finishing the turn, which the socket delivers. */
      settleTurn = (): void => {
        const reply = replies.shift() ?? agentReply;
        const settled: AgentTurn[] = [...messages, { role: 'assistant', content: reply.assistantMessage }];
        conversations.set(automationId, settled);
        definitions.set(automationId, reply.definition);
        agentSocket.publish({
          snapshot: agentSnapshot({
            automationId,
            messages: settled,
            definition: reply.definition,
            pendingElicitationId: reply.definition?.followUpQuestion ? reply.pendingElicitationId ?? elicitationId : null,
          }),
          narration: '',
        });
      };
      failTurn = (message: string): void => {
        agentSocket.publish({
          snapshot: agentSnapshot({
            automationId,
            messages,
            definition: definitions.get(automationId) ?? null,
            activeCompilerRun: {
              id: runId,
              state: 'failed',
              admittedTurnId: input.clientMessageId,
              errorCode: 'automation_compiler_failed',
              errorMessage: message,
            },
          }),
        });
      };
      return {
        automationId,
        turnId: input.clientMessageId,
        transcriptSequence: messages.length,
        compilerRunId: runId,
        admitted: true,
      };
    });
    api.retryAutomationCompiler.mockImplementation(async () => {
      if (!lastRun) throw new Error('No compiler run to retry');
      const messages = conversations.get(lastRun.automationId) ?? [];
      agentSocket.publish({
        snapshot: agentSnapshot({
          automationId: lastRun.automationId,
          messages,
          definition: definitions.get(lastRun.automationId) ?? null,
          activeCompilerRun: {
            id: lastRun.id,
            state: 'running',
            admittedTurnId: lastRun.admittedTurnId,
            errorCode: null,
            errorMessage: null,
          },
        }),
      });
    });
    api.stopAutomationCompiler.mockResolvedValue(undefined);
    api.createAutomation.mockResolvedValue({
      id: draftOne,
      name: 'Blog monitor',
      scope: 'you',
      status: 'active',
      updatedAt: '2026-08-01T09:00:00.000Z',
    });
    api.deleteDraftResource.mockResolvedValue(undefined);
    api.getResourcePreviewContent.mockResolvedValue(new Blob(['notes'], { type: 'text/plain' }));
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

  /** Send, then let the agent answer — the two halves of one turn. */
  async function completeTurn(): Promise<void> {
    await waitFor(() => expect(settleTurn).not.toBeNull());
    await act(async () => {
      settleTurn!();
      await Promise.resolve();
    });
  }

  it('removes the workspace-template path while Automation Workspace Templates Enabled is false', () => {
    featureFlags.current = { automationWorkspaceTemplatesEnabled: false };

    renderScreen();

    expect(screen.queryByRole('button', { name: 'Use a workspace template' })).not.toBeInTheDocument();
    expect(api.getWorkspaceTemplates).not.toHaveBeenCalled();
  });

  it('uses the shared connection, attachment, and dictation controls', () => {
    renderScreen();

    expect(screen.getByRole('button', { name: 'Mention a connection' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Attach a file' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Click or hold to dictate' })).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Mention a connection' }));
    expect(screen.getByRole('textbox', { name: 'Describe an automation' })).toHaveValue('@');
  });

  it('picks a connection mention with the arrow keys and Enter instead of submitting', async () => {
    api.getConnections.mockResolvedValue([
      {
        id: 'connection-slack',
        modelPluginId: 'plugin_slack',
        connectorType: 'slack',
        displayName: 'Slack',
        scope: 'workspace',
        status: 'healthy',
        capabilities: [],
      },
      {
        id: 'connection-slack-you',
        modelPluginId: 'plugin_slack',
        connectorType: 'slack',
        displayName: 'Slack · you',
        scope: 'you',
        status: 'healthy',
        capabilities: [],
      },
    ]);
    renderScreen();

    fireEvent.click(screen.getByRole('button', { name: 'Mention a connection' }));
    const composer = screen.getByRole('textbox', { name: 'Describe an automation' });
    // The caret travels with the typing: `fireEvent.change` replaces the value
    // without moving it, and everything about a mention is read from the caret.
    fireEvent.change(composer, { target: { value: '@sla', selectionStart: 4, selectionEnd: 4 } });
    expect(await screen.findByRole('listbox', { name: 'Connections' })).toBeVisible();

    fireEvent.keyDown(composer, { key: 'ArrowDown' });
    expect(screen.getAllByRole('option').map((option) => option.getAttribute('aria-selected')))
      .toEqual(['false', 'true']);

    fireEvent.keyDown(composer, { key: 'Enter' });

    await waitFor(() => expect(composer).toHaveValue('@Slack · you '));
    expect(api.admitAutomationDraftTurn).not.toHaveBeenCalled();
    expect(screen.queryByRole('listbox', { name: 'Connections' })).not.toBeInTheDocument();
  });

  it('inserts a connection at the caret without truncating the rest of the draft', async () => {
    api.getConnections.mockResolvedValue([{
      id: 'connection-slack',
      modelPluginId: 'plugin_slack',
      connectorType: 'slack',
      displayName: 'Slack',
      scope: 'workspace',
      status: 'healthy',
      capabilities: [],
    }]);
    renderScreen();

    const composer = screen.getByRole('textbox', { name: 'Describe an automation' });
    // The caret sits just after the half-typed name, in the middle of the
    // draft, the way it does when someone clicks back into a sentence.
    fireEvent.change(composer, { target: { value: 'post to @sla every Friday', selectionStart: 12, selectionEnd: 12 } });

    expect(await screen.findByRole('listbox', { name: 'Connections' })).toBeVisible();
    fireEvent.keyDown(composer, { key: 'Enter' });

    // The words after the caret survive, behind exactly one space: the name's
    // own separator is dropped when the rest of the line already starts with one.
    await waitFor(() => expect(composer).toHaveValue('post to @Slack every Friday'));
  });

  it('dismisses the connection list with Escape', async () => {
    api.getConnections.mockResolvedValue([{
      id: 'connection-slack',
      modelPluginId: 'plugin_slack',
      connectorType: 'slack',
      displayName: 'Slack',
      scope: 'workspace',
      status: 'healthy',
      capabilities: [],
    }]);
    renderScreen();

    fireEvent.click(screen.getByRole('button', { name: 'Mention a connection' }));
    const composer = screen.getByRole('textbox', { name: 'Describe an automation' });
    fireEvent.change(composer, { target: { value: '@sla' } });
    expect(await screen.findByRole('listbox', { name: 'Connections' })).toBeVisible();

    fireEvent.keyDown(composer, { key: 'Escape' });

    expect(screen.queryByRole('listbox', { name: 'Connections' })).not.toBeInTheDocument();
    expect(api.admitAutomationDraftTurn).not.toHaveBeenCalled();
  });

  it('admits the first turn with a creation key and keeps its attachments in the transcript', async () => {
    renderScreen();

    const file = new File(['notes'], 'notes.txt', { type: 'text/plain' });
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => expect(api.uploadResource).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    // The real admission shape: no automation id yet, so the turn
    // carries the creation key that claims one.
    await waitFor(() => expect(api.admitAutomationDraftTurn).toHaveBeenCalledWith({
      clientCreationKey: expect.any(String),
      clientMessageId: expect.any(String),
      content: '',
      attachmentIds: ['resource-notes'],
      inputMode: 'typed',
    }));
    const admitted = (api.admitAutomationDraftTurn.mock.calls as Array<[{
      clientCreationKey: string;
      clientMessageId: string;
    }]>)[0]![0];
    expect(admitted.clientCreationKey).toBe(admitted.clientMessageId);
    expect(await screen.findByRole('button', { name: 'Preview notes.txt' })).toBeInTheDocument();
    expect(api.deleteDraftResource).not.toHaveBeenCalled();
  });

  it('collapses to its default height after a successful send', async () => {
    renderScreen();

    const composer = screen.getByRole('textbox', { name: 'Describe an automation' });
    Object.defineProperty(composer, 'scrollHeight', { configurable: true, value: 160 });
    fireEvent.change(composer, { target: { value: 'A long automation description\nwith several lines' } });

    expect(composer).toHaveStyle({ height: '160px' });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(api.admitAutomationDraftTurn).toHaveBeenCalledWith(expect.objectContaining({
      content: 'A long automation description\nwith several lines',
      inputMode: 'typed',
    })));
    await waitFor(() => expect(composer).toHaveValue(''));
    expect(composer).toHaveStyle({ height: 'auto' });
  });

  it('keeps the draft ID out of the overflow menu until Debug is on', async () => {
    renderScreen();

    fireEvent.change(screen.getByRole('textbox', { name: 'Describe an automation' }), {
      target: { value: 'Check a blog every day' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await completeTurn();
    await screen.findByText('What should the automation monitor?');

    fireEvent.pointerDown(screen.getByRole('button', { name: 'More automation actions' }), {
      button: 0,
      ctrlKey: false,
    });
    // An id is for a bug report, not for the reader's day — the
    // sidebar's equivalent item is gated the same way.
    expect(await screen.findByRole('menuitem', { name: 'Delete draft' })).toBeVisible();
    expect(screen.queryByRole('menuitem', { name: 'Copy draft ID' })).not.toBeInTheDocument();
  });

  it('copies the stable automation draft ID from the overflow menu in Debug', async () => {
    applicationSettings.current = { lockdownMode: false, lockdownAvailable: false, debugEnabled: true };
    renderScreen();

    fireEvent.change(screen.getByRole('textbox', { name: 'Describe an automation' }), {
      target: { value: 'Check a blog every day' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await completeTurn();
    await screen.findByText('What should the automation monitor?');

    fireEvent.change(screen.getByRole('textbox', { name: 'What should the automation monitor?' }), {
      target: { value: 'Only on weekdays' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    // The second turn names the draft the first one claimed.
    await waitFor(() => expect(api.admitAutomationDraftTurn).toHaveBeenNthCalledWith(2, expect.objectContaining({
      automationId: draftOne,
      content: 'Only on weekdays',
    })));

    fireEvent.pointerDown(screen.getByRole('button', { name: 'More automation actions' }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Copy draft ID' }));

    expect(copyText).toHaveBeenCalledWith(draftOne);
  });

  it('deletes the open draft from the overflow menu, only after confirming', async () => {
    renderScreen();
    fireEvent.change(screen.getByRole('textbox', { name: 'Describe an automation' }), {
      target: { value: 'Check a blog every day' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await completeTurn();
    await screen.findByText('What should the automation monitor?');

    fireEvent.pointerDown(screen.getByRole('button', { name: 'More automation actions' }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete draft' }));

    const dialog = await screen.findByRole('dialog', { name: 'Delete draft' });
    expect(api.deleteAutomation).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(api.deleteAutomation).toHaveBeenCalledWith(draftOne));
    await waitFor(() => expect(screen.getByTestId('location-pathname')).toHaveTextContent('/workstreams/new'));
  });

  it('reopens a draft from the sidebar on the turn it was left at', async () => {
    conversations.set(draftNine, [
      { role: 'user', content: 'Watch my blog.' },
      { role: 'assistant', content: 'Which blog should I monitor?' },
    ]);
    definitions.set(draftNine, draftDefinition({ followUpQuestion: 'Which blog should I monitor?' }));
    renderScreen(`/automations/${draftNine}`);

    await waitFor(() => expect(api.getAutomationAgentDraft).toHaveBeenCalledWith(draftNine, expect.anything()));
    expect(await screen.findByText('Watch my blog.')).toBeVisible();
    // The question the conversation ended on is a question again, not a
    // sentence describing one.
    expect(await screen.findByRole('textbox', { name: 'Which blog should I monitor?' })).toBeVisible();

    fireEvent.change(screen.getByRole('textbox', { name: 'Which blog should I monitor?' }), {
      target: { value: 'https://example.com/blog' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    // Continuing writes back to the same draft rather than starting another.
    await waitFor(() => expect(api.admitAutomationDraftTurn).toHaveBeenCalledWith(expect.objectContaining({
      automationId: draftNine,
      content: 'https://example.com/blog',
      inputMode: 'typed',
    })));
  });

  it('resumes on a fresh mount whatever the history entry carries', async () => {
    conversations.set(draftNine, [
      { role: 'user', content: 'Watch my blog.' },
      { role: 'assistant', content: 'Which blog should I monitor?' },
    ]);
    // Whether a draft still needs loading is a fact about this screen, not
    // about the history entry it is mounted on. A mark left in history state
    // outlives the screen that set it, so a back gesture or a restored window
    // would land here with the load switched off and show an empty builder for
    // a draft that has a conversation.
    renderScreen({
      pathname: `/automations/${draftNine}`,
      state: { selfNamedDraft: true, anythingElse: true },
    });

    expect(await screen.findByText('Watch my blog.')).toBeVisible();
    expect(api.getAutomationAgentDraft).toHaveBeenCalledWith(draftNine, expect.anything());
  });

  it('reopens a continued draft at the turn it reached, not the one it was resumed from', async () => {
    conversations.set(draftNine, [
      { role: 'user', content: 'Watch my blog.' },
      { role: 'assistant', content: 'Which blog should I monitor?' },
    ]);
    definitions.set(draftNine, draftDefinition({ followUpQuestion: 'Which blog should I monitor?' }));
    renderScreen(`/automations/${draftNine}`);

    await screen.findByText('Watch my blog.');
    replies = [{
      definition: draftDefinition({ followUpQuestion: 'How often should I check it?' }),
      assistantMessage: 'How often should I check it?',
    }];
    fireEvent.change(screen.getByRole('textbox', { name: 'Which blog should I monitor?' }), {
      target: { value: 'https://example.com/blog' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await completeTurn();
    await screen.findByText('How often should I check it?');

    // Leaving and coming back must not serve the conversation from before the
    // answer: the draft on the agent has moved on, and a cached copy of the
    // turn it was resumed at would silently roll it back.
    fireEvent.click(screen.getByRole('link', { name: 'back to nothing' }));
    fireEvent.click(screen.getByRole('link', { name: 'open draft 9' }));

    expect(await screen.findByText('https://example.com/blog')).toBeVisible();
  });

  it('leaves an unsent message with the draft it was typed in', async () => {
    conversations.set(draftNine, [
      { role: 'user', content: 'Watch my blog.' },
      { role: 'assistant', content: 'Which blog should I monitor?' },
    ]);
    renderScreen(`/automations/${draftNine}`);
    await screen.findByText('Watch my blog.');

    fireEvent.change(screen.getByRole('textbox', { name: 'Describe an automation' }), {
      target: { value: 'https://example.com/blog' },
    });

    // Switching away must not carry the sentence — or the attachments staged
    // beside it — into a conversation it was never meant for.
    fireEvent.click(screen.getByRole('link', { name: 'back to nothing' }));

    const fresh = await screen.findByRole('textbox', { name: 'Describe an automation' });
    await waitFor(() => expect(fresh).toHaveValue(''));
  });

  it('says a draft could not be opened rather than offering a blank automation', async () => {
    // Nothing recorded for this id, so the agent read fails.
    renderScreen(`/automations/${draftNine}`);

    expect(await screen.findByRole('heading', { name: 'This draft could not be opened' })).toBeVisible();
    expect(screen.getByText('This draft’s conversation is no longer available.')).toBeVisible();

    // Sending here would admit a turn with no draft id, opening a second
    // draft while the sidebar still highlights the first.
    fireEvent.change(screen.getByRole('textbox', { name: 'Describe an automation' }), {
      target: { value: 'carry on then' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(api.admitAutomationDraftTurn).not.toHaveBeenCalled();
  });

  it('leaves an unsent message with a draft this screen named itself', async () => {
    renderScreen();
    fireEvent.change(screen.getByRole('textbox', { name: 'Describe an automation' }), {
      target: { value: 'Check a blog every day' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await completeTurn();
    await screen.findByText('What should the automation monitor?');
    await waitFor(() => expect(screen.getByTestId('location-pathname')).toHaveTextContent(`/automations/${draftOne}`));

    fireEvent.change(screen.getByRole('textbox', { name: 'What should the automation monitor?' }), {
      target: { value: 'an unsent afterthought' },
    });
    fireEvent.click(screen.getByRole('link', { name: 'back to nothing' }));

    // Every automation created through the product enters this way rather
    // than through a resume, so the launcher's key is the one that has to stop
    // being shared with the draft the first turn named.
    const fresh = await screen.findByRole('textbox', { name: 'Describe an automation' });
    await waitFor(() => expect(fresh).toHaveValue(''));
  });

  it('keeps a turn from landing on the draft the reader moved to', async () => {
    conversations.set(draftNine, [
      { role: 'user', content: 'Watch my blog.' },
      { role: 'assistant', content: 'Which blog should I monitor?' },
    ]);
    renderScreen();

    fireEvent.change(screen.getByRole('textbox', { name: 'Describe an automation' }), {
      target: { value: 'Check a blog every day' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByText('Check a blog every day');

    // The reader opens another draft while that turn is still compiling.
    fireEvent.click(screen.getByRole('link', { name: 'open draft 9' }));
    expect(await screen.findByText('Watch my blog.')).toBeVisible();

    // The turn settles for the draft it was sent from, which is no
    // longer the conversation on screen.
    await completeTurn();

    await waitFor(() => expect(screen.getByTestId('location-pathname'))
      .toHaveTextContent(`/automations/${draftNine}`));
    expect(screen.queryByText('Check a blog every day')).not.toBeInTheDocument();
  });

  it('clears the conversation the moment another draft is chosen, before it loads', async () => {
    let resolveRead!: (value: AutomationAgentSnapshot) => void;
    api.getAutomationAgentDraft.mockImplementation(() => new Promise((resolve) => {
      resolveRead = resolve as (value: AutomationAgentSnapshot) => void;
    }));
    renderScreen();

    fireEvent.change(screen.getByRole('textbox', { name: 'Describe an automation' }), {
      target: { value: 'Check a blog every day' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await completeTurn();
    await screen.findByText('What should the automation monitor?');

    fireEvent.click(screen.getByRole('link', { name: 'open draft 9' }));

    // Leaving the old transcript up while the new draft loads offers a Send
    // that would answer a draft the sidebar says is closed — and a load that
    // never arrives would leave it there for good.
    await waitFor(() => expect(screen.queryByText('Check a blog every day')).not.toBeInTheDocument());
    await act(async () => {
      resolveRead(agentSnapshot({
        automationId: draftNine,
        messages: [
          { role: 'user', content: 'Watch my blog.' },
          { role: 'assistant', content: 'Which blog should I monitor?' },
        ],
        definition: draftDefinition({ followUpQuestion: 'Which blog should I monitor?' }),
      }));
      await Promise.resolve();
    });
    expect(await screen.findByText('Watch my blog.')).toBeVisible();
  });

  it('carries an answer typed during a turn onto the draft that turn named', async () => {
    renderScreen();

    fireEvent.change(screen.getByRole('textbox', { name: 'Describe an automation' }), {
      target: { value: 'Check a blog every day' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    // Typing ahead while the model works. The composer's cache moves to the new
    // draft when the turn settles, and re-keying it empties the composer, so
    // this is the sentence that would be lost.
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Describe an automation' })).toHaveValue(''));
    fireEvent.change(screen.getByRole('textbox', { name: 'Describe an automation' }), {
      target: { value: 'Only weekdays' },
    });

    await completeTurn();

    await screen.findByText('What should the automation monitor?');
    expect(screen.getByRole('textbox', { name: 'What should the automation monitor?' }))
      .toHaveValue('Only weekdays');

    // And it stays with that draft rather than the blank launcher.
    fireEvent.click(screen.getByRole('link', { name: 'back to nothing' }));
    // The cache is what this asserts on, and the composer only afterwards.
    // Re-keying empties the composer synchronously and refills it when the read
    // lands, so a value assertion alone is satisfied by that gap.
    await waitFor(async () => {
      expect(await readDraftText(newAutomationDraftKey('workspace-1'))).toBeNull();
    });
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Describe an automation' })).toHaveValue(''));
    // Moved, not dropped: the sentence is under the draft it was typed for.
    await waitFor(async () => {
      expect((await readDraftText(newAutomationDraftKey('workspace-1', draftOne)))?.text)
        .toBe('Only weekdays');
    });
  });

  it('names the draft it just wrote in the address bar, so its sidebar row is the open one', async () => {
    renderScreen();

    fireEvent.change(screen.getByRole('textbox', { name: 'Describe an automation' }), {
      target: { value: 'Check a blog every day' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    // The screen adopts the agent's id rather than the reverse: the turn
    // claimed a draft automation, and the URL has to point at that row.
    await waitFor(() => expect(screen.getByTestId('location-pathname')).toHaveTextContent(`/automations/${draftOne}`));
    // Naming it is not the same as reopening it — the conversation on screen is
    // already the current one.
    expect(api.getAutomationAgentDraft).not.toHaveBeenCalled();
  });

  it('uses workstream chat messages while streaming research and the assistant response', async () => {
    renderScreen();

    const example = 'Check this blog every 24 hours for a new post.';
    fireEvent.click(screen.getByRole('button', { name: example }));

    await waitFor(() => expect(api.admitAutomationDraftTurn).toHaveBeenCalledWith(expect.objectContaining({
      content: example, inputMode: 'suggested_prompt',
    })));
    const humanMessage = (await screen.findByText(example)).closest('article');
    expect(humanMessage).toHaveClass('message-block', 'human-message', 'own-human-message');
    expect(screen.getByRole('status', { name: 'Rally is working' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'What should happen automatically?' })).not.toBeInTheDocument();

    act(() => agentSocket.publish({
      streamEvent: { type: 'thinking', inferenceRequestId: 'inference-1', status: 'started', durationMs: 0 },
    }));
    expect(screen.getByRole('status', { name: 'Rally is working' })).toBeInTheDocument();
    expect(screen.queryByText('Rally is working')).not.toBeInTheDocument();

    act(() => {
      agentSocket.publish({
        streamEvent: { type: 'thinking', inferenceRequestId: 'inference-1', status: 'completed', durationMs: 42 },
      });
      agentSocket.publish({
        streamEvent: {
          type: 'tool',
          toolCallId: 'tool-1',
          name: 'Reviewing Google Drive + Docs + Sheets',
          summary: 'Using an authorized connector…',
          status: 'started',
          plugin: { pluginId: 'plugin_google', displayName: 'Google Drive + Docs + Sheets', icon: 'brand-google-drive' },
        },
      });
    });
    const activeResearch = (await screen.findByText('Reviewing Google Drive + Docs + Sheets')).closest('details');
    expect(activeResearch).toHaveClass('plugin-activity', 'tool-started');
    expect(screen.getByRole('img', { name: 'Plugin: Google Drive + Docs + Sheets' })).toBeInTheDocument();
    expect(screen.getByTitle('Google Drive + Docs + Sheets')).toBeInTheDocument();
    expect(screen.getByText('worked for 42ms')).toBeInTheDocument();

    act(() => {
      agentSocket.publish({
        streamEvent: {
          type: 'tool',
          toolCallId: 'tool-1',
          name: 'Reviewed Google Drive + Docs + Sheets',
          summary: 'Searched the authorized Drive folder',
          status: 'completed',
          plugin: { pluginId: 'plugin_google', displayName: 'Google Drive + Docs + Sheets', icon: 'brand-google-drive' },
          durationMs: 42,
        },
      });
      agentSocket.publish({
        streamEvent: { type: 'thinking', inferenceRequestId: 'inference-2', status: 'started', durationMs: 42 },
      });
      agentSocket.publish({
        streamEvent: { type: 'thinking', inferenceRequestId: 'inference-2', status: 'completed', durationMs: 83_000 },
      });
      // The narration is folded by the socket hook rather than
      // replayed here one delta at a time.
      agentSocket.publish({ narration: 'Which blog should Rally monitor?' });
    });
    expect(await screen.findByText('Reviewed Google Drive + Docs + Sheets')).toBeInTheDocument();
    expect(activeResearch).toHaveClass('plugin-activity', 'tool-completed');
    expect(screen.getByText('42ms')).toBeInTheDocument();
    expect(screen.getByText('worked for 1m 23s')).toBeInTheDocument();
    expect(await screen.findByText('Which blog should Rally monitor?')).toBeInTheDocument();

    replies = [{
      definition: draftDefinition({
        followUpQuestion: 'Which blog should Rally monitor?',
        elicitation: {
          responseType: 'free_text',
          prompt: 'Paste the full blog URL.',
          placeholder: 'https://example.com/blog',
          options: [],
          minimumSelections: 1,
          maximumSelections: null,
          allowOther: false,
        },
      }),
      assistantMessage: 'Which blog should Rally monitor?',
    }];
    await completeTurn();
    expect(screen.getByText('worked for 1m 23s')).toBeInTheDocument();
    const assistantMessage = (await screen.findByText('Which blog should Rally monitor?')).closest('article');
    expect(assistantMessage).toHaveClass('message-block', 'agent-message');
    expect(screen.getByRole('textbox', { name: 'Paste the full blog URL.' })).toHaveAttribute(
      'placeholder',
      'https://example.com/blog',
    );
    expect(screen.getAllByText(example)).toHaveLength(1);
  });

  it('retracts an abandoned narration turn without blanking the bubble', async () => {
    renderScreen();

    const example = 'Check this blog every 24 hours for a new post.';
    fireEvent.click(screen.getByRole('button', { name: example }));
    await waitFor(() => expect(api.admitAutomationDraftTurn).toHaveBeenCalled());

    // A model that opens a turn with a bare newline must not render a bubble
    // before it has said anything.
    act(() => agentSocket.publish({ narration: '\n' }));
    expect(document.querySelector('.agent-message')).toBeNull();

    act(() => agentSocket.publish({
      narration: '\nChecking the plugin catalog.\n\nSearching GitHub next.',
    }));
    expect(await screen.findByText(/Searching GitHub next\./)).toBeInTheDocument();

    // The agent replays the settled text on a reset, so the abandoned turn
    // disappears and the earlier update survives.
    act(() => agentSocket.publish({ narration: 'Checking the plugin catalog.' }));
    expect(await screen.findByText('Checking the plugin catalog.')).toBeInTheDocument();
    expect(screen.queryByText(/Searching GitHub next\./)).not.toBeInTheDocument();

    // A reset with nothing to restore leaves no bubble at all.
    act(() => agentSocket.publish({ narration: '' }));
    await waitFor(() => expect(document.querySelector('.agent-message')).toBeNull());
  });

  it('follows streaming narration to the bottom until the reader scrolls up', async () => {
    renderScreen();

    const example = 'Check this blog every 24 hours for a new post.';
    fireEvent.click(screen.getByRole('button', { name: example }));
    await waitFor(() => expect(api.admitAutomationDraftTurn).toHaveBeenCalled());

    const surface = document.querySelector('.new-automation-screen') as HTMLElement;
    Object.defineProperty(surface, 'scrollHeight', { configurable: true, value: 4_000 });
    Object.defineProperty(surface, 'clientHeight', { configurable: true, value: 900 });

    act(() => agentSocket.publish({ narration: 'Checking the plugin catalog.' }));
    await waitFor(() => expect(surface.scrollTop).toBe(3_100));

    // The follow's own scroll event is dispatched at frame time, by which
    // point more narration has landed and the bottom has moved. Measuring
    // that as the reader scrolling up would switch the follow off a second
    // into every compile.
    Object.defineProperty(surface, 'scrollHeight', { configurable: true, value: 5_000 });
    fireEvent.scroll(surface);
    act(() => agentSocket.publish({ narration: 'Checking the plugin catalog. Still following.' }));
    await waitFor(() => expect(surface.scrollTop).toBe(4_100));
    Object.defineProperty(surface, 'scrollHeight', { configurable: true, value: 4_000 });

    // A few pixels above the bottom of the 3_100 scroll range is still the
    // reader taking control. A larger tolerance would read this as "close
    // enough" and yank them forward on the next fragment.
    surface.scrollTop = 3_090;
    fireEvent.scroll(surface);
    act(() => agentSocket.publish({
      narration: 'Checking the plugin catalog. Still following.\n\nSearching GitHub next.',
    }));
    await screen.findByText(/Searching GitHub next\./);
    expect(surface.scrollTop).toBe(3_090);

    surface.scrollTop = 1_000;
    fireEvent.scroll(surface);
    act(() => agentSocket.publish({
      narration: 'Checking the plugin catalog.\n\nReading the workflow docs.',
    }));
    await screen.findByText(/Reading the workflow docs\./);
    expect(surface.scrollTop).toBe(1_000);

    // Back at the bottom by their own hand, the follow resumes. The one-pixel
    // slack absorbs the fractional maximum a browser clamps a programmatic
    // scroll to; it is not a "near the bottom" allowance.
    surface.scrollTop = 3_099;
    fireEvent.scroll(surface);
    act(() => agentSocket.publish({
      narration: 'Checking the plugin catalog.\n\nDrafting it now.',
    }));
    await waitFor(() => expect(surface.scrollTop).toBe(3_100));
  });

  it('keeps the reader where they scrolled when the draft names itself mid-turn', async () => {
    // Admission held open, so the address-bar write lands *after*
    // the reader has taken the viewport — which is the order that
    // matters and the one a fast fake never produces.
    let admit!: (result: unknown) => void;
    const realAdmit = api.admitAutomationDraftTurn.getMockImplementation()!;
    api.admitAutomationDraftTurn.mockImplementation(async (input: unknown) => {
      const result = await realAdmit(input);
      return new Promise((resolve) => {
        admit = () => resolve(result);
      });
    });
    renderScreen();

    fireEvent.click(screen.getByRole('button', { name: 'Check this blog every 24 hours for a new post.' }));
    await waitFor(() => expect(admit).toBeDefined());
    const surface = document.querySelector('.new-automation-screen') as HTMLElement;
    Object.defineProperty(surface, 'scrollHeight', { configurable: true, value: 4_000 });
    Object.defineProperty(surface, 'clientHeight', { configurable: true, value: 900 });
    act(() => agentSocket.publish({ narration: 'Checking the plugin catalog.' }));
    await waitFor(() => expect(surface.scrollTop).toBe(3_100));

    // The reader pulls back to read the plan.
    surface.scrollTop = 1_000;
    fireEvent.scroll(surface);
    expect(await screen.findByRole('button', { name: 'Jump to latest' })).toBeVisible();

    // Only now does this screen write its own draft id into the
    // address bar. Keying the follow on that identity re-arms it
    // and takes the viewport back off the reader mid-sentence.
    await act(async () => {
      admit(undefined);
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.getByTestId('location-pathname'))
      .toHaveTextContent(`/automations/${draftOne}`));
    act(() => agentSocket.publish({
      narration: 'Checking the plugin catalog.\n\nStill going.',
    }));
    await screen.findByText(/Still going\./);

    expect(surface.scrollTop).toBe(1_000);
  });

  it('opens a resumed conversation at its newest turn', async () => {
    conversations.set(draftNine, [
      { role: 'user', content: 'Watch my blog.' },
      { role: 'assistant', content: 'Which blog should I monitor?' },
    ]);
    renderScreen(`/automations/${draftNine}`);
    const surface = document.querySelector('.new-automation-screen') as HTMLElement;
    Object.defineProperty(surface, 'scrollHeight', { configurable: true, value: 4_000 });
    Object.defineProperty(surface, 'clientHeight', { configurable: true, value: 900 });

    await screen.findByText('Watch my blog.');

    // `atEnd` starts true and only a scroll event moves it, and
    // nothing scrolls on mount — so a long draft opened at the top
    // with no "Jump to latest" to say there was anything below.
    await waitFor(() => expect(surface.scrollTop).toBe(3_100));
  });

  it('preloads Rally’s plugin picks without a Default plugins section', async () => {
    api.getConnections.mockResolvedValue([
      {
        id: 'connection-linear',
        modelPluginId: 'plugin_linear',
        connectorType: 'linear',
        displayName: 'Linear',
        scope: 'workspace',
        status: 'healthy',
        capabilities: ['linear.read'],
      },
      {
        id: 'connection-github',
        modelPluginId: 'plugin_github',
        connectorType: 'github',
        displayName: 'GitHub',
        scope: 'workspace',
        status: 'healthy',
        capabilities: ['github.read'],
      },
    ]);
    agentReply = {
      definition: draftDefinition({
        name: 'Watch my Linear issues',
        description: 'Checks issues available to my Linear account.',
        overview: 'Reviews assigned issues and prepares a concise update.',
        recommendedPlugins: [{
          pluginId: 'plugin_linear',
          recommendedTools: ['linear_search_issues'],
          reason: 'Provides the issue data this automation needs.',
        }],
        requiredCapabilities: ['linear.read'],
        triggers: [{ type: 'interval', intervalSeconds: 3_600, summary: 'Every hour' }],
        ready: true,
      }),
      assistantMessage: 'Ready to create.',
    };
    renderScreen();

    fireEvent.change(screen.getByRole('textbox', { name: 'Describe an automation' }), {
      target: { value: 'Check my Linear issues every hour' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await completeTurn();
    await screen.findByRole('button', { name: 'Create automation' });
    expect(screen.queryByRole('region', { name: 'Default plugins' })).not.toBeInTheDocument();
    expect(screen.queryByText('Suggested tools: linear_search_issues')).not.toBeInTheDocument();
    // The picks are preloaded into state with nothing on screen to assert on, so
    // let the effect that sets them commit before acting on it.
    await act(async () => undefined);

    fireEvent.click(screen.getByRole('button', { name: 'Create automation' }));
    await waitFor(() => expect(api.createAutomation).toHaveBeenCalledWith(
      draftOne,
      ['plugin_linear'],
      {},
      { scope: 'you', delivery: {} },
    ));
  });

  it('holds Create until the accepted automation takes the screen', async () => {
    let resolveCreate!: (value: unknown) => void;
    api.createAutomation.mockImplementation(() => new Promise((resolve) => {
      resolveCreate = resolve;
    }));
    agentReply = {
      definition: draftDefinition({ ready: true }),
      assistantMessage: 'Ready to create.',
    };
    renderScreen();

    fireEvent.change(screen.getByRole('textbox', { name: 'Describe an automation' }), {
      target: { value: 'Check a blog every hour' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await completeTurn();
    const create = await screen.findByRole('button', { name: 'Create automation' });

    fireEvent.click(create);
    await waitFor(() => expect(create).toBeDisabled());

    await act(async () => {
      resolveCreate({
        id: draftOne,
        name: 'Blog monitor',
        scope: 'you',
        status: 'active',
        updatedAt: '2026-08-01T09:00:00.000Z',
      });
      await Promise.resolve();
    });

    // This screen navigates to the route it is already on, so
    // nothing unmounts it: a re-enabled button here POSTs a
    // second create against a draft already accepted.
    expect(screen.getByRole('button', { name: 'Create automation' })).toBeDisabled();
    expect(api.createAutomation).toHaveBeenCalledTimes(1);
  });

  it('binds an activity source slot to the exact suggested connector', async () => {
    api.getConnections.mockResolvedValue([
      {
        id: 'connection-github-acme',
        modelPluginId: 'plugin_github_acme',
        connectorType: 'github',
        displayName: 'GitHub · Acme',
        scope: 'workspace',
        status: 'healthy',
        capabilities: [],
      },
      {
        id: 'connection-github-other',
        modelPluginId: 'plugin_github_other',
        connectorType: 'github',
        displayName: 'GitHub · Other',
        scope: 'workspace',
        status: 'healthy',
        capabilities: [],
      },
    ]);
    agentReply = {
      definition: draftDefinition({
        name: 'Follow up on merged PRs',
        description: 'Starts work when a PR merges.',
        overview: 'Reviews the merged PR and prepares the follow-up.',
        triggers: [{
          type: 'connector_activity',
          connectorType: 'github',
          eventTypes: ['pull_request.merged'],
          deterministicFilters: {},
          sourceBindingKey: 'github_source',
          suggestedSourcePluginId: 'plugin_github_acme',
          summary: 'GitHub: pull request merged',
        }],
        ready: true,
      }),
      assistantMessage: 'Ready to create.',
    };
    renderScreen();

    fireEvent.change(screen.getByRole('textbox', { name: 'Describe an automation' }), {
      target: { value: 'When a PR merges, prepare the follow-up' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await completeTurn();
    const source = await screen.findByRole('combobox', { name: 'Connector for github_source' });
    await waitFor(() => expect(source).toHaveValue('plugin_github_acme'));
    fireEvent.click(screen.getByRole('button', { name: 'Create automation' }));
    await waitFor(() => expect(api.createAutomation).toHaveBeenCalledWith(
      draftOne,
      [],
      { github_source: 'plugin_github_acme' },
      { scope: 'you', delivery: {} },
    ));
  });

  it('brings the drafted description and its attachment back after the screen is reopened', async () => {
    renderScreen();
    fireEvent.change(screen.getByRole('textbox', { name: 'Describe an automation' }), {
      target: { value: 'Watch the changelog every Friday' },
    });
    fireEvent.change(document.querySelector<HTMLInputElement>('input[type="file"]')!, {
      target: { files: [new File(['notes'], 'notes.txt', { type: 'text/plain' })] },
    });
    await screen.findByRole('button', { name: 'Remove notes.txt' });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled());
    cleanup();

    renderScreen();

    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Describe an automation' }))
      .toHaveValue('Watch the changelog every Friday'));
    expect(await screen.findByRole('button', { name: 'Remove notes.txt' })).toBeInTheDocument();
  });

  it('allows Rally-only delivery when a draft recommends Slack', async () => {
    api.getConnections.mockResolvedValue([
      {
        id: 'connection-slack-acme',
        modelPluginId: 'plugin_slack_acme',
        connectorType: 'slack',
        displayName: 'Acme',
        scope: 'workspace',
        status: 'healthy',
        capabilities: ['slack.agent'],
        userDelivery: { targetType: 'slack_agent_dm', label: 'Slack DM', description: 'Rally Agent DM in this Slack workspace.' },
      },
      {
        id: 'connection-slack-juno',
        modelPluginId: 'plugin_slack_juno',
        connectorType: 'slack',
        displayName: 'Juno',
        scope: 'workspace',
        status: 'healthy',
        capabilities: ['slack.agent'],
        userDelivery: { targetType: 'slack_agent_dm', label: 'Slack DM', description: 'Rally Agent DM in this Slack workspace.' },
      },
    ]);
    agentReply = {
      definition: draftDefinition({
        name: 'Morning email briefing',
        description: 'Stack-ranks Gmail and delivers the top three to Slack.',
        overview: 'Runs every morning.',
        requiredCapabilities: ['gmail.read'],
        requestedDelivery: ['slack_agent_dm'],
        triggers: [{ type: 'calendar', rrule: 'FREQ=DAILY', timezone: 'America/Los_Angeles', summary: 'Every day at 9:00 AM' }],
        ready: true,
      }),
      assistantMessage: 'Ready to create.',
    };
    renderScreen();

    fireEvent.change(screen.getByRole('textbox', { name: 'Describe an automation' }), {
      target: { value: 'Send my top three Gmail messages to Slack each morning' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await completeTurn();

    const createButton = await screen.findByRole('button', { name: 'Create automation' });
    const delivery = screen.getByRole('region', { name: 'Deliver results' });
    const rally = screen.getByRole('checkbox', { name: /^Rally/ });
    expect(rally).toBeChecked();
    expect(rally).toBeDisabled();
    expect(delivery).toHaveTextContent('Slack DM · Acme');
    expect(screen.getByRole('checkbox', { name: /Slack DM · Acme/ })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: /Slack DM · Juno/ })).not.toBeChecked();
    expect(createButton).toBeEnabled();
    fireEvent.click(createButton);
    await waitFor(() => expect(api.createAutomation).toHaveBeenCalledWith(
      draftOne,
      [],
      {},
      { scope: 'you', delivery: {} },
    ));
  });

  it('arrives with email ticked when the draft promises an emailed result', async () => {
    api.getConnections.mockResolvedValue([]);
    agentReply = {
      definition: draftDefinition({
        name: 'Morning competitor briefing',
        description: 'Summarizes competitor movement.',
        overview: 'Runs every morning.',
        requestedDelivery: ['email'],
        triggers: [{ type: 'calendar', rrule: 'FREQ=DAILY', timezone: 'America/Los_Angeles', summary: 'Every day at 9:00 AM' }],
        ready: true,
      }),
      assistantMessage: 'Ready to create.',
    };
    renderScreen();

    fireEvent.change(screen.getByRole('textbox', { name: 'Describe an automation' }), {
      target: { value: 'Email me a competitor briefing every morning' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await completeTurn();

    // Rally is the only sender: the run is forbidden to mail the result
    // itself. An unticked box here is an automation that emails nobody, on the
    // path where the reader agrees with the screen and presses Create.
    const email = await screen.findByRole('checkbox', { name: /^Email/ });
    expect(email).toBeChecked();
    expect(screen.getByRole('region', { name: 'Deliver results' }))
      .toHaveTextContent('This draft mentions email delivery.');

    fireEvent.click(screen.getByRole('button', { name: 'Create automation' }));
    await waitFor(() => expect(api.createAutomation).toHaveBeenCalledWith(draftOne, [], {}, {
      scope: 'you',
      delivery: { email: true },
    }));
  });

  it('reads a promise to deliver, not the word email in the subject matter', async () => {
    api.getConnections.mockResolvedValue([]);
    agentReply = {
      definition: draftDefinition({
        name: 'Morning inbox triage',
        description: 'Ranks the inbox.',
        overview: 'Runs every morning.',
        requiredCapabilities: ['gmail.read'],
        // What the agent derives for "A ranked list of your five most
        // importantant emails" — a briefing *about* email, promising
        // no delivery.
        expectedOutputs: ['A ranked list of your five most important emails'],
        requestedDelivery: [],
        ready: true,
      }),
      assistantMessage: 'Ready to create.',
    };
    renderScreen();

    fireEvent.change(screen.getByRole('textbox', { name: 'Describe an automation' }), {
      target: { value: 'Rank my five most important emails each morning' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await completeTurn();

    // A destination frozen by mistake cannot be changed afterwards, so the
    // nudge has to be wrong in the recoverable direction.
    const email = await screen.findByRole('checkbox', { name: /^Email/ });
    expect(email).not.toBeChecked();
  });

  it('freezes one Slack destination at a time alongside email', async () => {
    api.getConnections.mockResolvedValue([
      {
        id: 'connection-slack-acme',
        modelPluginId: 'plugin_slack_acme',
        connectorType: 'slack',
        displayName: 'Acme',
        scope: 'workspace',
        status: 'healthy',
        capabilities: ['slack.agent'],
        userDelivery: { targetType: 'slack_agent_dm', label: 'Slack DM', description: 'Rally Agent DM in this Slack workspace.' },
      },
      {
        id: 'connection-slack-unlinked',
        modelPluginId: 'plugin_slack_unlinked',
        connectorType: 'slack',
        displayName: 'Unlinked',
        scope: 'workspace',
        status: 'healthy',
        capabilities: ['slack.agent'],
      },
      {
        id: 'connection-slack-juno',
        modelPluginId: 'plugin_slack_juno',
        connectorType: 'slack',
        displayName: 'Juno',
        scope: 'workspace',
        status: 'healthy',
        capabilities: ['slack.agent'],
        userDelivery: { targetType: 'slack_agent_dm', label: 'Slack DM', description: 'Rally Agent DM in this Slack workspace.' },
      },
    ]);
    agentReply = {
      definition: draftDefinition({
        name: 'Morning briefing',
        description: 'Summarizes the day ahead.',
        overview: 'Runs every morning.',
        triggers: [{ type: 'calendar', rrule: 'FREQ=DAILY', timezone: 'America/Los_Angeles', summary: 'Every day at 9:00 AM' }],
        ready: true,
      }),
      assistantMessage: 'Ready to create.',
    };
    renderScreen();

    fireEvent.change(screen.getByRole('textbox', { name: 'Describe an automation' }), {
      target: { value: 'Brief me every morning' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await completeTurn();

    const email = await screen.findByRole('checkbox', { name: /^Email/ });
    expect(email).toHaveAccessibleName(expect.stringContaining('adam@juno-labs.com'));
    fireEvent.click(email);
    // A Slack installation the user has not linked is not a personal destination.
    expect(screen.queryByRole('checkbox', { name: /Unlinked/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: /Slack DM · Acme/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Slack DM · Juno/ }));

    expect(screen.getByRole('checkbox', { name: /Slack DM · Acme/ })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: /Slack DM · Juno/ })).toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'Create automation' }));
    await waitFor(() => expect(api.createAutomation).toHaveBeenCalledWith(draftOne, [], {}, {
      scope: 'you',
      delivery: {
        connection: { id: 'connection-slack-juno', targetType: 'slack_agent_dm' },
        email: true,
      },
    }));
  });

  it('defaults Runs as to Rally’s suggestion and creates under the chosen scope', async () => {
    api.getConnections.mockResolvedValue([
      {
        id: 'connection-linear',
        modelPluginId: 'plugin_linear',
        connectorType: 'linear',
        displayName: 'Linear',
        scope: 'workspace',
        status: 'healthy',
        capabilities: [],
      },
      {
        id: 'connection-gmail',
        modelPluginId: 'plugin_gmail',
        connectorType: 'google',
        displayName: 'Gmail',
        scope: 'personal',
        status: 'healthy',
        capabilities: [],
      },
    ]);
    agentReply = {
      definition: draftDefinition({
        name: 'Weekly changelog',
        description: 'Summarizes merged work.',
        overview: 'Runs every Friday.',
        recommendedPlugins: [
          { pluginId: 'plugin_linear', recommendedTools: [], reason: 'Reads the merged issues.' },
          { pluginId: 'plugin_gmail', recommendedTools: [], reason: 'Reads the release thread.' },
        ],
        triggers: [{ type: 'calendar', rrule: 'FREQ=WEEKLY;BYDAY=FR', timezone: 'America/Los_angeles', summary: 'Every Friday' }],
        ready: true,
      }),
      assistantMessage: 'Ready to create.',
    };
    renderScreen();

    fireEvent.change(screen.getByRole('textbox', { name: 'Describe an automation' }), {
      target: { value: 'Prepare a weekly changelog' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await completeTurn();

    const runsAs = await screen.findByRole('combobox', { name: 'Runs as' });
    expect(runsAs).toHaveValue('you');
    expect(screen.getByRole('checkbox', { name: /^Email/ })).toBeInTheDocument();

    fireEvent.change(runsAs, { target: { value: 'workspace' } });

    // A workspace automation drops the personal plugin and its personal destinations.
    expect(screen.queryByRole('checkbox', { name: /^Email/ })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Create automation' }));
    await waitFor(() => expect(api.createAutomation).toHaveBeenCalledWith(draftOne, ['plugin_linear'], {}, {
      scope: 'workspace',
      delivery: {},
    }));
  });

  it('offers no model selector until developer mode is on', async () => {
    renderScreen();

    await screen.findByRole('textbox', { name: 'Describe an automation' });
    expect(screen.queryByRole('button', { name: /^Model:/ })).not.toBeInTheDocument();
  });

  it('pins the automation’s runs to the model chosen in developer mode', async () => {
    applicationSettings.current = { lockdownMode: false, lockdownAvailable: false, debugEnabled: true };
    agentReply = {
      definition: draftDefinition({
        name: 'Weekly changelog',
        description: 'Summarizes merged work.',
        overview: 'Runs every Friday.',
        triggers: [{ type: 'calendar', rrule: 'FREQ=WEEKLY;BYDAY=FR', timezone: 'America/Los_angeles', summary: 'Every Friday' }],
        ready: true,
      }),
      assistantMessage: 'Ready to create.',
    };
    renderScreen();

    // Unpinned until something is chosen, and named for that rather than for a
    // model the renderer cannot know the flag will serve.
    const selector = await screen.findByRole('button', { name: 'Model: Default (follows the agent-model-workstream flag)' });
    fireEvent.pointerDown(selector, { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'GPT-5.6 Luna' }));

    await screen.findByRole('button', { name: 'Model: GPT-5.6 Luna' });

    fireEvent.change(screen.getByRole('textbox', { name: 'Describe an automation' }), {
      target: { value: 'Prepare a weekly changelog' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await completeTurn();

    fireEvent.click(await screen.findByRole('button', { name: 'Create automation' }));
    await waitFor(() => expect(api.createAutomation).toHaveBeenCalledWith(draftOne, [], {}, {
      scope: 'you',
      modelOverride: 'openai/gpt-5.6-luna',
      delivery: {},
    }));
  });

  it('restores the personal plugin preloads when Runs as returns to You', async () => {
    api.getConnections.mockResolvedValue([
      {
        id: 'connection-linear',
        modelPluginId: 'plugin_linear',
        connectorType: 'linear',
        displayName: 'Linear',
        scope: 'workspace',
        status: 'healthy',
        capabilities: [],
      },
      {
        id: 'connection-gmail',
        modelPluginId: 'plugin_gmail',
        connectorType: 'google',
        displayName: 'Gmail',
        scope: 'personal',
        status: 'healthy',
        capabilities: [],
      },
    ]);
    agentReply = {
      definition: draftDefinition({
        name: 'Weekly changelog',
        description: 'Summarizes merged work.',
        overview: 'Runs every Friday.',
        recommendedPlugins: [
          { pluginId: 'plugin_linear', recommendedTools: [], reason: 'Reads the merged issues.' },
          { pluginId: 'plugin_gmail', recommendedTools: [], reason: 'Reads the release thread.' },
        ],
        triggers: [{ type: 'calendar', rrule: 'FREQ=WEEKLY;BYDAY=FR', timezone: 'America/Los_angeles', summary: 'Every Friday' }],
        ready: true,
      }),
      assistantMessage: 'Ready to create.',
    };
    renderScreen();

    fireEvent.change(screen.getByRole('textbox', { name: 'Describe an automation' }), {
      target: { value: 'Prepare a weekly changelog' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await completeTurn();

    const runsAs = await screen.findByRole('combobox', { name: 'Runs as' });
    fireEvent.change(runsAs, { target: { value: 'workspace' } });
    expect(screen.queryByRole('checkbox', { name: /^Email/ })).not.toBeInTheDocument();

    // Going back restores the personal pick the workspace scope dropped. The
    // creator has no plugin control left to recover it by hand.
    fireEvent.change(runsAs, { target: { value: 'you' } });
    expect(await screen.findByRole('checkbox', { name: /^Email/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Create automation' }));
    await waitFor(() => expect(api.createAutomation).toHaveBeenCalledWith(
      draftOne,
      ['plugin_linear', 'plugin_gmail'],
      {},
      { scope: 'you', delivery: {} },
    ));
  });

  it('keeps Runs as read-only for a member who cannot create workspace automations', async () => {
    session.workspace.role = 'member';
    agentReply = {
      definition: draftDefinition({
        name: 'Personal digest',
        description: 'Summarizes my day.',
        overview: 'Runs each morning.',
        triggers: [{ type: 'calendar', rrule: 'FREQ=DAILY', timezone: 'America/Los_Angeles', summary: 'Every day at 9:00 AM' }],
        ready: true,
      }),
      assistantMessage: 'Ready to create.',
    };
    renderScreen();

    fireEvent.change(screen.getByRole('textbox', { name: 'Describe an automation' }), {
      target: { value: 'Summarize my day' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await completeTurn();

    expect(await screen.findByText('Runs as')).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Runs as' })).not.toBeInTheDocument();
    // No orphan label: with no select to point at, it is plain text.
    expect(document.querySelector('label[for="automation-scope"]')).toBeNull();
  });

  it('reuses one elicitation identity and preserves answer-response order', async () => {
    agentReply = {
      definition: draftDefinition({
        followUpQuestion: 'Where should Rally send it?',
        elicitation: {
          responseType: 'single_select',
          prompt: 'Where should Rally send it?',
          options: [
            { label: 'Email', value: 'email' },
            { label: 'Slack', value: 'slack' },
          ],
          minimumSelections: 1,
          maximumSelections: 1,
          allowOther: false,
        },
      }),
      assistantMessage: 'Choose where Rally should send the update.',
      pendingElicitationId: elicitationId,
    };
    renderScreen();

    fireEvent.change(screen.getByRole('textbox', { name: 'Describe an automation' }), {
      target: { value: 'Send me a daily update' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await completeTurn();

    expect(await screen.findByRole('heading', { name: 'Where should Rally send it?' })).toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: 'Other' })).not.toBeInTheDocument();
    replies = [{
      definition: draftDefinition({ followUpQuestion: null }),
      assistantMessage: 'The email automation is ready.',
    }];
    fireEvent.click(screen.getByRole('radio', { name: 'Email' }));
    fireEvent.click(screen.getByRole('button', { name: /Submit/u }));

    await waitFor(() => expect(api.admitAutomationDraftTurn).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        automationId: draftOne,
        content: 'email',
        inputMode: 'elicitation_response',
      }),
    ));
    await completeTurn();
    const resolvedQuestion = await screen.findByLabelText('Elicitation response');
    const answerMessage = resolvedQuestion.closest('article');
    const finalMessage = (await screen.findByText('The email automation is ready.')).closest('article');
    expect(resolvedQuestion).toHaveTextContent('Email');
    expect(answerMessage).toHaveClass('human-message', 'own-human-message');
    expect(finalMessage).toHaveClass('agent-message');
    expect(answerMessage!.compareDocumentPosition(finalMessage!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it('resolves a submitted elicitation while the follow-up is still compiling', async () => {
    agentReply = {
      definition: draftDefinition({
        followUpQuestion: 'Where should Rally send it?',
        elicitation: {
          responseType: 'single_select',
          prompt: 'Where should Rally send it?',
          options: [
            { label: 'Email', value: 'email' },
            { label: 'Slack', value: 'slack' },
          ],
          minimumSelections: 1,
          maximumSelections: 1,
          allowOther: false,
        },
      }),
      assistantMessage: 'Choose where Rally should send the update.',
      pendingElicitationId: elicitationId,
    };
    renderScreen();

    fireEvent.change(screen.getByRole('textbox', { name: 'Describe an automation' }), {
      target: { value: 'Send me a daily update' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await completeTurn();

    expect(await screen.findByRole('heading', { name: 'Where should Rally send it?' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: 'Email' }));
    fireEvent.click(screen.getByRole('button', { name: /Submit/u }));

    await waitFor(() => expect(api.admitAutomationDraftTurn).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('heading', { name: 'Where should Rally send it?' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Elicitation response')).toHaveTextContent('Email');
    expect(screen.getByRole('status', { name: 'Rally is working' })).toBeInTheDocument();
  });

  it('drops the tail of a runaway narration rather than the explanation', () => {
    const plan = 'Watching GitHub deployment runs on main.';
    const spew = Array.from({ length: 120 }, (_, index) => `Wait! Column ${index} rejected.`).join('\n\n');

    expect(retainableNarration(`  ${plan}  `)).toBe(plan);
    const retained = retainableNarration(`${plan}\n\n${spew}`);
    expect(retained.startsWith(plan)).toBe(true);
    expect(retained.endsWith('\n\n…')).toBe(true);
    expect(retained.length).toBeLessThan(1_600);
    expect(retained).not.toContain('Wait! Column 119');
  });

  it('says what a failed turn means rather than the agent’s own vocabulary', () => {
    // Every string the agent throws is internal: rendering it puts
    // "evaluator" and "memory table" in front of somebody who asked
    // Rally to watch a blog.
    expect(automationErrorCopy('automation_evaluator_rules_required', 'automation_evaluator_rules_required'))
      .toMatch(/check this automation’s results/u);
    expect(automationErrorCopy('memory_table_key_schema_invalid', null))
      .toMatch(/remember between runs/u);
    expect(automationErrorCopy('automation_workspace_scope_requires_admin', null))
      .toMatch(/owner or admin/u);
    // A sentence the API wrote for a person still reads better than a
    // code; a bare snake_case token reads as neither, so it is not shown.
    expect(automationErrorCopy('unmapped_code', 'Rally took too long to refine the automation.'))
      .toBe('Rally took too long to refine the automation.');
    expect(automationErrorCopy('unmapped_code', 'some_internal_token'))
      .toBe('Rally could not finish this turn.');
    expect(automationErrorCopy(null, null)).toBe('Rally could not finish this turn.');
  });

  it('keeps the narration and explains a failed turn in plain words', async () => {
    renderScreen();

    const example = 'Check this blog every 24 hours for a new post.';
    fireEvent.click(screen.getByRole('button', { name: example }));
    await waitFor(() => expect(api.admitAutomationDraftTurn).toHaveBeenCalled());

    act(() => agentSocket.publish({
      narration: 'No blog connector is authorized, so I am checking the public web instead.',
    }));
    await screen.findByText(/No blog connector is authorized/);

    // A compile that exhausts the wall clock is when the narration explains
    // the most, so it stays on screen rather than being cleared.
    await waitFor(() => expect(failTurn).not.toBeNull());
    await act(async () => {
      failTurn!('automation_plugin_unavailable');
      await Promise.resolve();
    });

    expect(await screen.findByText(
      'No blog connector is authorized, so I am checking the public web instead.',
    )).toBeInTheDocument();
    expect(await screen.findByText(/Reconnect it from Settings/u)).toBeInTheDocument();
    expect(screen.queryByText('automation_plugin_unavailable')).not.toBeInTheDocument();
  });

  it('reapplies the elicitation answer when a failed follow-up is retried', async () => {
    agentReply = {
      definition: draftDefinition({
        followUpQuestion: 'Where should Rally send it?',
        elicitation: {
          responseType: 'single_select',
          prompt: 'Where should Rally send it?',
          options: [{ label: 'Email', value: 'email' }],
          minimumSelections: 1,
          maximumSelections: 1,
          allowOther: false,
        },
      }),
      assistantMessage: 'Choose where Rally should send the update.',
      pendingElicitationId: elicitationId,
    };
    renderScreen();

    fireEvent.change(screen.getByRole('textbox', { name: 'Describe an automation' }), {
      target: { value: 'Send me a daily update' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await completeTurn();
    fireEvent.click(await screen.findByRole('radio', { name: 'Email' }));
    fireEvent.click(screen.getByRole('button', { name: /Submit/u }));

    await waitFor(() => expect(failTurn).not.toBeNull());
    await act(async () => {
      failTurn!('Could not compile the answer');
      await Promise.resolve();
    });

    expect(await screen.findByLabelText('Elicitation response')).toHaveTextContent('Email');
    expect(screen.queryByRole('heading', { name: 'Where should Rally send it?' })).not.toBeInTheDocument();
    replies = [{
      definition: draftDefinition({ followUpQuestion: null }),
      assistantMessage: 'The email automation is ready.',
    }];
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(api.retryAutomationCompiler).toHaveBeenCalled());
    await completeTurn();

    expect(await screen.findByLabelText('Elicitation response')).toHaveTextContent('Email');
    expect(await screen.findByText('The email automation is ready.')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Where should Rally send it?' })).not.toBeInTheDocument();
  });

  it('keeps the stopped turn’s narration and offers to send it again', async () => {
    renderScreen();

    fireEvent.click(screen.getByRole('button', { name: 'Check this blog every 24 hours for a new post.' }));
    await waitFor(() => expect(api.admitAutomationDraftTurn).toHaveBeenCalled());
    act(() => agentSocket.publish({ narration: 'Reading the plugin catalog.' }));
    await screen.findByText('Reading the plugin catalog.');

    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(api.stopAutomationCompiler).toHaveBeenCalled());
    // AutomationAgent drops a cancelled run and its checkpoint with
    // it, so the feed forgets the narration the moment it settles.
    await act(async () => {
      agentSocket.publish({
        snapshot: agentSnapshot({
          automationId: draftOne,
          messages: conversations.get(draftOne) ?? [],
          definition: null,
        }),
        narration: '',
      });
      await Promise.resolve();
    });

    // The narration the reader chose to stop and read is still there,
    // the thought row has settled, and the turn says it was stopped.
    expect(await screen.findByText('Reading the plugin catalog.')).toBeInTheDocument();
    const notice = await screen.findByRole('status', { name: 'Run stopped' });
    expect(notice).toBeVisible();

    fireEvent.click(within(notice).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(api.admitAutomationDraftTurn).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ content: 'Check this blog every 24 hours for a new post.' }),
    ));
  });

  it('says so when the connection drops instead of spinning forever', async () => {
    renderScreen();

    fireEvent.click(screen.getByRole('button', { name: 'Check this blog every 24 hours for a new post.' }));
    await waitFor(() => expect(api.admitAutomationDraftTurn).toHaveBeenCalled());
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();

    act(() => agentSocket.publish({ state: 'reconnecting' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Describe an automation' }), {
      target: { value: 'try that again' },
    });

    // The last `running` snapshot would otherwise stand forever:
    // composer disabled, spinner spinning, nothing naming the network.
    expect(await screen.findByRole('status', { name: 'Reconnecting live updates' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled());
  });
});
