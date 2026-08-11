import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import * as Tooltip from '@radix-ui/react-tooltip';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesktopApplicationSettings } from '../../common/desktop';
import type { AutomationSummary, NoteSummary, Workspace, WorkstreamSummary } from '../lib/types';
import { useUiStore } from '../lib/ui-store';
import { Sidebar } from './sidebar';

const copyText = vi.hoisted(() => vi.fn());
const openSettings = vi.hoisted(() => vi.fn());
const applicationSettings = vi.hoisted(() => ({
  current: { lockdownMode: false, lockdownAvailable: false, debugEnabled: false, developerSettingsAvailable: true, menuBarEnabled: true, menuBarAvailable: true, menuBarPresent: true, launchAtLogin: true, launchAtLoginAvailable: true },
  listeners: new Set<(settings: unknown) => void>(),
}));

function announceApplicationSettings(settings: DesktopApplicationSettings): void {
  applicationSettings.current = settings;
  act(() => {
    for (const listener of applicationSettings.listeners) listener(settings);
  });
}

vi.mock('../lib/platform', () => ({
  desktopBridge: () => ({
    copyText,
    openSettings,
    getRuntimeConfig: () => Promise.resolve({ webBaseUrl: 'https://with-avalon.com' }),
    getApplicationSettings: () => Promise.resolve(applicationSettings.current),
    onApplicationSettingsChanged: (listener: (settings: unknown) => void) => {
      applicationSettings.listeners.add(listener);
      return () => applicationSettings.listeners.delete(listener);
    },
  }),
}));

const workspace: Workspace = {
  id: 'workspace-1',
  name: 'Avalon Studio',
  region: 'global',
  timezone: 'America/Los_Angeles',
  logAgentInference: false,
  currentUser: { id: 'user-1', name: 'Adam', email: 'adam@example.com', timezone: 'America/Los_Angeles' },
};

const defaultActions = {
  onArchiveDraftAutomation: async (): Promise<void> => undefined,
  onArchiveNote: async (): Promise<void> => undefined,
  onChangeNoteScope: async (): Promise<void> => undefined,
  onChangeWorkstreamScope: async (): Promise<void> => undefined,
  onDeleteAutomation: async (): Promise<void> => undefined,
  onMarkWorkstreamUnread: async (): Promise<void> => undefined,
  onOpenMeetingNotes: async (): Promise<void> => undefined,
  onPinWorkstream: async (): Promise<void> => undefined,
  onReorderPinnedWorkstreams: async (): Promise<void> => undefined,
  onRenameWorkstream: async (): Promise<void> => undefined,
  onRunAutomation: async (): Promise<void> => undefined,
};

const automation: AutomationSummary = {
  id: 'automation-1',
  name: 'Daily product brief',
  scope: 'you',
  status: 'active',
  nextRunAt: '2026-08-01T16:00:00.000Z',
  updatedAt: '2026-07-20T09:00:00.000Z',
};

function workstream(
  id: string,
  title: string,
  harnessStatus: WorkstreamSummary['harnessStatus'],
  origin: WorkstreamSummary['origin'] = 'ad_hoc',
  lastActivityAt = '2026-07-31T20:00:00.000Z',
): WorkstreamSummary {
  return {
    id,
    title,
    titleStatus: 'settled',
    origin,
    harnessStatus,
    scope: 'workspace' as const,
    latestAttentionSequenceNumber: 0,
    readThroughSequenceNumber: 0,
    manualUnreadFromSequenceNumber: null,
    manualUnreadGeneration: 0,
    hasUnread: false,
    firstUnreadSequenceNumber: null,
    pinPosition: null,
    lastActivityAt,
  };
}

/** The same work stream, pinned by the viewer at `position`. */
function pinned(workstream: WorkstreamSummary, position: number): WorkstreamSummary {
  return { ...workstream, pinPosition: position };
}

function note(id: string, title: string, lastActivityAt: string): NoteSummary {
  return {
    id,
    workspaceId: '00000000-0000-4000-8000-000000000010',
    resourceId: '00000000-0000-4000-8000-000000000011',
    ownerUserId: workspace.currentUser.id,
    scope: 'personal',
    title,
    recordingStatus: 'complete',
    recordedMs: 60_000,
    startedAt: '2026-07-31T19:00:00.000Z',
    endedAt: '2026-07-31T19:01:00.000Z',
    generatedAt: null,
    lastActivityAt,
    createdAt: lastActivityAt,
    updatedAt: lastActivityAt,
    archivedAt: null,
  };
}

describe('Sidebar work-stream markers', () => {
  beforeEach(() => {
    window.localStorage.clear();
    copyText.mockReset().mockResolvedValue(undefined);
    applicationSettings.current = { lockdownMode: false, lockdownAvailable: false, debugEnabled: false, developerSettingsAvailable: true, menuBarEnabled: true, menuBarAvailable: true, menuBarPresent: true, launchAtLogin: true, launchAtLoginAvailable: true };
    applicationSettings.listeners.clear();
    useUiStore.setState({ sidebarOpen: false, sidebarWidth: 300 });
    vi.stubGlobal('ResizeObserver', class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it('resizes from the keyboard and exposes its constrained width', () => {
    render(
      <MemoryRouter>
        <Tooltip.Provider>
          <Sidebar {...defaultActions} automations={[]} onSignOut={vi.fn()} workspace={workspace} workstreams={[]} />
        </Tooltip.Provider>
      </MemoryRouter>,
    );

    const resizer = screen.getByRole('separator', { name: 'Resize navigation' });
    expect(resizer).toHaveAttribute('aria-valuenow', '300');

    fireEvent.keyDown(resizer, { key: 'ArrowRight' });
    expect(resizer).toHaveAttribute('aria-valuenow', '316');
    expect(window.localStorage.getItem('avalon.sidebar-width')).toBe('316');

    fireEvent.keyDown(resizer, { key: 'ArrowLeft' });
    expect(resizer).toHaveAttribute('aria-valuenow', '300');
  });

  // The pill answers to how near the pointer is rather than to hovering the
  // handle, so the reveal reaches 20px without the hit area having to.
  it('reveals the navigation pill once the pointer is near the edge, at any height', () => {
    render(
      <MemoryRouter>
        <Tooltip.Provider>
          <Sidebar {...defaultActions} automations={[]} onSignOut={vi.fn()} workspace={workspace} workstreams={[]} />
        </Tooltip.Provider>
      </MemoryRouter>,
    );

    const resizer = screen.getByRole('separator', { name: 'Resize navigation' });
    expect(resizer).not.toHaveClass('is-near');

    fireEvent.pointerMove(window, { clientX: 316, clientY: 780 });
    expect(resizer).toHaveClass('is-near');

    fireEvent.pointerMove(window, { clientX: 316, clientY: 90 });
    expect(resizer).toHaveClass('is-near');

    fireEvent.pointerMove(window, { clientX: 340, clientY: 400 });
    expect(resizer).not.toHaveClass('is-near');
  });

  // The handle stands in a strip beside the sidebar rather than on its edge, so
  // a grab at the far side of that strip must still move the sidebar by what
  // the pointer moves rather than snapping the edge out to meet it.
  it('drags from wherever the handle was grabbed without snapping the edge to the pointer', () => {
    render(
      <MemoryRouter>
        <Tooltip.Provider>
          <Sidebar {...defaultActions} automations={[]} onSignOut={vi.fn()} workspace={workspace} workstreams={[]} />
        </Tooltip.Provider>
      </MemoryRouter>,
    );

    const resizer = screen.getByRole('separator', { name: 'Resize navigation' });
    resizer.setPointerCapture = vi.fn();

    fireEvent.pointerDown(resizer, { clientX: 318, pointerId: 3 });
    fireEvent.pointerMove(window, { clientX: 318, pointerId: 3 });
    expect(resizer).toHaveAttribute('aria-valuenow', '300');

    fireEvent.pointerMove(window, { clientX: 358, pointerId: 3 });
    expect(resizer).toHaveAttribute('aria-valuenow', '340');

    fireEvent.pointerUp(window, { pointerId: 3 });
    fireEvent.pointerMove(window, { clientX: 400, pointerId: 3 });
    expect(resizer).toHaveAttribute('aria-valuenow', '340');
  });

  // OnboardingChecklist is disabled (demo-only, local-state-only, and had no
  // dismiss mechanism — see the commented-out render call in sidebar.tsx).
  // This guards against it silently coming back.
  it('does not render the disabled onboarding checklist', () => {
    render(
      <MemoryRouter>
        <Tooltip.Provider>
          <Sidebar {...defaultActions} automations={[]} onSignOut={vi.fn()} workspace={workspace} workstreams={[]} />
        </Tooltip.Provider>
      </MemoryRouter>,
    );

    expect(screen.queryByRole('region', { name: 'Get started with Avalon' })).not.toBeInTheDocument();
  });

  it('uses the compact status-dot pattern for every work stream', () => {
    render(
      <MemoryRouter initialEntries={['/workstreams/input']}>
        <Tooltip.Provider>
          <Sidebar
            {...defaultActions}
            automations={[]}
            onSignOut={vi.fn()}
            workspace={workspace}
            workstreams={[
              workstream('input', 'Board decision', 'needs_input'),
              workstream('running', 'Pricing restructure', 'running'),
              workstream('completed', 'Missing sidebar row', 'completed'),
              workstream('scheduled', 'Monday review', 'scheduled'),
              workstream('automation', 'PostHog follow-up', 'completed', 'automation'),
            ]}
          />
        </Tooltip.Provider>
      </MemoryRouter>,
    );

    expect(screen.getByRole('link', { name: /Board decision/u }).querySelector('.status-needs_input .status-dot')).not.toBeNull();
    expect(screen.getByRole('link', { name: /Pricing restructure/u }).querySelector('.status-running .status-dot')).not.toBeNull();
    expect(screen.getByRole('link', { name: /Missing sidebar row/u }).querySelector('.status-completed .status-dot')).not.toBeNull();
    expect(screen.getByRole('link', { name: /Monday review/u }).querySelector('.status-scheduled .status-dot')).not.toBeNull();
    expect(screen.getByRole('link', { name: /PostHog follow-up/u }).querySelector('.status-completed .status-dot')).not.toBeNull();
    expect(document.querySelector('.sidebar-automation-marker')).toBeNull();
    expect(screen.queryByRole('img', { name: /Automation-generated/u })).not.toBeInTheDocument();
    expect(document.querySelector('.brand-lockup')).toBeNull();
    expect(document.querySelector('.sidebar-titlebar')).not.toBeNull();
  });

  it('waits for a name rather than showing the request a work stream was created from', () => {
    const naming = { ...workstream('naming', 'Create an email draft to Danny from Mucker that…', 'running'), titleStatus: 'naming' as const };
    render(
      <MemoryRouter initialEntries={['/workstreams/naming']}>
        <Tooltip.Provider>
          <Sidebar
            {...defaultActions}
            automations={[]}
            onSignOut={vi.fn()}
            workspace={workspace}
            workstreams={[naming, workstream('named', 'Board decision', 'needs_input')]}
          />
        </Tooltip.Provider>
      </MemoryRouter>,
    );

    const row = screen.getByRole('link', { name: /naming this work stream/u });
    expect(row.querySelector('.title-skeleton')).not.toBeNull();
    expect(row.textContent).not.toContain('Create an email draft');
    // A settled title is text, not a skeleton — the placeholder is only for the
    // second or so before Avalon answers.
    expect(screen.getByRole('link', { name: /Board decision/u }).querySelector('.title-skeleton')).toBeNull();
  });

  it('explains a work-stream dot color on hover', async () => {
    render(
      <MemoryRouter>
        <Tooltip.Provider>
          <Sidebar
            {...defaultActions}
            automations={[]}
            onSignOut={vi.fn()}
            workspace={workspace}
            workstreams={[workstream('input', 'Board decision', 'needs_input')]}
          />
        </Tooltip.Provider>
      </MemoryRouter>,
    );

    const dot = screen.getByRole('link', { name: /Board decision/u }).querySelector('.status-needs_input');
    if (!dot) throw new Error('the work-stream row rendered no needs-input status dot');
    fireEvent.pointerMove(dot, { pointerType: 'mouse' });

    expect(await screen.findByText('Needs input — the agent is waiting on an answer.')).toBeVisible();
  });

  it('renders only populated recency sections and keeps status from changing row order', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-31T20:00:00.000Z'));

    try {
      render(
        <MemoryRouter>
          <Tooltip.Provider>
            <Sidebar
              {...defaultActions}
              automations={[]}
              onSignOut={vi.fn()}
              workspace={workspace}
              workstreams={[
                workstream('old-input', 'Old input request', 'needs_input', 'ad_hoc', '2026-06-12T12:00:00.000Z'),
                workstream('month-scheduled', 'Scheduled this month', 'scheduled', 'ad_hoc', '2026-07-10T12:00:00.000Z'),
                workstream('week-scheduled', 'Scheduled this week', 'scheduled', 'ad_hoc', '2026-07-27T12:00:00.000Z'),
                workstream('yesterday-failed', 'Failed yesterday', 'failed', 'ad_hoc', '2026-07-30T12:00:00.000Z'),
                workstream('day-running', 'Recently running', 'running', 'ad_hoc', '2026-07-31T08:00:00.000Z'),
                workstream('hour-complete', 'Just completed', 'completed', 'ad_hoc', '2026-07-31T19:50:00.000Z'),
              ]}
            />
          </Tooltip.Provider>
        </MemoryRouter>,
      );

      expect(screen.getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent)).toEqual([
        'Last hour',
        'Today',
        'Yesterday',
        'This week',
        'This month',
        'Before this month',
      ]);
      expect(screen.queryByRole('heading', { name: 'Work streams' })).not.toBeInTheDocument();
      expect([...document.querySelectorAll('.workstream-row .sidebar-row-title')].map((row) => row.textContent)).toEqual([
        'Just completed',
        'Recently running',
        'Failed yesterday',
        'Scheduled this week',
        'Scheduled this month',
        'Old input request',
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows the requested automation actions on right click and runs the automation', async () => {
    const onRunAutomation = vi.fn(async () => undefined);
    render(
      <MemoryRouter>
        <Tooltip.Provider>
          <Sidebar
            {...defaultActions}
            automations={[automation]}
            onRunAutomation={onRunAutomation}
            onSignOut={vi.fn()}
            workspace={workspace}
            workstreams={[]}
          />
        </Tooltip.Provider>
      </MemoryRouter>,
    );

    fireEvent.contextMenu(screen.getByRole('link', { name: /Daily product brief/u }), { clientX: 120, clientY: 90 });

    expect(await screen.findByRole('menuitem', { name: 'Run now' })).toBeVisible();
    expect(screen.getByRole('menuitem', { name: 'Turn into template' })).toBeVisible();
    expect(screen.getByRole('menuitem', { name: 'Delete automation' })).toHaveClass('menu-item-danger');
    expect(screen.queryByRole('menuitem', { name: 'Archive draft' })).not.toBeInTheDocument();
    expect(screen.queryByText(/^[PTRADU]$/u)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('menuitem', { name: 'Run now' }));
    await waitFor(() => expect(onRunAutomation).toHaveBeenCalledWith(automation));
  });

  it('sinks drafts under the automations that run, newest draft first, and archives one from its menu', async () => {
    const onArchiveDraftAutomation = vi.fn(async () => undefined);
    const staleDraft: AutomationSummary = {
      id: 'automation-2',
      name: 'Ad hoc competitor scan',
      scope: 'you',
      status: 'draft',
      updatedAt: '2026-07-28T11:00:00.000Z',
    };
    const freshDraft: AutomationSummary = {
      id: 'automation-3',
      name: 'A support escalation digest',
      scope: 'you',
      status: 'draft',
      updatedAt: '2026-08-02T11:00:00.000Z',
    };
    render(
      <MemoryRouter>
        <Tooltip.Provider>
          <Sidebar
            {...defaultActions}
            automations={[staleDraft, automation, freshDraft]}
            onArchiveDraftAutomation={onArchiveDraftAutomation}
            onSignOut={vi.fn()}
            workspace={workspace}
            workstreams={[]}
          />
        </Tooltip.Provider>
      </MemoryRouter>,
    );

    // Drafts follow the automations that run, and lead with the one touched
    // most recently rather than the alphabetically first one.
    const section = screen.getByRole('region', { name: 'Automations' });
    expect([...section.querySelectorAll('.sidebar-row-title')].map((row) => row.textContent)).toEqual([
      'Daily product brief',
      'A support escalation digest',
      'Ad hoc competitor scan',
    ]);
    const draftRow = screen.getByRole('link', { name: /Ad hoc competitor scan/u });
    expect(draftRow).toHaveClass('is-draft');
    expect(draftRow.querySelector('.mini-state.draft')).not.toBeNull();
    expect(within(draftRow).getByText('Draft')).toBeVisible();
    // A draft has no overview worth opening — it has never run. Its row goes
    // back to the conversation that was left unfinished.
    expect(draftRow).toHaveAttribute('href', '/automations/new?draft=automation-2');
    expect(screen.getByRole('link', { name: /Daily product brief/u }))
      .toHaveAttribute('href', '/automations/automation-1');

    fireEvent.contextMenu(draftRow, { clientX: 120, clientY: 90 });

    expect(await screen.findByRole('menuitem', { name: 'Run now' })).toHaveAttribute('data-disabled');
    expect(screen.queryByRole('menuitem', { name: 'Archive' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Archive draft' }));
    await waitFor(() => expect(onArchiveDraftAutomation).toHaveBeenCalledWith(staleDraft));
  });

  it('marks only the open draft, and not New automation, as the active entry', () => {
    const openDraft: AutomationSummary = {
      id: 'automation-2',
      name: 'Ad hoc competitor scan',
      scope: 'you',
      status: 'draft',
      updatedAt: '2026-07-28T11:00:00.000Z',
    };
    const otherDraft: AutomationSummary = {
      id: 'automation-3',
      name: 'A support escalation digest',
      scope: 'you',
      status: 'draft',
      updatedAt: '2026-08-02T11:00:00.000Z',
    };
    render(
      <MemoryRouter initialEntries={['/automations/new?draft=automation-2']}>
        <Tooltip.Provider>
          <Sidebar
            {...defaultActions}
            automations={[openDraft, otherDraft]}
            onSignOut={vi.fn()}
            workspace={workspace}
            workstreams={[]}
          />
        </Tooltip.Provider>
      </MemoryRouter>,
    );

    // Every draft row shares the builder's path and differs only in the query,
    // so nothing but the query can tell them apart.
    expect(screen.getByRole('link', { name: /Ad hoc competitor scan/u })).toHaveClass('is-active');
    expect(screen.getByRole('link', { name: /A support escalation digest/u })).not.toHaveClass('is-active');
    expect(screen.getByRole('link', { name: 'New automation' })).not.toHaveClass('is-active');
  });

  it('reports an archive that the server rejected instead of failing silently', async () => {
    const draft: AutomationSummary = {
      id: 'automation-4',
      name: 'Half-written monitor',
      scope: 'you',
      status: 'draft',
      updatedAt: '2026-08-02T11:00:00.000Z',
    };
    render(
      <MemoryRouter>
        <Tooltip.Provider>
          <Sidebar
            {...defaultActions}
            automations={[draft]}
            onArchiveDraftAutomation={vi.fn(async () => {
              throw new Error('The automation could not be reached.');
            })}
            onSignOut={vi.fn()}
            workspace={workspace}
            workstreams={[]}
          />
        </Tooltip.Provider>
      </MemoryRouter>,
    );

    fireEvent.contextMenu(screen.getByRole('link', { name: /Half-written monitor/u }), { clientX: 120, clientY: 90 });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Archive draft' }));

    const dialog = await screen.findByRole('dialog', { name: 'Draft could not be archived' });
    expect(within(dialog).getByText('The automation could not be reached.')).toBeVisible();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Draft could not be archived' })).not.toBeInTheDocument());
    // The row is still there, which is what the dialog said.
    expect(screen.getByRole('link', { name: /Half-written monitor/u })).toBeVisible();
  });

  it('deletes an automation only after the confirmation dialog', async () => {
    const onDeleteAutomation = vi.fn(async () => undefined);
    render(
      <MemoryRouter>
        <Tooltip.Provider>
          <Sidebar
            {...defaultActions}
            automations={[automation]}
            onDeleteAutomation={onDeleteAutomation}
            onSignOut={vi.fn()}
            workspace={workspace}
            workstreams={[]}
          />
        </Tooltip.Provider>
      </MemoryRouter>,
    );

    fireEvent.contextMenu(screen.getByRole('link', { name: /Daily product brief/u }), { clientX: 120, clientY: 90 });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete automation' }));

    const dialog = await screen.findByRole('dialog', { name: 'Delete automation' });
    expect(within(dialog).getByText('Daily product brief')).toBeVisible();
    expect(onDeleteAutomation).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Delete automation' })).not.toBeInTheDocument());
    expect(onDeleteAutomation).not.toHaveBeenCalled();

    fireEvent.contextMenu(screen.getByRole('link', { name: /Daily product brief/u }), { clientX: 120, clientY: 90 });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete automation' }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Delete automation' })).getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(onDeleteAutomation).toHaveBeenCalledWith(automation));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Delete automation' })).not.toBeInTheDocument());
  });

  it('opens meeting notes from the primary actions', async () => {
    const onOpenMeetingNotes = vi.fn(async () => undefined);
    render(
      <MemoryRouter>
        <Tooltip.Provider>
          <Sidebar
            {...defaultActions}
            automations={[]}
            onOpenMeetingNotes={onOpenMeetingNotes}
            onSignOut={vi.fn()}
            workspace={workspace}
            workstreams={[]}
          />
        </Tooltip.Provider>
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'New meeting/notes' }));
    await waitFor(() => expect(onOpenMeetingNotes).toHaveBeenCalledTimes(1));
  });

  it('sorts notes inline with work streams and opens them with a gray note marker', async () => {
    const onOpenMeetingNotes = vi.fn(async () => undefined);
    render(
      <MemoryRouter>
        <Tooltip.Provider>
          <Sidebar
            {...defaultActions}
            automations={[]}
            notes={[
              note('00000000-0000-4000-8000-000000000021', 'Customer interview', '2026-07-31T19:55:00.000Z'),
              {
                ...note('00000000-0000-4000-8000-000000000022', 'Shared research', '2026-07-31T19:45:00.000Z'),
                scope: 'workspace',
              },
            ]}
            onOpenMeetingNotes={onOpenMeetingNotes}
            onSignOut={vi.fn()}
            workspace={workspace}
            workstreams={[workstream('older', 'Older work stream', 'completed', 'ad_hoc', '2026-07-31T19:40:00.000Z')]}
          />
        </Tooltip.Provider>
      </MemoryRouter>,
    );

    expect([...document.querySelectorAll('.sidebar-row-title')].map((row) => row.textContent)).toEqual([
      'Customer interview',
      'Shared research',
      'Older work stream',
    ]);
    const noteLink = screen.getByRole('link', { name: /Customer interview/u });
    expect(noteLink).toHaveAttribute('href', '/notes/00000000-0000-4000-8000-000000000021');
    expect(within(noteLink).getByRole('img', { name: 'Note' })).toHaveClass('sidebar-note-marker');
    expect(within(noteLink).getByRole('img', { name: 'Private note' })).toHaveClass('sidebar-note-privacy');
    expect(within(screen.getByRole('link', { name: /Shared research/u })).queryByRole('img', { name: 'Private note' }))
      .not.toBeInTheDocument();
    fireEvent.click(noteLink);
    expect(onOpenMeetingNotes).not.toHaveBeenCalled();
  });

  it('archives a private note from its right-click menu and offers to publish it', async () => {
    const onArchiveNote = vi.fn(async () => undefined);
    const onChangeNoteScope = vi.fn(async () => undefined);
    const target = note('00000000-0000-4000-8000-000000000031', 'Customer interview', '2026-07-31T19:55:00.000Z');
    render(
      <MemoryRouter>
        <Tooltip.Provider>
          <Sidebar
            {...defaultActions}
            automations={[]}
            notes={[target]}
            onArchiveNote={onArchiveNote}
            onChangeNoteScope={onChangeNoteScope}
            onSignOut={vi.fn()}
            workspace={workspace}
            workstreams={[]}
          />
        </Tooltip.Provider>
      </MemoryRouter>,
    );

    fireEvent.contextMenu(screen.getByRole('link', { name: /Customer interview/u }), { clientX: 120, clientY: 90 });

    // A private note offers the state it would move to, never the one it is in.
    expect(await screen.findByRole('menuitem', { name: 'Make public to workspace' })).toBeVisible();
    expect(screen.queryByRole('menuitem', { name: 'Make private' })).not.toBeInTheDocument();
    const archive = screen.getByRole('menuitem', { name: 'Archive note' });
    expect(archive).toHaveClass('menu-item-danger');
    expect(archive).not.toHaveAttribute('data-disabled');
    expect(screen.getAllByRole('menuitem')).toHaveLength(2);

    fireEvent.click(screen.getByRole('menuitem', { name: 'Make public to workspace' }));
    await waitFor(() => expect(onChangeNoteScope).toHaveBeenCalledWith(target, 'workspace'));

    // Archiving is not reversible from any surface, so it confirms first and
    // names the note it would take away.
    fireEvent.contextMenu(screen.getByRole('link', { name: /Customer interview/u }), { clientX: 120, clientY: 90 });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Archive note' }));
    expect(onArchiveNote).not.toHaveBeenCalled();

    const confirm = await screen.findByRole('dialog', { name: 'Archive note' });
    expect(within(confirm).getByText('Customer interview')).toBeVisible();
    fireEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Archive note' })).not.toBeInTheDocument());
    expect(onArchiveNote).not.toHaveBeenCalled();

    fireEvent.contextMenu(screen.getByRole('link', { name: /Customer interview/u }), { clientX: 120, clientY: 90 });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Archive note' }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Archive note' })).getByRole('button', { name: 'Archive' }));
    await waitFor(() => expect(onArchiveNote).toHaveBeenCalledWith(target));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Archive note' })).not.toBeInTheDocument());
  });

  it('waits for a recording to end before it will archive the note', async () => {
    const onArchiveNote = vi.fn(async () => undefined);
    const onChangeNoteScope = vi.fn(async () => undefined);
    const target: NoteSummary = {
      ...note('00000000-0000-4000-8000-000000000036', 'Live standup', '2026-07-31T19:58:00.000Z'),
      recordingStatus: 'recording',
    };
    render(
      <MemoryRouter>
        <Tooltip.Provider>
          <Sidebar
            {...defaultActions}
            automations={[]}
            notes={[target]}
            onArchiveNote={onArchiveNote}
            onChangeNoteScope={onChangeNoteScope}
            onSignOut={vi.fn()}
            workspace={workspace}
            workstreams={[]}
          />
        </Tooltip.Provider>
      </MemoryRouter>,
    );

    fireEvent.contextMenu(screen.getByRole('link', { name: /Live standup/u }), { clientX: 120, clientY: 90 });

    // Archiving mid-recording would 404 the meeting window's next segment save
    // and quietly drop the rest of the transcript.
    const archive = await screen.findByRole('menuitem', { name: 'Archive note' });
    expect(archive).toHaveAttribute('data-disabled');
    fireEvent.click(archive);
    expect(onArchiveNote).not.toHaveBeenCalled();

    // The visibility of a note being recorded is still the owner's to change.
    const visibility = screen.getByRole('menuitem', { name: 'Make public to workspace' });
    expect(visibility).not.toHaveAttribute('data-disabled');
    fireEvent.click(visibility);
    await waitFor(() => expect(onChangeNoteScope).toHaveBeenCalledWith(target, 'workspace'));
  });

  it('offers a public note the way back to private', async () => {
    const onChangeNoteScope = vi.fn(async () => undefined);
    const target: NoteSummary = {
      ...note('00000000-0000-4000-8000-000000000034', 'Launch retro', '2026-07-31T19:35:00.000Z'),
      scope: 'workspace',
    };
    render(
      <MemoryRouter>
        <Tooltip.Provider>
          <Sidebar
            {...defaultActions}
            automations={[]}
            notes={[target]}
            onChangeNoteScope={onChangeNoteScope}
            onSignOut={vi.fn()}
            workspace={workspace}
            workstreams={[]}
          />
        </Tooltip.Provider>
      </MemoryRouter>,
    );

    fireEvent.contextMenu(screen.getByRole('link', { name: /Launch retro/u }), { clientX: 120, clientY: 90 });

    expect(await screen.findByRole('menuitem', { name: 'Make private' })).toBeVisible();
    expect(screen.queryByRole('menuitem', { name: 'Make public to workspace' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('menuitem', { name: 'Make private' }));
    await waitFor(() => expect(onChangeNoteScope).toHaveBeenCalledWith(target, 'personal'));
  });

  it('leaves both note actions disabled on a workspace note owned by someone else', async () => {
    const onArchiveNote = vi.fn(async () => undefined);
    const onChangeNoteScope = vi.fn(async () => undefined);
    render(
      <MemoryRouter>
        <Tooltip.Provider>
          <Sidebar
            {...defaultActions}
            automations={[]}
            notes={[{
              ...note('00000000-0000-4000-8000-000000000032', 'Shared research', '2026-07-31T19:45:00.000Z'),
              ownerUserId: 'user-2',
              scope: 'workspace',
            }]}
            onArchiveNote={onArchiveNote}
            onChangeNoteScope={onChangeNoteScope}
            onSignOut={vi.fn()}
            workspace={workspace}
            workstreams={[]}
          />
        </Tooltip.Provider>
      </MemoryRouter>,
    );

    fireEvent.contextMenu(screen.getByRole('link', { name: /Shared research/u }), { clientX: 120, clientY: 90 });

    const item = await screen.findByRole('menuitem', { name: 'Archive note' });
    expect(item).toHaveAttribute('data-disabled');
    expect(screen.getByRole('menuitem', { name: 'Make private' })).toHaveAttribute('data-disabled');
    fireEvent.click(item);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Make private' }));
    expect(onArchiveNote).not.toHaveBeenCalled();
    expect(onChangeNoteScope).not.toHaveBeenCalled();
  });

  it('reports a visibility change that the server rejected', async () => {
    render(
      <MemoryRouter>
        <Tooltip.Provider>
          <Sidebar
            {...defaultActions}
            automations={[]}
            notes={[note('00000000-0000-4000-8000-000000000035', 'Customer interview', '2026-07-31T19:55:00.000Z')]}
            onChangeNoteScope={vi.fn(async () => {
              throw new Error('The note could not be reached.');
            })}
            onSignOut={vi.fn()}
            workspace={workspace}
            workstreams={[]}
          />
        </Tooltip.Provider>
      </MemoryRouter>,
    );

    fireEvent.contextMenu(screen.getByRole('link', { name: /Customer interview/u }), { clientX: 120, clientY: 90 });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Make public to workspace' }));

    const dialog = await screen.findByRole('dialog', { name: 'Note visibility could not be changed' });
    expect(within(dialog).getByText('The note is still private. Try again in a moment.')).toBeVisible();
    expect(within(dialog).getByText('The note could not be reached.')).toBeVisible();
  });

  it('reports a note archive that the server rejected instead of failing silently', async () => {
    render(
      <MemoryRouter>
        <Tooltip.Provider>
          <Sidebar
            {...defaultActions}
            automations={[]}
            notes={[note('00000000-0000-4000-8000-000000000033', 'Customer interview', '2026-07-31T19:55:00.000Z')]}
            onArchiveNote={vi.fn(async () => {
              throw new Error('The note could not be reached.');
            })}
            onSignOut={vi.fn()}
            workspace={workspace}
            workstreams={[]}
          />
        </Tooltip.Provider>
      </MemoryRouter>,
    );

    fireEvent.contextMenu(screen.getByRole('link', { name: /Customer interview/u }), { clientX: 120, clientY: 90 });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Archive note' }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Archive note' })).getByRole('button', { name: 'Archive' }));

    const dialog = await screen.findByRole('dialog', { name: 'Note could not be archived' });
    expect(within(dialog).getByText('The note could not be reached.')).toBeVisible();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Note could not be archived' })).not.toBeInTheDocument());
    expect(screen.getByRole('link', { name: /Customer interview/u })).toBeVisible();
  });

  it('copies a work-stream link and the other resource identifiers only while debugging is enabled', async () => {
    // A real work-stream id, because the row copies a canonical link and
    // `workstreamCanonicalUrl` refuses anything that is not a UUID.
    const target = workstream('00000000-0000-4000-8000-000000000042', 'Quarterly planning', 'completed');
    render(
      <MemoryRouter>
        <Tooltip.Provider>
          <Sidebar
            {...defaultActions}
            automations={[automation]}
            notes={[note('00000000-0000-4000-8000-000000000037', 'Customer interview', '2026-07-31T19:55:00.000Z')]}
            onSignOut={vi.fn()}
            workspace={workspace}
            workstreams={[target]}
          />
        </Tooltip.Provider>
      </MemoryRouter>,
    );

    const workstreamRow = screen.getByRole('link', { name: /Quarterly planning/u });
    fireEvent.contextMenu(workstreamRow, { clientX: 120, clientY: 90 });
    expect(await screen.findByRole('menuitem', { name: 'Rename' })).toBeVisible();
    expect(screen.queryByRole('menuitem', { name: 'Copy work stream link' })).not.toBeInTheDocument();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });

    const noteRow = screen.getByRole('link', { name: /Customer interview/u });
    fireEvent.contextMenu(noteRow, { clientX: 120, clientY: 90 });
    expect(await screen.findByRole('menuitem', { name: 'Archive note' })).toBeVisible();
    expect(screen.queryByRole('menuitem', { name: 'Copy note id' })).not.toBeInTheDocument();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });

    // The Settings window owns the preference; the sidebar learns about a
    // change through the application-settings broadcast.
    announceApplicationSettings({ lockdownMode: false, lockdownAvailable: false, debugEnabled: true, developerSettingsAvailable: true, menuBarEnabled: true, menuBarAvailable: true, menuBarPresent: true, launchAtLogin: true, launchAtLoginAvailable: true });

    fireEvent.contextMenu(workstreamRow, { clientX: 120, clientY: 90 });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Copy work stream link' }));
    await waitFor(() => expect(copyText).toHaveBeenCalledWith(
      'https://with-avalon.com/app/workstreams/00000000-0000-4000-8000-000000000042',
    ));

    fireEvent.contextMenu(screen.getByRole('link', { name: /Daily product brief/u }), { clientX: 120, clientY: 90 });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Copy automation id' }));
    await waitFor(() => expect(copyText).toHaveBeenLastCalledWith('automation-1'));

    fireEvent.contextMenu(noteRow, { clientX: 120, clientY: 90 });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Copy note id' }));
    await waitFor(() => expect(copyText).toHaveBeenLastCalledWith('00000000-0000-4000-8000-000000000037'));
  });

  it('holds the visibility item while its own change is in flight', async () => {
    let release = (): void => undefined;
    const onChangeNoteScope = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const target = note('00000000-0000-4000-8000-000000000038', 'Customer interview', '2026-07-31T19:55:00.000Z');
    render(
      <MemoryRouter>
        <Tooltip.Provider>
          <Sidebar
            {...defaultActions}
            automations={[]}
            notes={[target]}
            onChangeNoteScope={onChangeNoteScope}
            onSignOut={vi.fn()}
            workspace={workspace}
            workstreams={[]}
          />
        </Tooltip.Provider>
      </MemoryRouter>,
    );

    // An open Radix menu hides the rest of the page from the accessibility
    // tree, so the row is held by reference rather than re-queried by role.
    const row = screen.getByRole('link', { name: /Customer interview/u });
    fireEvent.contextMenu(row, { clientX: 120, clientY: 90 });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Make public to workspace' }));
    await waitFor(() => expect(onChangeNoteScope).toHaveBeenCalledTimes(1));

    // Reopening the menu before the first PATCH lands must not fire a second
    // one: on a public→private change each one re-runs the privacy notices.
    fireEvent.contextMenu(row, { clientX: 120, clientY: 90 });
    const item = await screen.findByRole('menuitem', { name: 'Make public to workspace' });
    expect(item).toHaveAttribute('data-disabled');
    fireEvent.click(item);
    expect(onChangeNoteScope).toHaveBeenCalledTimes(1);

    await act(async () => {
      release();
      await Promise.resolve();
    });
    fireEvent.contextMenu(row, { clientX: 120, clientY: 90 });
    await waitFor(() => expect(screen.getByRole('menuitem', { name: 'Make public to workspace' }))
      .not.toHaveAttribute('data-disabled'));
  });

  it('marks work streams unread on the server and renames from the menu', async () => {
    const onMarkWorkstreamUnread = vi.fn(async () => undefined);
    const onRenameWorkstream = vi.fn(async () => undefined);
    const target = workstream('rename-me', 'Quarterly planning', 'completed');
    render(
      <MemoryRouter>
        <Tooltip.Provider>
          <Sidebar
            {...defaultActions}
            automations={[]}
            onMarkWorkstreamUnread={onMarkWorkstreamUnread}
            onRenameWorkstream={onRenameWorkstream}
            onSignOut={vi.fn()}
            workspace={workspace}
            workstreams={[target]}
          />
        </Tooltip.Provider>
      </MemoryRouter>,
    );

    const row = screen.getByRole('link', { name: /Quarterly planning/u });
    fireEvent.contextMenu(row, { clientX: 120, clientY: 90 });

    expect(await screen.findByRole('menuitem', { name: 'Pin' })).toBeVisible();
    expect(screen.getByRole('menuitem', { name: 'Archive' })).toHaveClass('menu-item-danger');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Mark as unread' }));
    await waitFor(() => expect(onMarkWorkstreamUnread).toHaveBeenCalledWith(target));

    fireEvent.contextMenu(row, { clientX: 120, clientY: 90 });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Rename' }));
    const input = await screen.findByRole('textbox', { name: 'Work stream name' });
    fireEvent.change(input, { target: { value: 'Launch planning' } });
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));

    await waitFor(() => expect(onRenameWorkstream).toHaveBeenCalledWith(target, 'Launch planning'));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Rename work stream' })).not.toBeInTheDocument());
  });
});

describe('private work streams', () => {
  beforeEach(() => {
    window.localStorage.clear();
    useUiStore.setState({ sidebarOpen: false, sidebarWidth: 300 });
    vi.stubGlobal('ResizeObserver', class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  function renderWith(
    streams: WorkstreamSummary[],
    onChangeWorkstreamScope?: (workstream: WorkstreamSummary, scope: 'personal' | 'workspace') => Promise<void>,
  ): void {
    render(
      <MemoryRouter>
        <Tooltip.Provider>
          <Sidebar
            {...defaultActions}
            automations={[]}
            {...(onChangeWorkstreamScope ? { onChangeWorkstreamScope } : {})}
            onSignOut={vi.fn()}
            workspace={workspace}
            workstreams={streams}
          />
        </Tooltip.Provider>
      </MemoryRouter>,
    );
  }

  it('wears the same marker a private note does', () => {
    renderWith([{
      ...workstream('00000000-4000-4000-8000-000000000021', 'Digest · Adam', 'completed'),
      scope: 'personal',
      systemKind: 'digest',
    }]);

    // One badge for "only you can see this", whatever kind of thing it is on.
    expect(screen.getByLabelText('Private work stream')).toBeInTheDocument();
  });

  it('leaves an ordinary work stream unmarked', () => {
    renderWith([workstream('00000000-4000-4000-8000-000000000022', 'Launch', 'completed')]);

    expect(screen.queryByLabelText('Private work stream')).not.toBeInTheDocument();
  });

  it('closes a work stream to the people in it from the right-click menu', async () => {
    const onChangeWorkstreamScope = vi.fn(async (): Promise<void> => undefined);
    renderWith(
      [workstream('00000000-4000-4000-8000-000000000023', 'Launch', 'completed')],
      onChangeWorkstreamScope,
    );

    fireEvent.contextMenu(screen.getByRole('link', { name: /Launch/u }), { clientX: 120, clientY: 90 });
    // Named for the state it moves to, the way the note item is.
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Make private' }));

    expect(onChangeWorkstreamScope).toHaveBeenCalledWith(
      expect.objectContaining({ id: '00000000-4000-4000-8000-000000000023' }),
      'personal',
    );
  });

  it('opens a private work stream back up to the workspace', async () => {
    const onChangeWorkstreamScope = vi.fn(async (): Promise<void> => undefined);
    renderWith(
      [{
        ...workstream('00000000-4000-4000-8000-000000000024', 'Comp review', 'completed'),
        scope: 'personal',
      }],
      onChangeWorkstreamScope,
    );

    fireEvent.contextMenu(screen.getByRole('link', { name: /Comp review/u }), { clientX: 120, clientY: 90 });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Make public to workspace' }));

    expect(onChangeWorkstreamScope).toHaveBeenCalledWith(
      expect.objectContaining({ id: '00000000-4000-4000-8000-000000000024' }),
      'workspace',
    );
  });

  // Both of these take their audience from something other than this column, so
  // the menu does not offer a change that would not happen.
  it('does not offer the toggle on a work stream an automation generated', async () => {
    renderWith([{
      ...workstream('00000000-4000-4000-8000-000000000025', 'Daily brief', 'completed', 'automation'),
      automationSubscriptionId: '00000000-4000-4000-8000-000000000026',
    }]);

    fireEvent.contextMenu(screen.getByRole('link', { name: /Daily brief/u }), { clientX: 120, clientY: 90 });

    expect(await screen.findByRole('menuitem', { name: 'Rename' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Make private' })).not.toBeInTheDocument();
  });

  it('does not offer the toggle on a work stream that belongs to Avalon itself', async () => {
    renderWith([{
      ...workstream('00000000-4000-4000-8000-000000000027', 'Digest · Adam', 'completed'),
      scope: 'personal',
      systemKind: 'digest',
    }]);

    fireEvent.contextMenu(screen.getByRole('link', { name: /Digest/u }), { clientX: 120, clientY: 90 });

    expect(await screen.findByRole('menuitem', { name: 'Rename' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Make public to workspace' })).not.toBeInTheDocument();
  });

  it('reports a visibility change the server rejected instead of failing silently', async () => {
    renderWith(
      [workstream('00000000-4000-4000-8000-000000000028', 'Launch', 'completed')],
      vi.fn(async () => {
        throw new Error('The work stream could not be reached.');
      }),
    );

    fireEvent.contextMenu(screen.getByRole('link', { name: /Launch/u }), { clientX: 120, clientY: 90 });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Make private' }));

    const dialog = await screen.findByRole('dialog', { name: 'Work stream visibility could not be changed' });
    expect(within(dialog).getByText('The work stream is still visible to the workspace. Try again in a moment.'))
      .toBeVisible();
    expect(within(dialog).getByText('The work stream could not be reached.')).toBeVisible();
  });
});

describe('pinned work streams', () => {
  beforeEach(() => {
    window.localStorage.clear();
    useUiStore.setState({ sidebarOpen: false, sidebarWidth: 300 });
    vi.stubGlobal('ResizeObserver', class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  function renderWith(
    streams: WorkstreamSummary[],
    actions: Partial<{
      onPinWorkstream: (workstream: WorkstreamSummary, pinned: boolean) => Promise<void>;
      onReorderPinnedWorkstreams: (workstreamIds: string[]) => Promise<void>;
    }> = {},
  ): void {
    render(
      <MemoryRouter>
        <Tooltip.Provider>
          <Sidebar
            {...defaultActions}
            {...actions}
            automations={[]}
            onSignOut={vi.fn()}
            workspace={workspace}
            workstreams={streams}
          />
        </Tooltip.Provider>
      </MemoryRouter>,
    );
  }

  /** The pinned section's rows, in the order they are rendered. */
  function pinnedRowTitles(): string[] {
    const section = screen.getByRole('region', { name: 'Pinned' });
    return within(section).getAllByRole('link').map((row) => row.textContent ?? '');
  }

  /** The `sidebar-context-target` wrapper that carries a row's drag handlers. */
  function dragTarget(name: RegExp): HTMLElement {
    const wrapper = screen.getByRole('link', { name }).parentElement;
    if (!wrapper) throw new Error('The work-stream row has no drag wrapper');
    return wrapper;
  }

  /**
   * jsdom implements no `DataTransfer`. `dropEffect` is the field that matters:
   * a drag the pinned list accepted reports `move` back on `dragend`, and one
   * cancelled with Escape or released off the list reports `none`.
   */
  function dataTransfer(dropEffect: 'move' | 'none' = 'move'): {
    dropEffect: string;
    effectAllowed: string;
    setData: () => void;
  } {
    return { dropEffect, effectAllowed: '', setData: () => undefined };
  }

  it('lifts a pinned work stream out of the recent list into its own section', () => {
    renderWith([
      pinned(workstream('ws-pinned', 'Launch tracking', 'completed'), 0),
      workstream('ws-recent', 'Quarterly planning', 'completed'),
    ]);

    const section = screen.getByRole('region', { name: 'Pinned' });
    expect(within(section).getByRole('link', { name: /Launch tracking/u })).toBeVisible();
    // Once, not twice: the recent list keeps only what is not pinned.
    expect(screen.getAllByRole('link', { name: /Launch tracking/u })).toHaveLength(1);
    expect(within(section).queryByRole('link', { name: /Quarterly planning/u })).not.toBeInTheDocument();
  });

  it('shows no Pinned section until something is pinned', () => {
    renderWith([workstream('ws-recent', 'Quarterly planning', 'completed')]);

    expect(screen.queryByRole('region', { name: 'Pinned' })).not.toBeInTheDocument();
  });

  it('renders pinned rows in their stored order rather than by activity', () => {
    renderWith([
      pinned(workstream('ws-a', 'Alpha', 'completed', 'ad_hoc', '2026-07-31T20:00:00.000Z'), 1),
      pinned(workstream('ws-b', 'Bravo', 'completed', 'ad_hoc', '2026-07-20T20:00:00.000Z'), 0),
    ]);

    expect(pinnedRowTitles()).toEqual([expect.stringContaining('Bravo'), expect.stringContaining('Alpha')]);
  });

  it('offers Pin on a recent row and Unpin on a pinned one', async () => {
    const onPinWorkstream = vi.fn(async (): Promise<void> => undefined);
    renderWith(
      [
        pinned(workstream('ws-pinned', 'Launch tracking', 'completed'), 0),
        workstream('ws-recent', 'Quarterly planning', 'completed'),
      ],
      { onPinWorkstream },
    );

    fireEvent.contextMenu(screen.getByRole('link', { name: /Quarterly planning/u }), { clientX: 120, clientY: 90 });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Pin' }));
    await waitFor(() => expect(onPinWorkstream)
      .toHaveBeenCalledWith(expect.objectContaining({ id: 'ws-recent' }), true));

    fireEvent.contextMenu(screen.getByRole('link', { name: /Launch tracking/u }), { clientX: 120, clientY: 90 });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Unpin' }));
    await waitFor(() => expect(onPinWorkstream)
      .toHaveBeenCalledWith(expect.objectContaining({ id: 'ws-pinned' }), false));
  });

  it('reorders under the pointer during a drag and sends the whole arrangement on drop', async () => {
    const onReorderPinnedWorkstreams = vi.fn(async (): Promise<void> => undefined);
    renderWith(
      [
        pinned(workstream('ws-a', 'Alpha', 'completed'), 0),
        pinned(workstream('ws-b', 'Bravo', 'completed'), 1),
        pinned(workstream('ws-c', 'Charlie', 'completed'), 2),
      ],
      { onReorderPinnedWorkstreams },
    );

    fireEvent.dragStart(dragTarget(/Charlie/u), { dataTransfer: dataTransfer() });
    fireEvent.dragOver(dragTarget(/Alpha/u), { dataTransfer: dataTransfer() });

    // The list settles before anything is sent, so the drop lands where the
    // pointer is rather than where the server last agreed it was.
    expect(pinnedRowTitles()).toEqual([
      expect.stringContaining('Charlie'),
      expect.stringContaining('Alpha'),
      expect.stringContaining('Bravo'),
    ]);

    fireEvent.dragEnd(dragTarget(/Charlie/u), { dataTransfer: dataTransfer('move') });
    await waitFor(() => expect(onReorderPinnedWorkstreams).toHaveBeenCalledWith(['ws-c', 'ws-a', 'ws-b']));
  });

  it('sends nothing when a drag ends where it started', () => {
    const onReorderPinnedWorkstreams = vi.fn(async (): Promise<void> => undefined);
    renderWith(
      [
        pinned(workstream('ws-a', 'Alpha', 'completed'), 0),
        pinned(workstream('ws-b', 'Bravo', 'completed'), 1),
      ],
      { onReorderPinnedWorkstreams },
    );

    fireEvent.dragStart(dragTarget(/Alpha/u), { dataTransfer: dataTransfer() });
    fireEvent.dragEnd(dragTarget(/Alpha/u), { dataTransfer: dataTransfer('move') });

    expect(onReorderPinnedWorkstreams).not.toHaveBeenCalled();
  });

  // Backing out of a drag has to mean backing out of it. The rows have already
  // moved under the pointer by then, so treating the release the same way a
  // drop is treated would make Escape the slowest possible way to reorder.
  it('abandons the arrangement when a drag is cancelled rather than dropped', async () => {
    const onReorderPinnedWorkstreams = vi.fn(async (): Promise<void> => undefined);
    renderWith(
      [
        pinned(workstream('ws-a', 'Alpha', 'completed'), 0),
        pinned(workstream('ws-b', 'Bravo', 'completed'), 1),
      ],
      { onReorderPinnedWorkstreams },
    );

    fireEvent.dragStart(dragTarget(/Bravo/u), { dataTransfer: dataTransfer() });
    fireEvent.dragOver(dragTarget(/Alpha/u), { dataTransfer: dataTransfer() });
    expect(pinnedRowTitles()).toEqual([expect.stringContaining('Bravo'), expect.stringContaining('Alpha')]);

    // Escape, or a release anywhere nothing accepted the drop.
    fireEvent.dragEnd(dragTarget(/Bravo/u), { dataTransfer: dataTransfer('none') });

    expect(onReorderPinnedWorkstreams).not.toHaveBeenCalled();
    await waitFor(() => expect(pinnedRowTitles())
      .toEqual([expect.stringContaining('Alpha'), expect.stringContaining('Bravo')]));
  });

  it('moves a pinned row with the keyboard, so the order is not pointer-only', async () => {
    const onReorderPinnedWorkstreams = vi.fn(async (): Promise<void> => undefined);
    renderWith(
      [
        pinned(workstream('ws-a', 'Alpha', 'completed'), 0),
        pinned(workstream('ws-b', 'Bravo', 'completed'), 1),
      ],
      { onReorderPinnedWorkstreams },
    );

    // Fired on the row itself, which is what holds focus: the handler sits on
    // the wrapper around it and only ever sees the event by bubbling.
    fireEvent.keyDown(screen.getByRole('link', { name: /Bravo/u }), { key: 'ArrowUp', altKey: true });
    await waitFor(() => expect(onReorderPinnedWorkstreams).toHaveBeenCalledWith(['ws-b', 'ws-a']));

    // The top row has nowhere further to go, and saying so costs a request.
    onReorderPinnedWorkstreams.mockClear();
    fireEvent.keyDown(screen.getByRole('link', { name: /Alpha/u }), { key: 'ArrowUp', altKey: true });
    expect(onReorderPinnedWorkstreams).not.toHaveBeenCalled();
  });

  // Two moves in a row overlap, because the first request is still in flight
  // when the second is made. Whichever lands first must not put the list back
  // to an order the reader has already moved past.
  it('holds the newer arrangement when an older reorder finishes underneath it', async () => {
    const settle: (() => void)[] = [];
    const onReorderPinnedWorkstreams = vi.fn(
      () => new Promise<void>((resolve) => settle.push(resolve)),
    );
    renderWith(
      [
        pinned(workstream('ws-a', 'Alpha', 'completed'), 0),
        pinned(workstream('ws-b', 'Bravo', 'completed'), 1),
        pinned(workstream('ws-c', 'Charlie', 'completed'), 2),
      ],
      { onReorderPinnedWorkstreams },
    );

    fireEvent.keyDown(screen.getByRole('link', { name: /Charlie/u }), { key: 'ArrowUp', altKey: true });
    fireEvent.keyDown(screen.getByRole('link', { name: /Charlie/u }), { key: 'ArrowUp', altKey: true });
    expect(onReorderPinnedWorkstreams).toHaveBeenNthCalledWith(1, ['ws-a', 'ws-c', 'ws-b']);
    expect(onReorderPinnedWorkstreams).toHaveBeenNthCalledWith(2, ['ws-c', 'ws-a', 'ws-b']);

    await act(async () => {
      settle[0]?.();
    });

    // Not [Alpha, Bravo, Charlie], which is what the unchanged props still say.
    expect(pinnedRowTitles()).toEqual([
      expect.stringContaining('Charlie'),
      expect.stringContaining('Alpha'),
      expect.stringContaining('Bravo'),
    ]);

    await act(async () => {
      settle[1]?.();
    });
  });

  // A release over the heading is a release inside the list the reader is
  // arranging. Leaving it uncovered would read as a cancellation and throw the
  // arrangement away a few pixels above the first row.
  it('accepts a drop anywhere in the section, heading included', () => {
    const onReorderPinnedWorkstreams = vi.fn(async (): Promise<void> => undefined);
    renderWith(
      [
        pinned(workstream('ws-a', 'Alpha', 'completed'), 0),
        pinned(workstream('ws-b', 'Bravo', 'completed'), 1),
      ],
      { onReorderPinnedWorkstreams },
    );

    const heading = screen.getByRole('heading', { name: 'Pinned' });
    const transfer = dataTransfer('none');
    fireEvent.dragOver(heading, { dataTransfer: transfer });

    // The section handled it, so a release here reports a move rather than the
    // `none` that `dragend` reads as a drag backed out of.
    expect(transfer.dropEffect).toBe('move');
  });

  it('says how to reorder once for the section, not on every row', () => {
    renderWith([
      pinned(workstream('ws-a', 'Alpha', 'completed'), 0),
      pinned(workstream('ws-b', 'Bravo', 'completed'), 1),
    ]);

    // The instruction is one element the section points at. On the rows it
    // would land inside each link's accessible name and be read out again
    // before every title.
    expect(screen.getAllByText(/Hold Alt and press the up or down arrow/u)).toHaveLength(1);
    expect(screen.getByRole('region', { name: 'Pinned' }))
      .toHaveAccessibleDescription(/Hold Alt and press the up or down arrow/u);
    expect(screen.getByRole('link', { name: /Alpha/u })).toHaveAccessibleName(/Pinned, 1 of 2\.$/u);
  });

  it('leaves a recent row undraggable, since its order is activity and not a choice', () => {
    renderWith([workstream('ws-recent', 'Quarterly planning', 'completed')]);

    expect(dragTarget(/Quarterly planning/u)).not.toHaveAttribute('draggable', 'true');
  });

  it('reports a rejected reorder and falls back to the order the server holds', async () => {
    renderWith(
      [
        pinned(workstream('ws-a', 'Alpha', 'completed'), 0),
        pinned(workstream('ws-b', 'Bravo', 'completed'), 1),
      ],
      {
        onReorderPinnedWorkstreams: vi.fn(async () => {
          throw new Error('The pinned list could not be reached.');
        }),
      },
    );

    // Fired on the row itself, which is what holds focus: the handler sits on
    // the wrapper around it and only ever sees the event by bubbling.
    fireEvent.keyDown(screen.getByRole('link', { name: /Bravo/u }), { key: 'ArrowUp', altKey: true });

    const dialog = await screen.findByRole('dialog', { name: 'Pinned work streams could not be reordered' });
    expect(within(dialog).getByText('The pinned list is back in the order it was in. Try again in a moment.'))
      .toBeVisible();
    // The open dialog hides the sidebar from the accessibility tree, so the
    // order can only be read once it is dismissed.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(pinnedRowTitles()).toEqual([expect.stringContaining('Alpha'), expect.stringContaining('Bravo')]);
  });

  it('reports a pin the server refused', async () => {
    renderWith(
      [workstream('ws-recent', 'Quarterly planning', 'completed')],
      {
        onPinWorkstream: vi.fn(async () => {
          throw new Error('The work stream could not be reached.');
        }),
      },
    );

    fireEvent.contextMenu(screen.getByRole('link', { name: /Quarterly planning/u }), { clientX: 120, clientY: 90 });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Pin' }));

    const dialog = await screen.findByRole('dialog', { name: 'Work stream could not be pinned' });
    expect(within(dialog).getByText('The work stream could not be reached.')).toBeVisible();
  });
});
