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

  it('sends an example prompt and opens the automation conversation immediately', async () => {
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
    expect(await screen.findByText('You')).toBeInTheDocument();
    expect(screen.getByText(example)).toBeInTheDocument();
    expect(screen.getByText('Researching and refining the automation…')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'What should happen automatically?' })).not.toBeInTheDocument();

    act(() => {
      stream({ type: 'started' });
      stream({ type: 'delta', delta: 'Which blog ', reset: false });
      stream({ type: 'delta', delta: 'should Avalon monitor?', reset: false });
    });
    expect(await screen.findByText('Which blog should Avalon monitor?')).toBeInTheDocument();
    expect(screen.queryByText('Researching and refining the automation…')).not.toBeInTheDocument();

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
    expect(await screen.findByText('Which blog should Avalon monitor?')).toBeInTheDocument();
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
});
