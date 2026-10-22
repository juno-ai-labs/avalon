import type * as PlatformModule from '../lib/platform';
import * as Tooltip from '@radix-ui/react-tooltip';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AutomationDetail } from '../lib/types';
import { AutomationHeader, type AutomationHeaderProps } from './automation-header';

const openThread = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('../lib/platform', async (importOriginal) => ({
  ...await importOriginal<typeof PlatformModule>(),
  desktopBridge: () => ({ openThread }),
}));

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
    onArchive: vi.fn<() => Promise<void>>(async () => undefined),
    onRunNow: vi.fn<() => void>(),
    onAppearanceChange: vi.fn<AutomationHeaderProps['onAppearanceChange']>(async () => undefined),
    onCopyLink: vi.fn<() => Promise<void>>(async () => undefined),
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

async function openActionsWithKeyboard(): Promise<HTMLElement> {
  const trigger = screen.getByRole('button', { name: 'More Sidekick actions' });
  trigger.focus();
  fireEvent.keyDown(trigger, { key: 'ArrowDown' });
  const run = await screen.findByRole('menuitem', { name: 'Run now' });
  await waitFor(() => expect(run).toHaveFocus());
  return run;
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

  it('keeps Pause visible but unavailable while a draft is being set up', () => {
    const handlers = renderHeader(draft);

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('New automation');
    expect(screen.getByText('Draft')).toBeInTheDocument();
    expect(screen.getByText('Only you')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create' })).toBeNull();
    const pause = screen.getByRole('button', { name: 'Pause' });
    expect(pause).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(pause);
    expect(handlers.onPause).not.toHaveBeenCalled();
    expect(screen.queryByText('Make it work for you')).toBeNull();
    expect(screen.queryByText(/Ask for changes in the conversation/u)).toBeNull();
    expect(screen.getByRole('heading', { name: 'When to expect it' })).toBeVisible();
    expect(screen.getByText('No timing details yet.')).toBeVisible();
  });

  it.each(['draft', 'deleted'] as const)('explains why %s Sidekicks cannot be paused', async (lifecycle) => {
    renderHeader({ ...draft, lifecycle });
    fireEvent.keyDown(document.body, { key: 'Tab' });
    fireEvent.focus(screen.getByRole('button', { name: 'Pause' }));
    expect(await screen.findByRole('tooltip')).toHaveTextContent(lifecycle === 'draft'
      ? 'Finish setting up this Sidekick in the conversation before you can pause it.'
      : 'This Sidekick has been archived and can no longer be paused.');
  });

  it('keeps the lifecycle control visible and inert while an action is pending', () => {
    const handlers = renderHeader({ ...draft, lifecycle: 'active' }, { pending: 'pause' });
    const pause = screen.getByRole('button', { name: 'Pausing…' });
    expect(pause).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(pause);
    expect(handlers.onPause).not.toHaveBeenCalled();
  });

  it('resumes a paused Sidekick from the visible lifecycle control', () => {
    const handlers = renderHeader({ ...draft, lifecycle: 'paused' });
    const resume = screen.getByRole('button', { name: 'Resume' });
    expect(resume).not.toHaveAttribute('aria-disabled');
    fireEvent.click(resume);
    expect(handlers.onResume).toHaveBeenCalledOnce();
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
    expect(screen.queryByText('No timing details yet.')).toBeNull();
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
    expect(screen.getByRole('heading', { name: 'When to expect it' })).toBeVisible();
    const email = screen.getByText('weekly-changelog@automation.rallywith.ai');
    expect(email).not.toBeVisible();
    fireEvent.click(screen.getByText('Email this Sidekick'));
    expect(email).toBeVisible();
    unmount();

    renderHeader({ ...active, currentDefinitionRevision: 2 });
    expect(screen.queryByRole('button', { name: 'Apply changes' })).toBeNull();
  });

  it('describes legacy inbound email even without explicit trigger summaries', () => {
    renderHeader({
      ...draft,
      lifecycle: 'active',
      currentDefinition: { ...definition, triggers: [] },
      emailAddress: 'weekly-changelog@automation.rallywith.ai',
      runnable: true,
    });
    expect(screen.getByRole('list', { name: 'Triggers' })).toHaveTextContent('When an email arrives');
    expect(screen.queryByText('No timing details yet.')).toBeNull();
  });

  it('shows the next scheduled time even without current trigger summaries', () => {
    renderHeader({ ...draft, lifecycle: 'active', nextRunAt: '2026-09-08T12:00:00.000Z', triggerSummaries: [] });
    expect(screen.getByText('When to expect it')).toBeVisible();
    expect(document.querySelector('.automation-runs-next')).toHaveTextContent(/^Next /u);
    expect(screen.queryByRole('list', { name: 'Triggers' })).toBeNull();
    expect(screen.queryByText('No timing details yet.')).toBeNull();
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

  it('copies the Sidekick link from the menu and names a failed copy', async () => {
    const onCopyLink = vi.fn<() => Promise<void>>(async () => { throw new Error('denied'); });
    renderHeader(draft, { onCopyLink });
    fireEvent.pointerDown(screen.getByRole('button', { name: 'More Sidekick actions' }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Copy sidekick link' }));
    expect(await screen.findByText('The Sidekick link could not be copied.')).toBeVisible();
    expect(onCopyLink).toHaveBeenCalledOnce();
  });

  it.each([
    ['draft', false, 'Finish setting up this Sidekick in the conversation before starting a run.'],
    ['active', false, 'Add a trigger in the conversation before starting a run.'],
    ['paused', true, 'Resume this Sidekick before starting a run.'],
    ['deleted', true, 'This Sidekick has been archived and cannot run.'],
  ] as const)('explains unavailable Run now for %s with runnable=%s', async (lifecycle, runnable, reason) => {
    const handlers = renderHeader({ ...draft, lifecycle, runnable });
    const run = await openActionsWithKeyboard();
    expect(run).toHaveAttribute('aria-disabled', 'true');
    expect(await screen.findByRole('tooltip')).toHaveTextContent(reason);
    for (const key of ['Enter', ' ']) {
      fireEvent.keyDown(run, { key });
      expect(handlers.onRunNow).not.toHaveBeenCalled();
      expect(screen.getByRole('menu')).toBeVisible();
      expect(run).toHaveFocus();
    }
  });

  it('keeps unavailable Run history visible, explains it and does not open the dialog', async () => {
    renderHeader(draft);
    const run = await openActionsWithKeyboard();
    fireEvent.keyDown(run, { key: 'ArrowDown' });
    const history = await screen.findByRole('menuitem', { name: 'Run history' });
    await waitFor(() => expect(history).toHaveFocus());
    expect(history).toHaveAttribute('aria-disabled', 'true');
    expect(await screen.findByRole('tooltip')).toHaveTextContent('This Sidekick has no triggers or previous runs.');
    for (const key of ['Enter', ' ']) {
      fireEvent.keyDown(history, { key });
      expect(screen.queryByRole('dialog', { name: 'Run history' })).toBeNull();
      expect(screen.getByRole('menu')).toBeVisible();
      expect(history).toHaveFocus();
    }
  });

  it('starts a runnable active Sidekick from the menu', async () => {
    const handlers = renderHeader({ ...draft, lifecycle: 'active', runnable: true });
    fireEvent.pointerDown(screen.getByRole('button', { name: 'More Sidekick actions' }), { button: 0, ctrlKey: false });
    const run = await screen.findByRole('menuitem', { name: 'Run now' });
    expect(run).not.toHaveAttribute('aria-disabled');
    fireEvent.click(run);
    expect(handlers.onRunNow).toHaveBeenCalledOnce();
  });

  it('archives only after confirmation, explains retention, and keeps a failure in the dialog', async () => {
    const handlers = renderHeader({
      ...draft,
      status: 'active',
      lifecycle: 'active',
      currentDefinition: definition,
      currentDefinitionRevision: 1,
      acceptedDefinitionRevision: 1,
    });
    handlers.onArchive.mockRejectedValueOnce(new Error('The automation is still finishing a run.'));

    fireEvent.pointerDown(screen.getByRole('button', { name: 'More Sidekick actions' }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Archive Sidekick' }));
    const dialog = await screen.findByRole('dialog', { name: 'Archive Sidekick' });
    expect(within(dialog).getByText('Weekly changelog')).toBeVisible();
    expect(within(dialog).getByText(/conversation and run history will remain stored/u)).toBeVisible();
    expect(within(dialog).getByText(/will no longer be viewable/u)).toBeVisible();
    expect(within(dialog).getByText(/does not offer a way to unarchive Sidekicks yet/u)).toBeVisible();
    expect(handlers.onArchive).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Archive' }));
    expect(await screen.findByText('The automation is still finishing a run.')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    expect(handlers.onArchive).toHaveBeenCalledOnce();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Archive' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Archive Sidekick' })).not.toBeInTheDocument());
    expect(handlers.onArchive).toHaveBeenCalledTimes(2);
  });

  it('archives a draft with accurate retained-conversation copy', async () => {
    const handlers = renderHeader(draft);

    fireEvent.pointerDown(screen.getByRole('button', { name: 'More Sidekick actions' }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Archive draft' }));
    const dialog = await screen.findByRole('dialog', { name: 'Archive draft' });
    expect(within(dialog).getByText(/conversation will remain stored but will no longer be viewable/u)).toBeVisible();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Archive' }));
    await waitFor(() => expect(handlers.onArchive).toHaveBeenCalledOnce());
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

  it('names the owning Thread in the scope badge and opens it', () => {
    const threadId = '0191c0de-0000-7000-8000-00000000cafe';
    renderHeader({
      ...draft,
      scope: 'workstream',
      owningWorkstreamId: threadId,
      owningThread: { id: threadId, title: 'Release room', appearance: { icon: 'rocket', color: 'purple' } },
    });

    expect(screen.queryByText('Thread')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Release room' }));
    expect(openThread).toHaveBeenCalledWith(threadId);
  });

  it('says only "Thread" when the reader was not told which one', () => {
    renderHeader({ ...draft, scope: 'workstream', owningWorkstreamId: '0191c0de-0000-7000-8000-00000000cafe' });

    expect(screen.getByText('Thread')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Release room/ })).toBeNull();
  });
});
