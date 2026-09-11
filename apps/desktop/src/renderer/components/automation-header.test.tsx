import * as Tooltip from '@radix-ui/react-tooltip';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AutomationDetail } from '../lib/types';
import { AutomationHeader, type AutomationHeaderProps } from './automation-header';

const definition: NonNullable<AutomationDetail['currentDefinition']> = {
  name: 'Weekly changelog',
  description: 'Summarize what shipped each week.',
  overview: 'Reads the merged pull requests and writes a changelog.',
  instructions: 'Every Monday, list what merged.',
  triggers: [{ type: 'calendar', rrule: 'FREQ=WEEKLY;BYDAY=MO', timezone: null, summary: 'Every Monday at 9:00 AM' }],
  requiredCapabilities: [],
  expectedOutputs: [],
  defaultBehavior: {},
  recommendedPlugins: [],
  memoryTables: [],
  suggestedScope: 'personal',
  followUpQuestion: null,
  elicitation: null,
  ready: true,
};

const draft: AutomationDetail = {
  id: 'automation-1',
  name: 'New automation',
  description: 'Describe what this automation should do.',
  scope: 'you',
  status: 'draft',
  updatedAt: '2026-09-01T09:00:00.000Z',
  lifecycle: 'draft',
  authorUserId: 'user-1',
  runAsUserId: 'user-1',
  currentDefinition: null,
  currentDefinitionRevision: 0,
  acceptedDefinitionRevision: null,
  connectorBindings: {},
  triggerSummaries: [],
  recentRuns: [],
};

function actions() {
  return {
    onPause: vi.fn<() => void>(),
    onResume: vi.fn<() => void>(),
    onDelete: vi.fn<() => Promise<void>>(async () => undefined),
    onRunNow: vi.fn<() => void>(),
    onAppearanceChange: vi.fn<AutomationHeaderProps['onAppearanceChange']>(async () => undefined),
  };
}

function renderHeader(automation: AutomationDetail, overrides: Partial<React.ComponentProps<typeof AutomationHeader>> = {}) {
  const handlers = actions();
  render(
    <Tooltip.Provider>
      <AutomationHeader automation={automation} {...handlers} {...overrides} />
    </Tooltip.Provider>,
  );
  return handlers;
}

describe('AutomationHeader', () => {
  it('opens the shared appearance picker from the hexagon and saves one field', async () => {
    const handlers = renderHeader({ ...draft, appearance: { icon: 'atom', color: 'blue' } });

    fireEvent.keyDown(screen.getByRole('button', { name: 'Change Sidekick icon and color' }), { key: 'Enter' });
    // The same catalog the work stream's header offers, not a Sidekick-only one.
    expect(await screen.findByRole('menuitemradio', { name: 'Blue' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Rocket' }));

    // Only the field that was clicked: the colour somebody else may have just
    // chosen is not carried along by an icon choice.
    await waitFor(() => expect(handlers.onAppearanceChange).toHaveBeenCalledWith({ icon: 'rocket' }));
  });

  it('shows the conversational draft without an activation button', () => {
    renderHeader(draft);

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('New automation');
    expect(screen.getByText('Draft')).toBeInTheDocument();
    expect(screen.getByText('Only you')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Pause/ })).toBeNull();
  });

  it('shows the generated description and triggers without manual publication', () => {
    renderHeader({
      ...draft,
      currentDefinition: definition,
      currentDefinitionRevision: 1,
      triggerSummaries: ['Every Monday at 9:00 AM'],
    });

    // The header names the definition the chat wrote, not the placeholder the
    // object was created with, and lists the triggers rather than describing them.
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Weekly changelog');
    expect(screen.getByRole('list', { name: 'Triggers' })).toHaveTextContent('Every Monday at 9:00 AM');
    expect(screen.queryByRole('button', { name: 'Create' })).toBeNull();
  });

  it('shows saved state and never offers Apply changes', () => {
    const active: AutomationDetail = {
      ...draft,
      status: 'active',
      lifecycle: 'active',
      currentDefinition: definition,
      currentDefinitionRevision: 1,
      acceptedDefinitionRevision: 1,
      emailAddress: 'weekly-changelog@automation.rallywith.ai',
    };
    const { unmount } = render(
      <Tooltip.Provider><AutomationHeader automation={active} {...actions()} /></Tooltip.Provider>,
    );
    expect(screen.queryByRole('button', { name: 'Apply changes' })).toBeNull();
    expect(screen.getByText('Active')).toBeInTheDocument();
    const email = screen.getByText('weekly-changelog@automation.rallywith.ai');
    expect(email).not.toBeVisible();
    fireEvent.click(screen.getByText('Email this Sidekick'));
    expect(email).toBeVisible();
    unmount();

    renderHeader({ ...active, currentDefinitionRevision: 2 });
    expect(screen.queryByRole('button', { name: 'Apply changes' })).toBeNull();
  });

  it('shows the next scheduled time even without current trigger summaries', () => {
    renderHeader({ ...draft, lifecycle: 'active', nextRunAt: '2026-09-08T12:00:00.000Z', triggerSummaries: [] });
    expect(screen.getByText('When to expect it')).toBeVisible();
    expect(document.querySelector('.automation-runs-next')).toHaveTextContent(/^Next /u);
    expect(screen.queryByRole('list', { name: 'Triggers' })).toBeNull();
  });

  it('offers Pause on an active automation and Resume on a paused one', () => {
    const base: AutomationDetail = {
      ...draft,
      currentDefinition: definition,
      currentDefinitionRevision: 1,
      acceptedDefinitionRevision: 1,
    };
    const active = renderHeader({ ...base, status: 'active', lifecycle: 'active' });
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    expect(active.onPause).toHaveBeenCalledOnce();
    expect(screen.queryByRole('button', { name: 'Resume' })).toBeNull();
  });

  it('keeps Run now and Apply off while paused, since the object refuses both', async () => {
    const paused = renderHeader({
      ...draft,
      status: 'paused',
      lifecycle: 'paused',
      currentDefinition: definition,
      currentDefinitionRevision: 2,
      acceptedDefinitionRevision: 1,
    });

    // A newer ready revision on a paused automation: Apply used to light up
    // and the object answered 409 sidekick_not_active; Run now was offered
    // and answered the same. Resume is the one thing to do here.
    expect(screen.queryByRole('button', { name: 'Apply changes' })).toBeNull();
    fireEvent.pointerDown(screen.getByRole('button', { name: 'More Sidekick actions' }), { button: 0, ctrlKey: false });
    expect(await screen.findByRole('menuitem', { name: 'Run now' })).toHaveAttribute('aria-disabled', 'true');
    expect(paused.onRunNow).not.toHaveBeenCalled();
  });

  it('deletes only after the confirmation dialog, and keeps a failure in it', async () => {
    const handlers = renderHeader({
      ...draft,
      status: 'active',
      lifecycle: 'active',
      currentDefinition: definition,
      currentDefinitionRevision: 1,
      acceptedDefinitionRevision: 1,
    });
    handlers.onDelete.mockRejectedValueOnce(new Error('The automation is still finishing a run.'));

    // The sidebar always asked; the header fired the tombstone from a menu
    // item with no question. Same dialog, same copy, on both.
    fireEvent.pointerDown(screen.getByRole('button', { name: 'More Sidekick actions' }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete Sidekick' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete Sidekick' });
    expect(within(dialog).getByText('Weekly changelog')).toBeVisible();
    expect(handlers.onDelete).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    expect(await within(dialog).findByText('The automation is still finishing a run.')).toBeVisible();
    expect(handlers.onDelete).toHaveBeenCalledOnce();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Delete Sidekick' })).not.toBeInTheDocument());
    expect(handlers.onDelete).toHaveBeenCalledTimes(2);
  });

  it('keeps runs off the initial page and shows them only through More and Run history', async () => {
    const active: AutomationDetail = {
      ...draft,
      status: 'active',
      lifecycle: 'active',
      currentDefinition: definition,
      currentDefinitionRevision: 1,
      acceptedDefinitionRevision: 1,
    };
    const { unmount } = render(
      <Tooltip.Provider><AutomationHeader automation={active} runs={[]} {...actions()} /></Tooltip.Provider>,
    );
    expect(screen.queryByText('No runs yet')).toBeNull();
    expect(screen.queryByRole('dialog', { name: 'Run history' })).toBeNull();
    fireEvent.pointerDown(screen.getByRole('button', { name: 'More Sidekick actions' }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Run history' }));
    expect(await screen.findByRole('dialog', { name: 'Run history' })).toBeVisible();
    expect(screen.getByText('No runs yet')).toBeInTheDocument();
    unmount();

    renderHeader(active, {
      runs: [{
        id: 'run-1',
        automationId: 'automation-1',
        triggerType: 'schedule',
        status: 'completed',
        plannedFor: '2026-09-01T09:00:00.000Z',
        startedAt: '2026-09-01T09:00:00.000Z',
        completedAt: '2026-09-01T09:00:30.000Z',
        resultSummary: 'Three pull requests merged.',
        createdAt: '2026-09-01T09:00:00.000Z',
      }],
    });
    expect(screen.queryByRole('list', { name: 'Runs' })).toBeNull();
    expect(screen.queryByText('Three pull requests merged.')).toBeNull();
    fireEvent.pointerDown(screen.getByRole('button', { name: 'More Sidekick actions' }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Run history' }));
    const dialog = await screen.findByRole('dialog', { name: 'Run history' });
    const runs = within(dialog).getByRole('list', { name: 'Runs' });
    expect(runs).toHaveTextContent('Scheduled');
    expect(runs).toHaveTextContent('Three pull requests merged.');
    expect(runs).toHaveTextContent('Latest run completed');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close dialog' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Run history' })).toBeNull());
    expect(screen.queryByRole('list', { name: 'Runs' })).toBeNull();
  });
});
