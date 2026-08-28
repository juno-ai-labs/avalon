import * as Tooltip from '@radix-ui/react-tooltip';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useSyncExternalStore } from 'react';
import { Link, MemoryRouter, Route, Routes, useLocation, type InitialEntry } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../lib/api';
import type { AutomationAssistantStreamEvent } from '../lib/api';
import type { Workspace } from '../lib/types';
import { clearAllDrafts, readDraftText } from '../lib/draft-cache';
import { newAutomationDraftKey } from '../lib/draft-keys';
import { NewAutomationScreen, retainableNarration } from './new-automation';

const api = vi.hoisted(() => ({
  admitAutomationDraftTurn: vi.fn(),
  automationDraftFromAgentSnapshot: vi.fn(),
  compileAutomation: vi.fn(),
  createAutomation: vi.fn(),
  resumeAutomationDraft: vi.fn(),
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
const agentSocket = vi.hoisted(() => ({
  revision: 0,
  snapshot: null as null | Record<string, unknown>,
  streamEvents: [] as Array<{ sequence: number; event: AutomationAssistantStreamEvent }>,
  eventSequence: 0,
  listeners: new Set<() => void>(),
  publish(next: { snapshot?: null | Record<string, unknown>; streamEvent?: AutomationAssistantStreamEvent | null }) {
    if ('snapshot' in next) this.snapshot = next.snapshot ?? null;
    if (next.streamEvent) {
      this.eventSequence += 1;
      this.streamEvents = [...this.streamEvents, { sequence: this.eventSequence, event: next.streamEvent }];
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
  user: { id: 'user-1', email: 'adam@juno-labs.com', name: 'Adam Juhasz' },
  workspace: { id: 'workspace-1', name: 'Juno Labs', region: 'global', role: 'owner' },
}));

const workspace: Workspace = {
  id: 'workspace-1',
  name: 'Juno Labs',
  region: 'global',
  timezone: 'America/Los_Angeles',
  currentUser: { id: 'user-1', name: 'Adam Juhasz', email: 'adam@juno-labs.com', timezone: 'America/Los_Angeles' },
};

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
        streamEvents: agentSocket.streamEvents,
        connected: agentSocket.snapshot !== null,
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
          <Link to="/automations/draft-9">open draft 9</Link>
          <Routes>
            <Route element={<NewAutomationScreen workspace={workspace} />} path="/automations/:id" />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </Tooltip.Provider>,
  );
}

describe('New automation composer', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    copyText.mockResolvedValue(undefined);
    // Restored here rather than at the end of the one test that changes it, so
    // a failure there cannot leak the role into every later test.
    session.workspace.role = 'owner';
    applicationSettings.current = { lockdownMode: false, lockdownAvailable: false, debugEnabled: false };
    featureFlags.current = { automationWorkspaceTemplatesEnabled: true };
    agentSocket.snapshot = null;
    agentSocket.streamEvents = [];
    agentSocket.eventSequence = 0;
    agentSocket.revision += 1;
    await clearAllDrafts();
    api.getConnections.mockResolvedValue([]);
    api.getNotes.mockResolvedValue([]);
    api.getWorkspaceTemplates.mockResolvedValue([]);
    // Loud by default: a test that resumes a draft says so, and one that does
    // not must never have a stale conversation swapped in under it.
    api.resumeAutomationDraft.mockRejectedValue(new Error('no draft was meant to be resumed'));
    api.getAutomationAgentDraft.mockImplementation(async (automationId, signal) => {
      const normalized = await api.resumeAutomationDraft(automationId, signal);
      conversations.set(automationId, normalized);
      return { automationId, activeCompilerRun: null, normalized };
    });
    const conversations = new Map<string, {
      draft: Record<string, unknown> | null;
      messages: Array<{ role: 'user' | 'assistant'; content: string; clientMessageId?: string }>;
    }>();
    let pendingQuestion: {
      id: string;
      responseType: 'free_text' | 'single_select' | 'multi_select';
      options: Array<{ label: string; value: string }>;
      allowOther: boolean;
      presentedAt: string;
    } | null = null;
    let failedRetry: null | {
      automationId: string;
      activeCompilerRun: Record<string, unknown>;
      legacyInput: Record<string, unknown>;
      messages: Array<{ role: 'user' | 'assistant'; content: string; clientMessageId?: string }>;
    } = null;
    api.automationDraftFromAgentSnapshot.mockImplementation((snapshot) => snapshot.normalized);
    api.admitAutomationDraftTurn.mockImplementation(async (input) => {
      const provisionalId = input.automationId ?? 'draft-1';
      const previous = conversations.get(provisionalId) ?? { draft: null, messages: [] };
      const messages = [...previous.messages, {
        role: 'user' as const,
        content: input.content,
        clientMessageId: input.clientMessageId,
      }];
      const activeCompilerRun = {
        id: `run-${input.clientMessageId}`,
        state: 'running',
        admittedTurnId: input.clientMessageId,
        errorCode: null,
        errorMessage: null,
      };
      agentSocket.publish({
        snapshot: {
          automationId: input.automationId ?? null,
          activeCompilerRun,
          normalized: { draft: previous.draft, messages },
        },
        streamEvent: null,
      });
      const connectorMentionCount = (input.content.match(/@[A-Za-z]/gu) ?? []).length;
      const legacyInput: Record<string, unknown> = {
        message: input.content,
        ...(input.automationId ? { draftId: input.automationId } : {}),
        ...(input.attachmentIds?.length ? { attachmentIds: input.attachmentIds } : {}),
        inputMode: input.inputMode,
        connectorMentionCount,
      };
      if (input.inputMode === 'elicitation_response' && pendingQuestion) {
        legacyInput.resolvedElicitation = {
          id: pendingQuestion.id,
          responseType: pendingQuestion.responseType,
          resolution: 'answered',
          customResponseUsed: !pendingQuestion.options.some((option) => option.value === input.content),
          presentedAt: pendingQuestion.presentedAt,
        };
      }
      let response;
      try {
        response = await api.compileAutomation(legacyInput, (event: AutomationAssistantStreamEvent) => {
          agentSocket.publish({ streamEvent: event });
        });
      } catch (error) {
        const failedRun = {
          ...activeCompilerRun,
          state: 'failed',
          errorCode: 'automation_compiler_failed',
          errorMessage: error instanceof Error ? error.message : 'Rally could not finish this turn.',
        };
        failedRetry = { automationId: provisionalId, activeCompilerRun: failedRun, legacyInput, messages };
        agentSocket.publish({
          snapshot: {
            automationId: provisionalId,
            activeCompilerRun: failedRun,
            normalized: { draft: previous.draft, messages },
          },
        });
        return {
          automationId: provisionalId,
          compilerRunId: activeCompilerRun.id,
          admitted: true,
        };
      }
      const automationId = response.draftId;
      const canonicalMessages = [
        ...messages,
        ...(response.assistantMessage ? [{ role: 'assistant' as const, content: response.assistantMessage }] : []),
      ];
      conversations.delete(provisionalId);
      conversations.set(automationId, { draft: response, messages: canonicalMessages });
      pendingQuestion = response.question ? {
        id: response.question.id,
        responseType: response.question.responseType,
        options: response.question.options,
        allowOther: response.question.allowOther,
        presentedAt: new Date().toISOString(),
      } : null;
      agentSocket.publish({
        snapshot: {
          automationId,
          activeCompilerRun: null,
          normalized: { draft: response, messages: canonicalMessages },
        },
        streamEvent: null,
      });
      window.setTimeout(() => agentSocket.publish({
        snapshot: {
          automationId,
          activeCompilerRun: null,
          normalized: { draft: response, messages: canonicalMessages },
        },
      }), 0);
      return {
        automationId,
        turnId: input.clientMessageId,
        transcriptSequence: canonicalMessages.length,
        compilerRunId: activeCompilerRun.id,
        admitted: true,
      };
    });
    api.retryAutomationCompiler.mockImplementation(async () => {
      if (!failedRetry) throw new Error('No failed compiler run');
      const retry = failedRetry;
      const running = { ...retry.activeCompilerRun, state: 'running', errorCode: null, errorMessage: null };
      agentSocket.publish({
        snapshot: {
          automationId: retry.automationId,
          activeCompilerRun: running,
          normalized: { draft: conversations.get(retry.automationId)?.draft ?? null, messages: retry.messages },
        },
      });
      const response = await api.compileAutomation(retry.legacyInput, (event: AutomationAssistantStreamEvent) => {
        agentSocket.publish({ streamEvent: event });
      });
      const canonicalMessages = [
        ...retry.messages,
        ...(response.assistantMessage ? [{ role: 'assistant' as const, content: response.assistantMessage }] : []),
      ];
      conversations.set(response.draftId, { draft: response, messages: canonicalMessages });
      pendingQuestion = response.question ? {
        id: response.question.id,
        responseType: response.question.responseType,
        options: response.question.options,
        allowOther: response.question.allowOther,
        presentedAt: new Date().toISOString(),
      } : null;
      failedRetry = null;
      agentSocket.publish({
        snapshot: {
          automationId: retry.automationId,
          activeCompilerRun: null,
          normalized: { draft: response, messages: canonicalMessages },
        },
      });
    });
    api.stopAutomationCompiler.mockResolvedValue(undefined);
    api.compileAutomation.mockResolvedValue({
      draftId: 'draft-1',
      assistantMessage: 'What should the automation monitor?',
      question: {
        id: 'question-1',
        prompt: 'What should the automation monitor?',
        responseType: 'free_text',
        options: [],
        allowOther: false,
      },
    });
    api.createAutomation.mockResolvedValue({ id: 'automation-1' });
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
    expect(api.compileAutomation).not.toHaveBeenCalled();
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
    expect(api.compileAutomation).not.toHaveBeenCalled();
  });

  it('keeps successful compile attachments available in the transcript', async () => {
    renderScreen();

    const file = new File(['notes'], 'notes.txt', { type: 'text/plain' });
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => expect(api.uploadResource).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(api.compileAutomation).toHaveBeenCalledWith({
      message: '',
      attachmentIds: ['resource-notes'],
      inputMode: 'typed',
      connectorMentionCount: 0,
    }, expect.any(Function)));
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

    await waitFor(() => expect(api.compileAutomation).toHaveBeenCalledWith(
      {
        message: 'A long automation description\nwith several lines',
        inputMode: 'typed', connectorMentionCount: 0,
      },
      expect.any(Function),
    ));
    await waitFor(() => expect(composer).toHaveValue(''));
    expect(composer).toHaveStyle({ height: 'auto' });
  });

  it('copies the stable automation draft ID from the overflow menu', async () => {
    renderScreen();

    fireEvent.change(screen.getByRole('textbox', { name: 'Describe an automation' }), {
      target: { value: 'Check a blog every day' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByText('What should the automation monitor?');

    fireEvent.change(screen.getByRole('textbox', { name: 'What should the automation monitor?' }), {
      target: { value: 'Only on weekdays' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(api.compileAutomation).toHaveBeenNthCalledWith(
      2,
      {
        message: 'Only on weekdays', draftId: 'draft-1',
        inputMode: 'typed', connectorMentionCount: 0,
      },
      expect.any(Function),
    ));

    fireEvent.pointerDown(screen.getByRole('button', { name: 'More automation actions' }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Copy draft ID' }));

    expect(copyText).toHaveBeenCalledWith('draft-1');
  });

  it('reopens a draft from the sidebar on the turn it was left at', async () => {
    api.resumeAutomationDraft.mockResolvedValue({
      draft: {
        draftId: 'draft-9',
        assistantMessage: 'Which blog should I monitor?',
        question: {
          id: 'question-9',
          prompt: 'Which blog should I monitor?',
          responseType: 'free_text',
          options: [],
          allowOther: false,
        },
      },
      messages: [
        { role: 'user', content: 'Watch my blog.' },
        { role: 'assistant', content: 'Which blog should I monitor?' },
      ],
    });
    renderScreen('/automations/draft-9');

    await waitFor(() => expect(api.resumeAutomationDraft).toHaveBeenCalledWith('draft-9', expect.anything()));
    expect(await screen.findByText('Watch my blog.')).toBeVisible();
    // The question the conversation ended on is a question again, not a
    // sentence describing one.
    expect(await screen.findByRole('textbox', { name: 'Which blog should I monitor?' })).toBeVisible();

    fireEvent.change(screen.getByRole('textbox', { name: 'Which blog should I monitor?' }), {
      target: { value: 'https://example.com/blog' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    // Continuing writes back to the same draft rather than starting another.
    await waitFor(() => expect(api.compileAutomation).toHaveBeenCalledWith(
      {
        message: 'https://example.com/blog', draftId: 'draft-9',
        inputMode: 'typed', connectorMentionCount: 0,
      },
      expect.any(Function),
    ));
  });

  it('resumes on a fresh mount whatever the history entry carries', async () => {
    api.resumeAutomationDraft.mockResolvedValue({
      draft: { draftId: 'draft-9', assistantMessage: 'Which blog should I monitor?' },
      messages: [
        { role: 'user', content: 'Watch my blog.' },
        { role: 'assistant', content: 'Which blog should I monitor?' },
      ],
    });
    // Whether a draft still needs loading is a fact about this screen, not
    // about the history entry it is mounted on. A mark left in history state
    // outlives the screen that set it, so a back gesture or a restored window
    // would land here with the load switched off and show an empty builder for
    // a draft that has a conversation.
    renderScreen({
      pathname: '/automations/draft-9',
      state: { selfNamedDraft: true, anythingElse: true },
    });

    expect(await screen.findByText('Watch my blog.')).toBeVisible();
    expect(api.resumeAutomationDraft).toHaveBeenCalledWith('draft-9', expect.anything());
  });

  it('reopens a continued draft at the turn it reached, not the one it was resumed from', async () => {
    const resumed = {
      draft: {
        draftId: 'draft-9',
        assistantMessage: 'Which blog should I monitor?',
        question: {
          id: 'question-9',
          prompt: 'Which blog should I monitor?',
          responseType: 'free_text',
          options: [],
          allowOther: false,
        },
      },
      messages: [
        { role: 'user', content: 'Watch my blog.' },
        { role: 'assistant', content: 'Which blog should I monitor?' },
      ],
    };
    api.resumeAutomationDraft.mockResolvedValue(resumed);
    api.compileAutomation.mockResolvedValue({
      draftId: 'draft-9',
      assistantMessage: 'How often should I check it?',
    });
    renderScreen('/automations/draft-9');

    await screen.findByText('Watch my blog.');
    fireEvent.change(screen.getByRole('textbox', { name: 'Which blog should I monitor?' }), {
      target: { value: 'https://example.com/blog' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByText('How often should I check it?');

    // Leaving and coming back must not serve the conversation from before the
    // answer: the draft on the server has moved on, and a cached copy of the
    // turn it was resumed at would silently roll it back.
    fireEvent.click(screen.getByRole('link', { name: 'back to nothing' }));
    api.resumeAutomationDraft.mockResolvedValue({
      ...resumed,
      messages: [
        ...resumed.messages,
        { role: 'user', content: 'https://example.com/blog' },
        { role: 'assistant', content: 'How often should I check it?' },
      ],
    });
    fireEvent.click(screen.getByRole('link', { name: 'open draft 9' }));

    expect(await screen.findByText('https://example.com/blog')).toBeVisible();
    expect(api.resumeAutomationDraft).toHaveBeenCalledTimes(2);
  });

  it('leaves an unsent message with the draft it was typed in', async () => {
    api.resumeAutomationDraft.mockResolvedValue({
      draft: { draftId: 'draft-9', assistantMessage: 'Which blog should I monitor?' },
      messages: [
        { role: 'user', content: 'Watch my blog.' },
        { role: 'assistant', content: 'Which blog should I monitor?' },
      ],
    });
    renderScreen('/automations/draft-9');
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
    api.resumeAutomationDraft.mockRejectedValue(new ApiError('This draft’s conversation is no longer available.', 409, 'automation_draft_unavailable'));
    renderScreen('/automations/draft-9');

    expect(await screen.findByRole('heading', { name: 'This draft could not be opened' })).toBeVisible();
    expect(screen.getByText('This draft’s conversation is no longer available.')).toBeVisible();

    // Sending here would compile with no draft id, opening a second draft while
    // the sidebar still highlights the first.
    fireEvent.change(screen.getByRole('textbox', { name: 'Describe an automation' }), {
      target: { value: 'carry on then' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(api.compileAutomation).not.toHaveBeenCalled();
  });

  it('leaves an unsent message with a draft this screen named itself', async () => {
    renderScreen();
    fireEvent.change(screen.getByRole('textbox', { name: 'Describe an automation' }), {
      target: { value: 'Check a blog every day' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByText('What should the automation monitor?');
    await waitFor(() => expect(screen.getByTestId('location-pathname')).toHaveTextContent('/automations/draft-1'));

    fireEvent.change(screen.getByRole('textbox', { name: 'What should the automation monitor?' }), {
      target: { value: 'an unsent afterthought' },
    });
    fireEvent.click(screen.getByRole('link', { name: 'back to nothing' }));

    // Every automation created through the product enters this way rather than
    // through a resume, so the launcher's key is the one that has to stop being
    // shared with the draft the first turn named.
    const fresh = await screen.findByRole('textbox', { name: 'Describe an automation' });
    await waitFor(() => expect(fresh).toHaveValue(''));
  });

  it('keeps a turn from landing on the draft the reader moved to', async () => {
    let resolveCompile!: (value: unknown) => void;
    let stream!: (event: AutomationAssistantStreamEvent) => void;
    api.compileAutomation.mockImplementation((_input, onStream) => new Promise((resolve) => {
      resolveCompile = resolve;
      stream = onStream;
    }));
    api.resumeAutomationDraft.mockResolvedValue({
      draft: { draftId: 'draft-9', assistantMessage: 'Which blog should I monitor?' },
      messages: [
        { role: 'user', content: 'Watch my blog.' },
        { role: 'assistant', content: 'Which blog should I monitor?' },
      ],
    });
    renderScreen();

    fireEvent.change(screen.getByRole('textbox', { name: 'Describe an automation' }), {
      target: { value: 'Check a blog every day' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByText('Check a blog every day');

    // The reader opens another draft while that turn is still compiling.
    fireEvent.click(screen.getByRole('link', { name: 'open draft 9' }));
    expect(await screen.findByText('Watch my blog.')).toBeVisible();

    act(() => {
      stream({ type: 'delta', delta: 'Which post types?', reset: false });
      resolveCompile({ draftId: 'draft-1', assistantMessage: 'Which post types?' });
    });

    // Neither the streamed text nor the settled answer belongs to the
    // conversation now on screen, and the turn must not drag the reader back to
    // the draft it was sent from.
    await waitFor(() => expect(screen.getByTestId('location-pathname')).toHaveTextContent('/automations/draft-9'));
    expect(screen.queryByText('Which post types?')).not.toBeInTheDocument();
    expect(screen.queryByText('Check a blog every day')).not.toBeInTheDocument();
  });

  it('clears the conversation the moment another draft is chosen, before it loads', async () => {
    let resolveResume!: (value: unknown) => void;
    api.resumeAutomationDraft.mockImplementation(() => new Promise((resolve) => {
      resolveResume = resolve;
    }));
    renderScreen();

    fireEvent.change(screen.getByRole('textbox', { name: 'Describe an automation' }), {
      target: { value: 'Check a blog every day' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByText('What should the automation monitor?');

    fireEvent.click(screen.getByRole('link', { name: 'open draft 9' }));

    // Leaving the old transcript up while the new draft loads offers a Send
    // that would answer a draft the sidebar says is closed — and a load that
    // never arrives would leave it there for good.
    await waitFor(() => expect(screen.queryByText('Check a blog every day')).not.toBeInTheDocument());
    act(() => {
      resolveResume({
        draft: { draftId: 'draft-9', assistantMessage: 'Which blog should I monitor?' },
        messages: [
          { role: 'user', content: 'Watch my blog.' },
          { role: 'assistant', content: 'Which blog should I monitor?' },
        ],
      });
    });
    expect(await screen.findByText('Watch my blog.')).toBeVisible();
  });

  it('carries an answer typed during a turn onto the draft that turn named', async () => {
    let resolveCompile!: (value: unknown) => void;
    api.compileAutomation.mockImplementation(() => new Promise((resolve) => {
      resolveCompile = resolve;
    }));
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

    act(() => {
      resolveCompile({ draftId: 'draft-1', assistantMessage: 'Noted.' });
    });

    await screen.findByText('Noted.');
    expect(screen.getByRole('textbox', { name: 'Describe an automation' })).toHaveValue('Only weekdays');

    // And it stays with that draft rather than the blank launcher.
    fireEvent.click(screen.getByRole('link', { name: 'back to nothing' }));
    // The cache is what this asserts on, and the composer only afterwards.
    // Re-keying empties the composer synchronously and refills it when the read
    // lands, so a value assertion alone is satisfied by that gap — which is how
    // this test stayed green while the launcher's row still held the sentence,
    // failing only on the runs where the read won the race. An empty row is what
    // makes the empty composer permanent rather than momentary.
    await waitFor(async () => {
      expect(await readDraftText(newAutomationDraftKey('workspace-1'))).toBeNull();
    });
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Describe an automation' })).toHaveValue(''));
    // Moved, not dropped: the sentence is under the draft it was typed for.
    await waitFor(async () => {
      expect((await readDraftText(newAutomationDraftKey('workspace-1', 'draft-1')))?.text)
        .toBe('Only weekdays');
    });
  });

  it('names the draft it just wrote in the address bar, so its sidebar row is the open one', async () => {
    renderScreen();

    fireEvent.change(screen.getByRole('textbox', { name: 'Describe an automation' }), {
      target: { value: 'Check a blog every day' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await screen.findByText('What should the automation monitor?');
    // The screen adopts the API's id rather than the reverse: the turn wrote a
    // draft automation, and the URL has to point at that row.
    await waitFor(() => expect(screen.getByTestId('location-pathname')).toHaveTextContent('/automations/draft-1'));
    // Naming it is not the same as reopening it — the conversation on screen is
    // already the current one.
    expect(api.resumeAutomationDraft).not.toHaveBeenCalled();
  });

  it('uses workstream chat messages while streaming research and the assistant response', async () => {
    let resolveCompile!: (value: unknown) => void;
    let stream!: (event: AutomationAssistantStreamEvent) => void;
    api.compileAutomation.mockImplementation((_input, onStream) => new Promise((resolve) => {
      resolveCompile = resolve;
      stream = onStream;
    }));
    renderScreen();

    const example = 'Check this blog every 24 hours for a new post.';
    fireEvent.click(screen.getByRole('button', { name: example }));

    await waitFor(() => expect(api.compileAutomation).toHaveBeenCalledWith({
      message: example, inputMode: 'suggested_prompt', connectorMentionCount: 0,
    }, expect.any(Function)));
    const humanMessage = (await screen.findByText(example)).closest('article');
    expect(humanMessage).toHaveClass('message-block', 'human-message', 'own-human-message');
    expect(screen.getByRole('status', { name: 'Rally is working' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'What should happen automatically?' })).not.toBeInTheDocument();

    act(() => {
      stream({
        type: 'thinking',
        inferenceRequestId: 'inference-1',
        status: 'started',
        durationMs: 0,
      });
    });
    expect(screen.getByRole('status', { name: 'Rally is working' })).toBeInTheDocument();
    expect(screen.queryByText('Rally is working')).not.toBeInTheDocument();

    act(() => {
      stream({
        type: 'thinking',
        inferenceRequestId: 'inference-1',
        status: 'completed',
        durationMs: 42,
      });
      stream({
        type: 'tool',
        toolCallId: 'tool-1',
        name: 'Reviewing Google Drive + Docs + Sheets',
        summary: 'Using an authorized connector…',
        status: 'started',
        plugin: { pluginId: 'plugin_google', displayName: 'Google Drive + Docs + Sheets', icon: 'brand-google-drive' },
      });
    });
    const activeResearch = (await screen.findByText('Reviewing Google Drive + Docs + Sheets')).closest('details');
    expect(activeResearch).toHaveClass('plugin-activity', 'tool-started');
    expect(screen.getByRole('img', { name: 'Plugin: Google Drive + Docs + Sheets' })).toBeInTheDocument();
    expect(screen.getByTitle('Google Drive + Docs + Sheets')).toBeInTheDocument();
    expect(screen.getByText('worked for 42ms')).toBeInTheDocument();
    expect(screen.queryByText('Rally is working')).not.toBeInTheDocument();

    act(() => {
      stream({
        type: 'tool',
        toolCallId: 'tool-1',
        name: 'Reviewed Google Drive + Docs + Sheets',
        summary: 'Searched the authorized Drive folder',
        status: 'completed',
        plugin: { pluginId: 'plugin_google', displayName: 'Google Drive + Docs + Sheets', icon: 'brand-google-drive' },
        durationMs: 42,
      });
      stream({
        type: 'thinking',
        inferenceRequestId: 'inference-2',
        status: 'started',
        durationMs: 42,
      });
      stream({
        type: 'thinking',
        inferenceRequestId: 'inference-2',
        status: 'completed',
        durationMs: 83_000,
      });
      stream({ type: 'started' });
      stream({ type: 'delta', delta: 'Which blog ', reset: false });
      stream({ type: 'delta', delta: 'should Rally monitor?', reset: false });
    });
    expect(await screen.findByText('Reviewed Google Drive + Docs + Sheets')).toBeInTheDocument();
    expect(activeResearch).toHaveClass('plugin-activity', 'tool-completed');
    expect(screen.getByText('42ms')).toBeInTheDocument();
    expect(screen.getByText('worked for 1m 23s')).toBeInTheDocument();
    expect(await screen.findByText('Which blog should Rally monitor?')).toBeInTheDocument();
    expect(screen.queryByText('Rally is working')).not.toBeInTheDocument();

    await act(async () => {
      resolveCompile({
        draftId: 'draft-example',
        assistantMessage: 'Which blog should Rally monitor?',
        question: {
          id: 'question-example',
          prompt: 'Paste the full blog URL.',
          placeholder: 'https://example.com/blog',
          responseType: 'free_text',
          options: [],
          allowOther: false,
        },
      });
    });
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
    let stream!: (event: AutomationAssistantStreamEvent) => void;
    api.compileAutomation.mockImplementation((_input, onStream) => new Promise(() => { stream = onStream; }));
    renderScreen();

    const example = 'Check this blog every 24 hours for a new post.';
    fireEvent.click(screen.getByRole('button', { name: example }));
    await waitFor(() => expect(api.compileAutomation).toHaveBeenCalled());

    // A model that opens a turn with a bare newline must not render a bubble
    // before it has said anything.
    act(() => {
      stream({ type: 'started' });
      stream({ type: 'delta', delta: '\n', reset: false });
    });
    expect(document.querySelector('.agent-message')).toBeNull();

    act(() => {
      stream({ type: 'delta', delta: 'Checking the plugin catalog.', reset: false });
      stream({ type: 'delta', delta: '\n\nSearching GitHub next.', reset: false });
    });
    expect(await screen.findByText(/Searching GitHub next\./)).toBeInTheDocument();

    // The harness replays the settled text on a reset, so the abandoned turn
    // disappears and the earlier update survives.
    act(() => { stream({ type: 'delta', delta: 'Checking the plugin catalog.', reset: true }); });
    expect(await screen.findByText('Checking the plugin catalog.')).toBeInTheDocument();
    expect(screen.queryByText(/Searching GitHub next\./)).not.toBeInTheDocument();

    // A reset with nothing to restore leaves no bubble at all.
    act(() => { stream({ type: 'delta', delta: '', reset: true }); });
    await waitFor(() => expect(document.querySelector('.agent-message')).toBeNull());
  });

  it('follows streaming narration to the bottom until the reader scrolls up', async () => {
    let stream!: (event: AutomationAssistantStreamEvent) => void;
    api.compileAutomation.mockImplementation((_input, onStream) => new Promise(() => { stream = onStream; }));
    renderScreen();

    const example = 'Check this blog every 24 hours for a new post.';
    fireEvent.click(screen.getByRole('button', { name: example }));
    await waitFor(() => expect(api.compileAutomation).toHaveBeenCalled());

    const surface = document.querySelector('.new-automation-screen') as HTMLElement;
    Object.defineProperty(surface, 'scrollHeight', { configurable: true, value: 4_000 });
    Object.defineProperty(surface, 'clientHeight', { configurable: true, value: 900 });

    act(() => {
      stream({ type: 'started' });
      stream({ type: 'delta', delta: 'Checking the plugin catalog.', reset: false });
    });
    await waitFor(() => expect(surface.scrollTop).toBe(3_100));

    // The follow's own scroll event is dispatched at frame time, by which
    // point more narration has landed and the bottom has moved. Measuring
    // that as the reader scrolling up would switch the follow off a second
    // into every compile.
    Object.defineProperty(surface, 'scrollHeight', { configurable: true, value: 5_000 });
    fireEvent.scroll(surface);
    act(() => { stream({ type: 'delta', delta: ' Still following.', reset: false }); });
    await waitFor(() => expect(surface.scrollTop).toBe(4_100));
    Object.defineProperty(surface, 'scrollHeight', { configurable: true, value: 4_000 });

    // A few pixels above the bottom of the 3_100 scroll range is still the
    // reader taking control. A larger tolerance would read this as "close
    // enough" and yank them forward on the next fragment.
    surface.scrollTop = 3_090;
    fireEvent.scroll(surface);
    act(() => { stream({ type: 'delta', delta: '\n\nSearching GitHub next.', reset: false }); });
    await screen.findByText(/Searching GitHub next\./);
    expect(surface.scrollTop).toBe(3_090);

    surface.scrollTop = 1_000;
    fireEvent.scroll(surface);
    act(() => { stream({ type: 'delta', delta: '\n\nReading the workflow docs.', reset: false }); });
    await screen.findByText(/Reading the workflow docs\./);
    expect(surface.scrollTop).toBe(1_000);

    // Back at the bottom by their own hand, the follow resumes. The one-pixel
    // slack absorbs the fractional maximum a browser clamps a programmatic
    // scroll to; it is not a "near the bottom" allowance.
    surface.scrollTop = 3_099;
    fireEvent.scroll(surface);
    act(() => { stream({ type: 'delta', delta: '\n\nDrafting it now.', reset: false }); });
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
    api.compileAutomation.mockResolvedValue({
      draftId: 'draft-linear-personal',
      assistantMessage: 'Ready to create.',
      summary: {
        name: 'Watch my Linear issues',
        description: 'Checks issues available to my Linear account.',
        overview: 'Reviews assigned issues and prepares a concise update.',
        recommendedPlugins: [{
          pluginId: 'plugin_linear',
          recommendedTools: ['linear_search_issues'],
          reason: 'Provides the issue data this automation needs.',
        }],
        scope: 'you',
        triggerSummary: 'Every hour',
        capabilities: ['linear.read'],
        requiresSlackDelivery: false,
      },
    });
    renderScreen();

    fireEvent.change(screen.getByRole('textbox', { name: 'Describe an automation' }), {
      target: { value: 'Check my Linear issues every hour' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByRole('button', { name: 'Create automation' });
    expect(screen.queryByRole('region', { name: 'Default plugins' })).not.toBeInTheDocument();
    expect(screen.queryByText('Suggested tools: linear_search_issues')).not.toBeInTheDocument();
    expect(screen.queryByText(/Connect the required provider/i)).not.toBeInTheDocument();
    // The picks are preloaded into state with nothing on screen to assert on, so
    // let the effect that sets them commit before acting on it.
    await act(async () => undefined);

    fireEvent.click(screen.getByRole('button', { name: 'Create automation' }));
    await waitFor(() => expect(api.createAutomation).toHaveBeenCalledWith(
      'draft-linear-personal',
      ['plugin_linear'],
      {},
      { scope: 'you', delivery: {} },
    ));
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
    api.compileAutomation.mockResolvedValue({
      draftId: 'draft-merged-pr',
      assistantMessage: 'Ready to create.',
      summary: {
        name: 'Follow up on merged PRs',
        description: 'Starts work when a PR merges.',
        overview: 'Reviews the merged PR and prepares the follow-up.',
        recommendedPlugins: [],
        activitySources: [{
          bindingKey: 'github_source',
          connectorType: 'github',
          suggestedPluginId: 'plugin_github_acme',
        }],
        scope: 'you',
        triggerSummary: 'GitHub: pull request merged',
        capabilities: [],
        requiresSlackDelivery: false,
      },
    });
    renderScreen();

    fireEvent.change(screen.getByRole('textbox', { name: 'Describe an automation' }), {
      target: { value: 'When a PR merges, prepare the follow-up' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    const source = await screen.findByRole('combobox', { name: 'Connector for github_source' });
    await waitFor(() => expect(source).toHaveValue('plugin_github_acme'));
    fireEvent.click(screen.getByRole('button', { name: 'Create automation' }));
    await waitFor(() => expect(api.createAutomation).toHaveBeenCalledWith(
      'draft-merged-pr',
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
    api.compileAutomation.mockResolvedValue({
      draftId: 'draft-slack-digest',
      assistantMessage: 'Ready to create.',
      summary: {
        name: 'Morning email briefing',
        description: 'Stack-ranks Gmail and delivers the top three to Slack.',
        overview: 'Runs every morning.',
        recommendedPlugins: [],
        scope: 'you',
        triggerSummary: 'Every day at 9:00 AM',
        capabilities: ['gmail.read'],
        requiresSlackDelivery: true,
      },
    });
    renderScreen();

    fireEvent.change(screen.getByRole('textbox', { name: 'Describe an automation' }), {
      target: { value: 'Send my top three Gmail messages to Slack each morning' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

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
      'draft-slack-digest',
      [],
      {},
      { scope: 'you', delivery: {} },
    ));
  });

  it('arrives with email ticked when the draft promises an emailed result', async () => {
    api.getConnections.mockResolvedValue([]);
    api.compileAutomation.mockResolvedValue({
      draftId: 'draft-email-briefing',
      assistantMessage: 'Ready to create.',
      summary: {
        name: 'Morning competitor briefing',
        description: 'Summarizes competitor movement.',
        overview: 'Runs every morning.',
        recommendedPlugins: [],
        scope: 'you',
        triggerSummary: 'Every day at 9:00 AM',
        capabilities: [],
        requiresSlackDelivery: false,
        requiresEmailDelivery: true,
      },
    });
    renderScreen();

    fireEvent.change(screen.getByRole('textbox', { name: 'Describe an automation' }), {
      target: { value: 'Email me a competitor briefing every morning' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    // Rally is the only sender: the run is forbidden to mail the result
    // itself. An unticked box here is an automation that emails nobody, on the
    // path where the reader agrees with the screen and presses Create.
    const email = await screen.findByRole('checkbox', { name: /^Email/ });
    expect(email).toBeChecked();
    expect(screen.getByRole('region', { name: 'Deliver results' }))
      .toHaveTextContent('This draft mentions email delivery.');
    await waitFor(() => expect(screen.getByRole('checkbox', { name: /^Email/ })).toBeChecked());

    fireEvent.click(screen.getByRole('button', { name: 'Create automation' }));
    await waitFor(() => expect(api.createAutomation).toHaveBeenCalledWith('draft-email-briefing', [], {}, {
      scope: 'you',
      delivery: { email: true },
    }));
  });

  it('reads a promise to deliver, not the word email in the subject matter', async () => {
    api.getConnections.mockResolvedValue([]);
    api.compileAutomation.mockResolvedValue({
      draftId: 'draft-inbox-triage',
      assistantMessage: 'Ready to create.',
      summary: {
        name: 'Morning inbox triage',
        description: 'Ranks the inbox.',
        overview: 'Runs every morning.',
        recommendedPlugins: [],
        scope: 'you',
        triggerSummary: 'Every day at 9:00 AM',
        capabilities: ['gmail.read'],
        requiresSlackDelivery: false,
        // What the API derives for "A ranked list of your five most important
        // emails" — a briefing *about* email, promising no delivery.
        requiresEmailDelivery: false,
      },
    });
    renderScreen();

    fireEvent.change(screen.getByRole('textbox', { name: 'Describe an automation' }), {
      target: { value: 'Rank my five most important emails each morning' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    // A destination frozen by mistake cannot be changed afterwards, so the
    // nudge has to be wrong in the recoverable direction.
    const email = await screen.findByRole('checkbox', { name: /^Email/ });
    expect(email).not.toBeChecked();
  });

  it('leaves email untouched when the draft never asked for it', async () => {
    api.getConnections.mockResolvedValue([]);
    api.compileAutomation.mockResolvedValue({
      draftId: 'draft-quiet',
      assistantMessage: 'Ready to create.',
      summary: {
        name: 'Weekly changelog',
        description: 'Summarizes merged work in Rally.',
        overview: 'Runs on Fridays.',
        recommendedPlugins: [],
        scope: 'you',
        triggerSummary: 'Fridays at 9:00 AM',
        capabilities: [],
        requiresSlackDelivery: false,
        requiresEmailDelivery: false,
      },
    });
    renderScreen();

    fireEvent.change(screen.getByRole('textbox', { name: 'Describe an automation' }), {
      target: { value: 'Summarize merged work every Friday' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    const email = await screen.findByRole('checkbox', { name: /^Email/ });
    expect(email).not.toBeChecked();
    expect(screen.getByRole('region', { name: 'Deliver results' }))
      .not.toHaveTextContent('mentions email delivery');
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
    api.compileAutomation.mockResolvedValue({
      draftId: 'draft-delivery',
      assistantMessage: 'Ready to create.',
      summary: {
        name: 'Morning briefing',
        description: 'Summarizes the day ahead.',
        overview: 'Runs every morning.',
        recommendedPlugins: [],
        scope: 'you',
        triggerSummary: 'Every day at 9:00 AM',
        capabilities: [],
        requiresSlackDelivery: false,
      },
    });
    renderScreen();

    fireEvent.change(screen.getByRole('textbox', { name: 'Describe an automation' }), {
      target: { value: 'Brief me every morning' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

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
    await waitFor(() => expect(api.createAutomation).toHaveBeenCalledWith('draft-delivery', [], {}, {
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
    api.compileAutomation.mockResolvedValue({
      draftId: 'draft-scope',
      assistantMessage: 'Ready to create.',
      summary: {
        name: 'Weekly changelog',
        description: 'Summarizes merged work.',
        overview: 'Runs every Friday.',
        recommendedPlugins: [
          { pluginId: 'plugin_linear', recommendedTools: [], reason: 'Reads the merged issues.' },
          { pluginId: 'plugin_gmail', recommendedTools: [], reason: 'Reads the release thread.' },
        ],
        scope: 'you',
        triggerSummary: 'Every Friday',
        capabilities: [],
        requiresSlackDelivery: false,
      },
    });
    renderScreen();

    fireEvent.change(screen.getByRole('textbox', { name: 'Describe an automation' }), {
      target: { value: 'Prepare a weekly changelog' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    const runsAs = await screen.findByRole('combobox', { name: 'Runs as' });
    expect(runsAs).toHaveValue('you');
    expect(screen.getByRole('checkbox', { name: /^Email/ })).toBeInTheDocument();

    fireEvent.change(runsAs, { target: { value: 'workspace' } });

    // A workspace automation drops the personal plugin and its personal destinations.
    expect(screen.queryByRole('checkbox', { name: /^Email/ })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Create automation' }));
    await waitFor(() => expect(api.createAutomation).toHaveBeenCalledWith('draft-scope', ['plugin_linear'], {}, {
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
    api.compileAutomation.mockResolvedValue({
      draftId: 'draft-model',
      assistantMessage: 'Ready to create.',
      summary: {
        name: 'Weekly changelog',
        description: 'Summarizes merged work.',
        overview: 'Runs every Friday.',
        recommendedPlugins: [],
        scope: 'you',
        triggerSummary: 'Every Friday',
        capabilities: [],
        requiresSlackDelivery: false,
      },
    });
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

    fireEvent.click(await screen.findByRole('button', { name: 'Create automation' }));
    await waitFor(() => expect(api.createAutomation).toHaveBeenCalledWith('draft-model', [], {}, {
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
    api.compileAutomation.mockResolvedValue({
      draftId: 'draft-scope-restored',
      assistantMessage: 'Ready to create.',
      summary: {
        name: 'Weekly changelog',
        description: 'Summarizes merged work.',
        overview: 'Runs every Friday.',
        recommendedPlugins: [
          { pluginId: 'plugin_linear', recommendedTools: [], reason: 'Reads the merged issues.' },
          { pluginId: 'plugin_gmail', recommendedTools: [], reason: 'Reads the release thread.' },
        ],
        scope: 'you',
        triggerSummary: 'Every Friday',
        capabilities: [],
        requiresSlackDelivery: false,
      },
    });
    renderScreen();

    fireEvent.change(screen.getByRole('textbox', { name: 'Describe an automation' }), {
      target: { value: 'Prepare a weekly changelog' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    const runsAs = await screen.findByRole('combobox', { name: 'Runs as' });
    fireEvent.change(runsAs, { target: { value: 'workspace' } });
    expect(screen.queryByRole('checkbox', { name: /^Email/ })).not.toBeInTheDocument();

    // Going back restores the personal pick the workspace scope dropped. The
    // creator has no plugin control left to recover it by hand.
    fireEvent.change(runsAs, { target: { value: 'you' } });
    expect(await screen.findByRole('checkbox', { name: /^Email/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Create automation' }));
    await waitFor(() => expect(api.createAutomation).toHaveBeenCalledWith(
      'draft-scope-restored',
      ['plugin_linear', 'plugin_gmail'],
      {},
      { scope: 'you', delivery: {} },
    ));
  });

  it('keeps Runs as read-only for a member who cannot create workspace automations', async () => {
    session.workspace.role = 'member';
    api.compileAutomation.mockResolvedValue({
      draftId: 'draft-member',
      assistantMessage: 'Ready to create.',
      summary: {
        name: 'Personal digest',
        description: 'Summarizes my day.',
        overview: 'Runs each morning.',
        recommendedPlugins: [],
        scope: 'you',
        triggerSummary: 'Every day at 9:00 AM',
        capabilities: [],
        requiresSlackDelivery: false,
      },
    });
    renderScreen();

    fireEvent.change(screen.getByRole('textbox', { name: 'Describe an automation' }), {
      target: { value: 'Summarize my day' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(await screen.findByText('Runs as')).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Runs as' })).not.toBeInTheDocument();
    // No orphan label: with no select to point at, it is plain text.
    expect(document.querySelector('label[for="automation-scope"]')).toBeNull();
  });

  it('reuses one elicitation identity and preserves answer-response order', async () => {
    api.compileAutomation
      .mockResolvedValueOnce({
        draftId: 'draft-choice',
        assistantMessage: 'Choose where Rally should send the update.',
        question: {
          id: 'question-choice',
          prompt: 'Where should Rally send it?',
          responseType: 'single_select',
          options: [
            { label: 'Email', value: 'email' },
            { label: 'Slack', value: 'slack' },
          ],
          allowOther: false,
        },
      })
      .mockResolvedValueOnce({
        draftId: 'draft-ready',
        assistantMessage: 'The email automation is ready.',
      });
    renderScreen();

    fireEvent.change(screen.getByRole('textbox', { name: 'Describe an automation' }), {
      target: { value: 'Send me a daily update' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(await screen.findByRole('heading', { name: 'Where should Rally send it?' })).toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: 'Other' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: 'Email' }));
    fireEvent.click(screen.getByRole('button', { name: /Submit/u }));

    await waitFor(() => expect(api.compileAutomation).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        message: 'email', draftId: 'draft-choice', inputMode: 'elicitation_response',
        connectorMentionCount: 0,
        resolvedElicitation: expect.objectContaining({
          id: 'question-choice', responseType: 'single_select', resolution: 'answered',
          customResponseUsed: false,
        }),
      }),
      expect.any(Function),
    ));
    const resolvedQuestion = await screen.findByLabelText('Elicitation response');
    const answerMessage = resolvedQuestion.closest('article');
    const finalMessage = (await screen.findByText('The email automation is ready.')).closest('article');
    expect(resolvedQuestion).toHaveTextContent('Email');
    expect(answerMessage).toHaveClass('human-message', 'own-human-message');
    expect(finalMessage).toHaveClass('agent-message');
    expect(answerMessage!.compareDocumentPosition(finalMessage!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(screen.queryByText('email')).not.toBeInTheDocument();
  });

  it('resolves a submitted elicitation while the follow-up is still compiling', async () => {
    api.compileAutomation
      .mockResolvedValueOnce({
        draftId: 'draft-choice',
        assistantMessage: 'Choose where Rally should send the update.',
        question: {
          id: 'question-choice',
          prompt: 'Where should Rally send it?',
          responseType: 'single_select',
          options: [
            { label: 'Email', value: 'email' },
            { label: 'Slack', value: 'slack' },
          ],
          allowOther: false,
        },
      })
      .mockImplementationOnce(() => new Promise(() => undefined));
    renderScreen();

    fireEvent.change(screen.getByRole('textbox', { name: 'Describe an automation' }), {
      target: { value: 'Send me a daily update' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(await screen.findByRole('heading', { name: 'Where should Rally send it?' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: 'Email' }));
    fireEvent.click(screen.getByRole('button', { name: /Submit/u }));

    await waitFor(() => expect(api.compileAutomation).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('heading', { name: 'Where should Rally send it?' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Elicitation response')).toHaveTextContent('Email');
    expect(screen.queryByText('email')).not.toBeInTheDocument();
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

  it('keeps the narration when a compile fails', async () => {
    let rejectCompile!: (reason: unknown) => void;
    let stream!: (event: AutomationAssistantStreamEvent) => void;
    api.compileAutomation.mockImplementation((_input, onStream) => new Promise((_resolve, reject) => {
      rejectCompile = reject;
      stream = onStream;
    }));
    renderScreen();

    const example = 'Check this blog every 24 hours for a new post.';
    fireEvent.click(screen.getByRole('button', { name: example }));
    await waitFor(() => expect(api.compileAutomation).toHaveBeenCalled());

    act(() => {
      stream({ type: 'started' });
      stream({ type: 'delta', delta: 'No blog connector is authorized,', reset: false });
      stream({ type: 'delta', delta: ' so I am checking the public web instead.', reset: false });
    });
    await screen.findByText(/No blog connector is authorized/);

    // A compile that exhausts the wall clock is when the narration explains
    // the most, so it settles into the transcript rather than being cleared.
    await act(async () => { rejectCompile(new Error('Rally took too long to refine the automation.')); });

    const settled = (await screen.findByText(
      'No blog connector is authorized, so I am checking the public web instead.',
    )).closest('article');
    expect(settled).toHaveClass('message-block', 'agent-message');
    expect(await screen.findByText(/Rally took too long/)).toBeInTheDocument();
  });

  it('reapplies the elicitation answer when a failed follow-up is retried', async () => {
    api.compileAutomation
      .mockResolvedValueOnce({
        draftId: 'draft-choice',
        assistantMessage: 'Choose where Rally should send the update.',
        question: {
          id: 'question-choice',
          prompt: 'Where should Rally send it?',
          responseType: 'single_select',
          options: [{ label: 'Email', value: 'email' }],
          allowOther: false,
        },
      })
      .mockRejectedValueOnce(new Error('Could not compile the answer'))
      .mockResolvedValueOnce({
        draftId: 'draft-ready',
        assistantMessage: 'The email automation is ready.',
      });
    renderScreen();

    fireEvent.change(screen.getByRole('textbox', { name: 'Describe an automation' }), {
      target: { value: 'Send me a daily update' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    fireEvent.click(await screen.findByRole('radio', { name: 'Email' }));
    fireEvent.click(screen.getByRole('button', { name: /Submit/u }));

    expect(await screen.findByLabelText('Elicitation response')).toHaveTextContent('Email');
    expect(screen.queryByRole('heading', { name: 'Where should Rally send it?' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByLabelText('Elicitation response')).toHaveTextContent('Email');
    expect(await screen.findByText('The email automation is ready.')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Where should Rally send it?' })).not.toBeInTheDocument();
    expect(screen.queryByText('email')).not.toBeInTheDocument();
  });
});
