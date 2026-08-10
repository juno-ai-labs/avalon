import { QueryClient, QueryClientProvider, useMutation } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OnboardingChecklist } from '../components/onboarding-checklist';
import { OnboardingProvider, onboardingChecklistQueryKey, withStepState } from './onboarding';
import type { OnboardingChecklist as OnboardingChecklistData } from './types';

const getOnboardingChecklist = vi.fn();
const setOnboardingStepState = vi.fn();
const updateOnboardingChecklist = vi.fn();
const openSettings = vi.fn().mockResolvedValue(undefined);
const openExternal = vi.fn().mockResolvedValue(undefined);

vi.mock('./app-session', () => ({
  useAppSession: () => ({
    api: { getOnboardingChecklist, setOnboardingStepState, updateOnboardingChecklist },
  }),
}));

vi.mock('./platform', () => ({
  desktopBridge: () => ({ openSettings, openExternal }),
}));

function checklistData(overrides: Partial<OnboardingChecklistData> = {}): OnboardingChecklistData {
  return {
    version: '2026-08-10.1',
    title: 'Get started with Avalon',
    completionTitle: "You're set up",
    completionBody: 'All done.',
    steps: [
      {
        id: 'connect-tools',
        title: 'Connect your tools',
        description: 'Bring Linear in',
        state: 'pending',
        source: null,
        resolvedAt: null,
        action: { kind: 'open_settings', section: 'connections' },
        spotlight: null,
      },
      {
        id: 'create-automation',
        title: 'Create your first automation',
        description: 'Schedule a brief',
        state: 'pending',
        source: null,
        resolvedAt: null,
        action: { kind: 'navigate', path: '/automations/new' },
        spotlight: null,
      },
    ],
    completedCount: 0,
    remainingCount: 2,
    totalCount: 2,
    activeStepId: null,
    complete: false,
    dismissed: false,
    ...overrides,
  };
}

function CurrentPath(): React.JSX.Element {
  return <span data-testid="path">{useLocation().pathname}</span>;
}

function UnrelatedWrite(): React.JSX.Element {
  const mutation = useMutation({ mutationFn: async () => 'saved' });
  return <button onClick={() => mutation.mutate()} type="button">Create automation</button>;
}

function renderProvider(): QueryClient {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/workstreams/new']}>
        <OnboardingProvider>
          <OnboardingChecklist />
          <UnrelatedWrite />
          <Routes>
            <Route element={<CurrentPath />} path="*" />
          </Routes>
        </OnboardingProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return queryClient;
}

beforeEach(() => {
  getOnboardingChecklist.mockResolvedValue(checklistData());
  setOnboardingStepState.mockImplementation(async (stepId: string, state: 'pending' | 'completed' | 'skipped') =>
    withStepState(checklistData(), stepId, state));
  updateOnboardingChecklist.mockImplementation(async (input: { activeStepId?: string | null }) =>
    checklistData({ activeStepId: input.activeStepId ?? null }));
});

describe('OnboardingProvider', () => {
  it('renders the server checklist and runs a step action in-app', async () => {
    renderProvider();
    await screen.findByRole('region', { name: 'Get started with Avalon' });

    fireEvent.click(screen.getByRole('button', { name: 'Create your first automationSchedule a brief' }));

    await waitFor(() => expect(screen.getByTestId('path')).toHaveTextContent('/automations/new'));
    expect(updateOnboardingChecklist).toHaveBeenCalledWith({ activeStepId: 'create-automation' });
  });

  it('opens the settings surface for a step that lives there', async () => {
    renderProvider();
    await screen.findByRole('region', { name: 'Get started with Avalon' });

    fireEvent.click(screen.getByRole('button', { name: 'Connect your toolsBring Linear in' }));

    await waitFor(() => expect(openSettings).toHaveBeenCalledWith('connections'));
  });

  it('reflects a marked step before the server answers, with a consistent count', async () => {
    // The request stays in flight, so anything the row shows is the client's
    // own optimistic view of the checklist.
    setOnboardingStepState.mockReturnValue(new Promise(() => undefined));
    renderProvider();
    await screen.findByRole('region', { name: 'Get started with Avalon' });

    fireEvent.click(screen.getByRole('button', { name: 'Mark Connect your tools as done' }));

    await waitFor(() => expect(screen.getByText('1 / 2')).toBeVisible());
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '1');
    expect(setOnboardingStepState).toHaveBeenCalledWith('connect-tools', 'completed');
  });

  it('re-derives the checklist after any other successful write', async () => {
    renderProvider();
    await screen.findByRole('region', { name: 'Get started with Avalon' });
    const reads = getOnboardingChecklist.mock.calls.length;

    fireEvent.click(screen.getByRole('button', { name: 'Create automation' }));

    await waitFor(() => expect(getOnboardingChecklist.mock.calls.length).toBeGreaterThan(reads));
  });

  it('stops asking once the member hides a finished checklist', async () => {
    getOnboardingChecklist.mockResolvedValue(checklistData({
      steps: [],
      completedCount: 0,
      remainingCount: 0,
      totalCount: 0,
      complete: false,
    }));
    renderProvider();

    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByRole('region', { name: 'Get started with Avalon' })).toBeNull();
  });

  it('exposes the checklist under a stable query key for cache updates', async () => {
    const queryClient = renderProvider();
    await screen.findByRole('region', { name: 'Get started with Avalon' });

    expect(queryClient.getQueryData(onboardingChecklistQueryKey)).toMatchObject({ totalCount: 2 });
  });
});
