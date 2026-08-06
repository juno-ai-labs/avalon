import * as Tooltip from '@radix-ui/react-tooltip';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AutomationAssistantStreamEvent } from '../lib/api';
import { NewAutomationScreen } from './new-automation';

const api = vi.hoisted(() => ({
  compileAutomation: vi.fn(),
  createAutomation: vi.fn(),
  getConnections: vi.fn(),
}));

vi.mock('../lib/app-session', () => ({ useAppSession: () => ({ api }) }));
vi.mock('../lib/platform', () => ({ desktopBridge: () => ({ copyText: vi.fn() }) }));
vi.mock('thinking-orbs', () => ({
  ThinkingOrb: ({ paused = false, state }: { paused?: boolean; state: string }) => (
    <span data-paused={String(paused)} data-state={state} data-testid="thinking-orb" />
  ),
}));

function renderScreen(): void {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  render(
    <Tooltip.Provider>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/automations/new']}>
          <Routes>
            <Route element={<NewAutomationScreen />} path="/automations/new" />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </Tooltip.Provider>,
  );
}

describe('New automation composer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getConnections.mockResolvedValue([]);
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
  });

  it('collapses to its default height after a successful send', async () => {
    renderScreen();

    const composer = screen.getByRole('textbox', { name: 'Describe an automation' });
    Object.defineProperty(composer, 'scrollHeight', { configurable: true, value: 160 });
    fireEvent.change(composer, { target: { value: 'A long automation description\nwith several lines' } });

    expect(composer).toHaveStyle({ height: '160px' });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(api.compileAutomation).toHaveBeenCalledWith(
      { message: 'A long automation description\nwith several lines' },
      expect.any(Function),
    ));
    await waitFor(() => expect(composer).toHaveValue(''));
    expect(composer).toHaveStyle({ height: 'auto' });
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

    await waitFor(() => expect(api.compileAutomation).toHaveBeenCalledWith({ message: example }, expect.any(Function)));
    const humanMessage = (await screen.findByText(example)).closest('article');
    expect(humanMessage).toHaveClass('message-block', 'human-message', 'own-human-message');
    expect(screen.getByText('Avalon is working')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'What should happen automatically?' })).not.toBeInTheDocument();

    act(() => {
      stream({
        type: 'thinking',
        inferenceRequestId: 'inference-1',
        status: 'started',
        durationMs: 0,
      });
    });
    expect(screen.getByText(/working for \d+ms/u)).toBeInTheDocument();
    expect(screen.queryByText('Avalon is working')).not.toBeInTheDocument();

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
        name: 'Searching Google Drive + Docs + Sheets and Linear',
        summary: 'Finding the plugins relevant to this automation…',
        status: 'started',
        plugins: [
          { pluginId: 'plugin_google', displayName: 'Google Drive + Docs + Sheets', icon: 'brand-google-drive' },
          { pluginId: 'plugin_linear', displayName: 'Linear', icon: 'linear' },
        ],
      });
    });
    const activeResearch = (await screen.findByText('Searching Google Drive + Docs + Sheets and Linear')).closest('details');
    expect(activeResearch).toHaveClass('plugin-activity', 'tool-started');
    expect(screen.getByRole('img', { name: 'Plugins: Google Drive + Docs + Sheets, Linear' })).toBeInTheDocument();
    expect(screen.getByTitle('Google Drive + Docs + Sheets')).toBeInTheDocument();
    expect(screen.getByTitle('Linear')).toBeInTheDocument();
    expect(screen.getByText('working for 42ms')).toBeInTheDocument();
    expect(screen.queryByText('Avalon is working')).not.toBeInTheDocument();

    act(() => {
      stream({
        type: 'tool',
        toolCallId: 'tool-1',
        name: 'Found Google Drive + Docs + Sheets and Linear',
        summary: 'Relevant plugins are ready',
        status: 'completed',
        plugins: [
          { pluginId: 'plugin_google', displayName: 'Google Drive + Docs + Sheets', icon: 'brand-google-drive' },
          { pluginId: 'plugin_linear', displayName: 'Linear', icon: 'linear' },
        ],
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
      stream({ type: 'delta', delta: 'should Avalon monitor?', reset: false });
    });
    expect(await screen.findByText('Found Google Drive + Docs + Sheets and Linear')).toBeInTheDocument();
    expect(activeResearch).toHaveClass('plugin-activity', 'tool-completed');
    expect(screen.getByText('42ms')).toBeInTheDocument();
    expect(screen.getByText('working for 1m 23s')).toBeInTheDocument();
    expect(await screen.findByText('Which blog should Avalon monitor?')).toBeInTheDocument();
    expect(screen.queryByText('Avalon is working')).not.toBeInTheDocument();

    await act(async () => {
      resolveCompile({
        draftId: 'draft-example',
        assistantMessage: 'Which blog should Avalon monitor?',
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
    const assistantMessage = (await screen.findByText('Which blog should Avalon monitor?')).closest('article');
    expect(assistantMessage).toHaveClass('message-block', 'agent-message');
    expect(screen.getByRole('textbox', { name: 'Paste the full blog URL.' })).toHaveAttribute(
      'placeholder',
      'https://example.com/blog',
    );
    expect(screen.getAllByText(example)).toHaveLength(1);
  });

  it('suggests optional default plugins without requiring a locked connection', async () => {
    api.getConnections.mockResolvedValue([{
      id: 'connection-linear',
      modelPluginId: 'plugin_linear',
      connectorType: 'linear',
      displayName: 'Linear',
      scope: 'workspace',
      status: 'healthy',
      capabilities: ['linear.read'],
    }]);
    api.compileAutomation.mockResolvedValue({
      draftId: 'draft-linear-personal',
      assistantMessage: 'Ready to create.',
      summary: {
        name: 'Watch my Linear issues',
        description: 'Checks issues available to my Linear account.',
        overview: 'Reviews assigned issues and prepares a concise update.',
        recommendedPlugins: [{
          pluginId: 'plugin_linear',
          recommendedTools: ['linear.search_issues'],
          reason: 'Provides the issue data this automation needs.',
        }],
        scope: 'you',
        triggerSummary: 'Every hour',
        capabilities: ['linear.read'],
      },
    });
    renderScreen();

    fireEvent.change(screen.getByRole('textbox', { name: 'Describe an automation' }), {
      target: { value: 'Check my Linear issues every hour' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByRole('region', { name: 'Default plugins' })).toBeInTheDocument();
    expect(screen.getByText('Recommended')).toBeInTheDocument();
    expect(screen.getByText('Suggested tools: linear.search_issues')).toBeInTheDocument();
    expect(screen.queryByText(/Connect the required provider/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Create automation' }));
    await waitFor(() => expect(api.createAutomation).toHaveBeenCalledWith('draft-linear-personal', ['plugin_linear']));
  });

  it('reuses one elicitation identity and preserves answer-response order', async () => {
    api.compileAutomation
      .mockResolvedValueOnce({
        draftId: 'draft-choice',
        assistantMessage: 'Choose where Avalon should send the update.',
        question: {
          id: 'question-choice',
          prompt: 'Where should Avalon send it?',
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

    expect(await screen.findByRole('heading', { name: 'Where should Avalon send it?' })).toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: 'Other' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: 'Email' }));
    fireEvent.click(screen.getByRole('button', { name: /Submit/u }));

    await waitFor(() => expect(api.compileAutomation).toHaveBeenNthCalledWith(
      2,
      { message: 'email', draftId: 'draft-choice' },
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
        assistantMessage: 'Choose where Avalon should send the update.',
        question: {
          id: 'question-choice',
          prompt: 'Where should Avalon send it?',
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

    expect(await screen.findByRole('heading', { name: 'Where should Avalon send it?' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: 'Email' }));
    fireEvent.click(screen.getByRole('button', { name: /Submit/u }));

    await waitFor(() => expect(api.compileAutomation).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('heading', { name: 'Where should Avalon send it?' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Elicitation response')).toHaveTextContent('Email');
    expect(screen.queryByText('email')).not.toBeInTheDocument();
    expect(screen.getByText('Avalon is working')).toBeInTheDocument();
  });

  it('reapplies the elicitation answer when a failed follow-up is retried', async () => {
    api.compileAutomation
      .mockResolvedValueOnce({
        draftId: 'draft-choice',
        assistantMessage: 'Choose where Avalon should send the update.',
        question: {
          id: 'question-choice',
          prompt: 'Where should Avalon send it?',
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

    expect(await screen.findByRole('heading', { name: 'Where should Avalon send it?' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByLabelText('Elicitation response')).toHaveTextContent('Email');
    expect(await screen.findByText('The email automation is ready.')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Where should Avalon send it?' })).not.toBeInTheDocument();
    expect(screen.queryByText('email')).not.toBeInTheDocument();
  });
});
