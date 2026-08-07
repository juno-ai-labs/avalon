import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import * as Tooltip from '@radix-ui/react-tooltip';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AutomationSummary, NoteSummary, Workspace, WorkstreamSummary } from '../lib/types';
import { useUiStore } from '../lib/ui-store';
import { Sidebar } from './sidebar';

const workspace: Workspace = {
  id: 'workspace-1',
  name: 'Avalon Studio',
  region: 'global',
  timezone: 'America/Los_Angeles',
  logAgentInference: false,
  currentUser: { id: 'user-1', name: 'Adam', email: 'adam@example.com', timezone: 'America/Los_Angeles' },
};

const defaultActions = {
  onMarkWorkstreamUnread: async (): Promise<void> => undefined,
  onOpenMeetingNotes: async (): Promise<void> => undefined,
  onRenameWorkstream: async (): Promise<void> => undefined,
  onRunAutomation: async (): Promise<void> => undefined,
};

const automation: AutomationSummary = {
  id: 'automation-1',
  name: 'Daily product brief',
  scope: 'you',
  status: 'active',
  nextRunAt: '2026-08-01T16:00:00.000Z',
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
    origin,
    harnessStatus,
    latestAttentionSequenceNumber: 0,
    readThroughSequenceNumber: 0,
    manualUnreadFromSequenceNumber: null,
    manualUnreadGeneration: 0,
    hasUnread: false,
    firstUnreadSequenceNumber: null,
    lastActivityAt,
  };
}

function note(id: string, title: string, lastActivityAt: string): NoteSummary {
  return {
    id,
    workspaceId: '00000000-0000-4000-8000-000000000010',
    resourceId: '00000000-0000-4000-8000-000000000011',
    ownerUserId: '00000000-0000-4000-8000-000000000012',
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

  it('anchors a local-only onboarding checklist above the account footer', () => {
    render(
      <MemoryRouter>
        <Tooltip.Provider>
          <Sidebar {...defaultActions} automations={[]} onSignOut={vi.fn()} workspace={workspace} workstreams={[]} />
        </Tooltip.Provider>
      </MemoryRouter>,
    );

    const sidebar = screen.getByRole('complementary', { name: 'Avalon navigation' });
    const onboarding = within(sidebar).getByRole('region', { name: 'Get started with Avalon' });
    const account = within(sidebar).getByRole('button', { name: /AdamAvalon Studio/u });
    expect(onboarding.compareDocumentPosition(account) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(onboarding).getByText('0 / 3')).toBeVisible();

    fireEvent.click(within(onboarding).getByRole('button', { name: /Connect your tools/u }));

    expect(within(onboarding).getByText('1 / 3')).toBeVisible();
    expect(within(onboarding).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '1');
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
                workstream('day-running', 'Recently running', 'running', 'ad_hoc', '2026-07-31T08:00:00.000Z'),
                workstream('hour-complete', 'Just completed', 'completed', 'ad_hoc', '2026-07-31T19:50:00.000Z'),
              ]}
            />
          </Tooltip.Provider>
        </MemoryRouter>,
      );

      expect(screen.getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent)).toEqual([
        'Last hour',
        'Last day',
        'The rest',
      ]);
      expect(screen.queryByRole('heading', { name: 'Work streams' })).not.toBeInTheDocument();
      expect([...document.querySelectorAll('.workstream-row .sidebar-row-title')].map((row) => row.textContent)).toEqual([
        'Just completed',
        'Recently running',
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
    expect(screen.getByRole('menuitem', { name: 'Archive' })).toHaveClass('menu-item-danger');
    expect(screen.queryByText(/^[PTRADU]$/u)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('menuitem', { name: 'Run now' }));
    await waitFor(() => expect(onRunAutomation).toHaveBeenCalledWith(automation));
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
    const noteButton = screen.getByRole('button', { name: /Customer interview/u });
    expect(within(noteButton).getByRole('img', { name: 'Note' })).toHaveClass('sidebar-note-marker');
    expect(within(noteButton).getByRole('img', { name: 'Private note' })).toHaveClass('sidebar-note-privacy');
    expect(within(screen.getByRole('button', { name: /Shared research/u })).queryByRole('img', { name: 'Private note' }))
      .not.toBeInTheDocument();
    fireEvent.click(noteButton);
    await waitFor(() => expect(onOpenMeetingNotes).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000021'));
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
