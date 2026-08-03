import * as Tooltip from '@radix-ui/react-tooltip';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NewAutomationScreen } from './new-automation';

const api = vi.hoisted(() => ({
  compileAutomation: vi.fn(),
  getConnections: vi.fn(),
  startProviderConnection: vi.fn(),
}));
const openExternal = vi.hoisted(() => vi.fn());

vi.mock('../lib/app-session', () => ({ useAppSession: () => ({ api }) }));
vi.mock('../lib/platform', () => ({ desktopBridge: () => ({ openExternal }) }));

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
      question: { id: 'question-1', prompt: 'What should the automation monitor?' },
    });
    api.startProviderConnection.mockResolvedValue('https://linear.app/oauth/authorize?state=opaque');
    openExternal.mockResolvedValue(undefined);
  });

  it('collapses to its default height after a successful send', async () => {
    renderScreen();

    const composer = screen.getByRole('textbox', { name: 'Describe an automation' });
    Object.defineProperty(composer, 'scrollHeight', { configurable: true, value: 160 });
    fireEvent.change(composer, { target: { value: 'A long automation description\nwith several lines' } });

    expect(composer).toHaveStyle({ height: '160px' });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(api.compileAutomation).toHaveBeenCalledWith({ message: 'A long automation description\nwith several lines' }));
    await waitFor(() => expect(composer).toHaveValue(''));
    expect(composer).toHaveStyle({ height: 'auto' });
  });

  it('starts a personal Linear authorization for a personal automation', async () => {
    api.compileAutomation.mockResolvedValue({
      draftId: 'draft-linear-personal',
      assistantMessage: 'Ready to create.',
      summary: {
        name: 'Watch my Linear issues',
        description: 'Checks issues available to my Linear account.',
        steps: ['Read Linear issues'],
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
    fireEvent.click(await screen.findByRole('button', { name: 'Connect Linear' }));

    await waitFor(() => expect(api.startProviderConnection).toHaveBeenCalledWith(
      'linear',
      'you',
      ['linear.read'],
    ));
    expect(openExternal).toHaveBeenCalledWith('https://linear.app/oauth/authorize?state=opaque');
  });
});
