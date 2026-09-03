import * as Tooltip from '@radix-ui/react-tooltip';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AutomationDetail } from '../lib/types';
import { AutomationHeader, automationApplyEnabled } from './automation-header';

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

function actions(): Record<'onApply' | 'onPause' | 'onResume' | 'onDelete' | 'onRunNow', ReturnType<typeof vi.fn<() => void>>> {
  return {
    onApply: vi.fn<() => void>(),
    onPause: vi.fn<() => void>(),
    onResume: vi.fn<() => void>(),
    onDelete: vi.fn<() => void>(),
    onRunNow: vi.fn<() => void>(),
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

describe('automationApplyEnabled', () => {
  it('is off before the conversation has submitted a definition', () => {
    expect(automationApplyEnabled(draft)).toBe(false);
  });

  it('is off while the submitted definition still has an open question', () => {
    expect(automationApplyEnabled({
      ...draft,
      currentDefinition: { ...definition, ready: false },
      currentDefinitionRevision: 1,
    })).toBe(false);
  });

  it('is on for a ready revision that is not the one running', () => {
    expect(automationApplyEnabled({
      ...draft,
      currentDefinition: definition,
      currentDefinitionRevision: 1,
    })).toBe(true);
    expect(automationApplyEnabled({
      ...draft,
      currentDefinition: definition,
      currentDefinitionRevision: 2,
      acceptedDefinitionRevision: 1,
    })).toBe(true);
  });

  it('is off once the running revision is the current one', () => {
    expect(automationApplyEnabled({
      ...draft,
      currentDefinition: definition,
      currentDefinitionRevision: 1,
      acceptedDefinitionRevision: 1,
    })).toBe(false);
  });
});

describe('AutomationHeader', () => {
  it('shows a draft as one, with Create disabled until the chat submits a ready definition', () => {
    renderHeader(draft);

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('New automation');
    expect(screen.getByText('Draft')).toBeInTheDocument();
    expect(screen.getByText('Only you')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: /Pause/ })).toBeNull();
  });

  it('enables Create for a ready draft and applies it through the caller', () => {
    const handlers = renderHeader({
      ...draft,
      currentDefinition: definition,
      currentDefinitionRevision: 1,
      triggerSummaries: ['Every Monday at 9:00 AM'],
    });

    // The header names the definition the chat wrote, not the placeholder the
    // object was created with, and lists the triggers rather than describing them.
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Weekly changelog');
    expect(screen.getByRole('list', { name: 'Triggers' })).toHaveTextContent('Every Monday at 9:00 AM');
    const create = screen.getByRole('button', { name: 'Create' });
    expect(create).toBeEnabled();
    fireEvent.click(create);
    expect(handlers.onApply).toHaveBeenCalledOnce();
  });

  it('reads Apply changes on an active automation, enabled only for a newer ready revision', () => {
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
    expect(screen.getByRole('button', { name: 'Apply changes' })).toBeDisabled();
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByText('weekly-changelog@automation.rallywith.ai')).toBeInTheDocument();
    unmount();

    const handlers = renderHeader({ ...active, currentDefinitionRevision: 2 });
    const apply = screen.getByRole('button', { name: 'Apply changes' });
    expect(apply).toBeEnabled();
    fireEvent.click(apply);
    expect(handlers.onApply).toHaveBeenCalledOnce();
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

  it('lists the runs it is given, with their status, and says when there are none', () => {
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
    const runs = screen.getByRole('list', { name: 'Runs' });
    expect(runs).toHaveTextContent('Scheduled');
    expect(runs).toHaveTextContent('Three pull requests merged.');
    expect(runs).toHaveTextContent('completed');
  });
});
