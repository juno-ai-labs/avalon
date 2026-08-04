import * as Tooltip from '@radix-ui/react-tooltip';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AutomationDetail } from '../lib/types';
import { AutomationOverviewScreen } from './automation-overview';

const api = vi.hoisted(() => ({
  adoptAutomationUpdate: vi.fn(),
  getAutomation: vi.fn(),
  runAutomation: vi.fn(),
  setAutomationStatus: vi.fn(),
  shareAutomation: vi.fn(),
  updateAutomation: vi.fn(),
}));
const copyText = vi.hoisted(() => vi.fn());

vi.mock('../lib/app-session', () => ({ useAppSession: () => ({ api }) }));
vi.mock('../components/inspector-rail', () => ({ InspectorRail: () => null }));
vi.mock('../lib/platform', () => ({
  desktopBridge: () => ({ copyText }),
}));

const automationId = '00000000-0000-7000-8000-000000000008';
const nextVersionId = '00000000-0000-7000-8000-000000000011';
const detail: AutomationDetail = {
  id: automationId,
  name: 'Weekly brief',
  emailAddress: 'luminous-tidal-structured-curie@automation.with-avalon.com',
  description: 'A concise weekly status brief.',
  scope: 'you',
  status: 'active',
  statusMessage: 'Update available',
  versionNumber: 1,
  instructions: 'Summarize changes.',
  triggerSummary: 'Every Friday',
  scheduleSummary: 'Every Friday',
  capabilities: ['gmail.read'],
  expectedOutputs: ['A short weekly brief'],
  executionScope: 'You',
  runs: [],
  templateUpdate: {
    versionId: nextVersionId,
    versionNumber: 2,
    instructions: 'Summarize changes and decisions.',
    triggerSummary: 'Every Monday',
    capabilities: ['gmail.read'],
    expectedOutputs: ['A concise weekly brief'],
  },
};

function renderScreen(): QueryClient {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  render(
    <Tooltip.Provider>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[`/automations/${automationId}`]}>
          <Routes>
            <Route element={<AutomationOverviewScreen />} path="/automations/:id" />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </Tooltip.Provider>,
  );
  return queryClient;
}

describe('Automation template updates', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    copyText.mockResolvedValue(undefined);
    vi.stubGlobal('ResizeObserver', class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    });
    api.getAutomation.mockResolvedValue(detail);
    api.adoptAutomationUpdate.mockResolvedValue({
      ...detail,
      statusMessage: undefined,
      versionNumber: 2,
      instructions: 'Summarize changes and decisions.',
      triggerSummary: 'Every Monday',
      scheduleSummary: 'Every Monday',
      templateUpdate: undefined,
    });
  });

  it('keeps the pinned version until the user reviews and explicitly adopts the update', async () => {
    renderScreen();

    expect(await screen.findByText('Version 2 is available')).toBeVisible();
    expect(screen.getByText('Your automation stays on version 1 until you choose to update.')).toBeVisible();
    expect(api.adoptAutomationUpdate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Review update' }));

    const dialog = await screen.findByRole('dialog', { name: 'Review template update' });
    expect(within(dialog).getByText('Summarize changes.')).toBeVisible();
    expect(within(dialog).getByText('Summarize changes and decisions.')).toBeVisible();
    expect(within(dialog).getByText('Every Friday')).toBeVisible();
    expect(within(dialog).getByText('Every Monday')).toBeVisible();
    expect(within(dialog).getByText('A short weekly brief')).toBeVisible();
    expect(within(dialog).getByText('A concise weekly brief')).toBeVisible();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Adopt version 2' }));

    await waitFor(() => expect(api.adoptAutomationUpdate).toHaveBeenCalledWith(automationId, nextVersionId));
    await waitFor(() => expect(screen.queryByText('Version 2 is available')).not.toBeInTheDocument());
    expect(screen.getByText('Summarize changes and decisions.')).toBeVisible();
  });

  it('shows the permanent email trigger and copies it from an icon button', async () => {
    renderScreen();

    const emailAddress = await screen.findByText('luminous-tidal-structured-curie@automation.with-avalon.com');
    expect(emailAddress).toBeVisible();
    expect(screen.getByText('Email this address from your Avalon account email to start a new work stream.')).toBeVisible();

    const copyButton = screen.getByRole('button', {
      name: 'Copy automation email address luminous-tidal-structured-curie@automation.with-avalon.com',
    });
    expect(copyButton).not.toHaveTextContent('luminous-tidal-structured-curie@automation.with-avalon.com');
    fireEvent.click(copyButton);
    expect(copyText).toHaveBeenCalledWith('luminous-tidal-structured-curie@automation.with-avalon.com');
    await waitFor(() => {
      expect(screen.getByRole('button', {
        name: 'Automation email address copied luminous-tidal-structured-curie@automation.with-avalon.com',
      })).toHaveAttribute('title', 'Copied');
    });
  });

  it('explains that workspace automation mail must come from a workspace member', async () => {
    api.getAutomation.mockResolvedValue({ ...detail, scope: 'workspace' });
    renderScreen();

    expect(await screen.findByText(
      'Email this address from a workspace member email to start a new work stream.',
    )).toBeVisible();
  });

  it('keeps the automation copy control retryable when the clipboard write fails', async () => {
    copyText.mockRejectedValueOnce(new Error('clipboard unavailable'));
    renderScreen();

    const emailAddress = 'luminous-tidal-structured-curie@automation.with-avalon.com';
    fireEvent.click(await screen.findByRole('button', {
      name: `Copy automation email address ${emailAddress}`,
    }));
    await waitFor(() => {
      expect(screen.getByRole('button', {
        name: `Copy failed; retry automation email address ${emailAddress}`,
      })).toHaveAttribute('title', 'Copy failed — click to retry');
    });
    expect(screen.getByRole('status')).toHaveTextContent('could not be copied');
  });
});
