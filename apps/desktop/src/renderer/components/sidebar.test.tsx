import { fireEvent, render, screen, within } from '@testing-library/react';
import * as Tooltip from '@radix-ui/react-tooltip';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { Workspace, WorkstreamSummary } from '../lib/types';
import { Sidebar } from './sidebar';

const workspace: Workspace = {
  id: 'workspace-1',
  name: 'Avalon Studio',
  region: 'global',
  timezone: 'America/Los_Angeles',
  currentUser: { id: 'user-1', name: 'Adam', email: 'adam@example.com', timezone: 'America/Los_Angeles' },
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
    lastActivityAt,
  };
}

describe('Sidebar work-stream markers', () => {
  it('anchors a local-only onboarding checklist above the account footer', () => {
    render(
      <MemoryRouter>
        <Tooltip.Provider>
          <Sidebar automations={[]} onSignOut={vi.fn()} workspace={workspace} workstreams={[]} />
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

  it('uses the compact status-dot pattern and an origin glyph for completed automation work', () => {
    render(
      <MemoryRouter initialEntries={['/workstreams/input']}>
        <Tooltip.Provider>
          <Sidebar
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
    expect(screen.getByRole('link', { name: /PostHog follow-up/u }).querySelector('.sidebar-automation-marker')).not.toBeNull();
    expect(screen.getByRole('img', { name: 'Automation-generated, latest run completed' })).toBeInTheDocument();
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
});
