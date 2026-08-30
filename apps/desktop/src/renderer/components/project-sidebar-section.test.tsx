import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import * as Tooltip from '@radix-ui/react-tooltip';
import { useState } from 'react';
import { MemoryRouter, NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import {
  PROJECT_COLOR_KEYS,
  PROJECT_ICON_KEYS,
  ProjectSummarySchema,
  type ProjectSummary,
} from '@rally/contracts';

import { ProjectSidebarSection } from './project-sidebar-section';
import type { WorkstreamSummary } from '../lib/types';

function project(id: string, name: string, scope: 'personal' | 'workspace' = 'personal'): ProjectSummary {
  return ProjectSummarySchema.parse({
    id,
    name,
    iconKey: 'briefcase',
    colorKey: 'blue',
    scope,
    status: 'active',
    presentationRevision: 1,
    audienceGeneration: 1,
    lifecycleGeneration: 1,
    participants: [{ userId: '00000000-0000-7000-8000-0000000000f1', state: 'active', generation: 1 }],
    createdAt: '2026-08-27T00:00:00.000Z',
    updatedAt: '2026-08-27T00:00:00.000Z',
  });
}

const hiring = project('00000000-0000-7000-8000-0000000000f2', 'Hiring');

function Location(): React.JSX.Element {
  return <output data-testid="location">{useLocation().pathname}</output>;
}

function renderSection(props: Partial<React.ComponentProps<typeof ProjectSidebarSection>> = {}) {
  return render(
    <Tooltip.Provider>
      <MemoryRouter initialEntries={['/workstreams/new']}>
        <ProjectSidebarSection
          inactiveProjects={[]}
          loading={false}
          onAddWorkstream={async () => undefined}
          onCreate={async () => hiring}
          onReorder={async () => undefined}
          onRestore={async () => undefined}
          projects={[hiring]}
          renderWorkstream={(workstream) => (
            <NavLink to={`/workstreams/${workstream.id}`}>{workstream.title}{workstream.preview ?? ''}</NavLink>
          )}
          workstreams={[]}
          {...props}
        />
        <Routes><Route element={<Location />} path="*" /></Routes>
      </MemoryRouter>
    </Tooltip.Provider>,
  );
}

function CreateFlowHarness({
  onCreate,
}: {
  onCreate: React.ComponentProps<typeof ProjectSidebarSection>['onCreate'];
}): React.JSX.Element {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  return (
    <>
      <ProjectSidebarSection
        inactiveProjects={[]}
        loading={false}
        onAddWorkstream={async () => undefined}
        onCreate={async (input) => {
          const created = await onCreate(input);
          setProjects((current) => [...current, created]);
          return created;
        }}
        onReorder={async () => undefined}
        onRestore={async () => undefined}
        projects={projects}
        renderWorkstream={(workstream) => (
          <NavLink to={`/workstreams/${workstream.id}`}>{workstream.title}</NavLink>
        )}
        workstreams={[]}
      />
      <Location />
    </>
  );
}

describe('the Projects sidebar section', () => {
  it('given one project, when its row opens the dashboard and is clicked again, then the selected row closes its accordion', () => {
    renderSection();

    fireEvent.click(screen.getByRole('link', { name: /Hiring/u }));
    expect(screen.getByTestId('location')).toHaveTextContent(`/projects/${hiring.id}`);
    expect(screen.getByRole('button', { name: 'Collapse Hiring' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('No work streams')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('link', { name: /Hiring/u }));
    expect(screen.getByTestId('location')).toHaveTextContent(`/projects/${hiring.id}`);
    expect(screen.getByRole('button', { name: 'Expand Hiring' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('No work streams')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'New work stream in Hiring' }));
    expect(screen.getByTestId('location')).toHaveTextContent(`/projects/${hiring.id}/workstreams/new`);
  });

  it('given the new-project dialog, when choices are inspected, then gray is selected by default and all choices are named', () => {
    renderSection({ projects: [] });
    fireEvent.click(screen.getByRole('button', { name: 'New project' }));
    const dialog = screen.getByRole('dialog', { name: 'New project' });
    for (const icon of PROJECT_ICON_KEYS) {
      const name = icon.split('-').map((part) => `${part[0]!.toUpperCase()}${part.slice(1)}`).join(' ');
      expect(within(dialog).getByRole('button', { name })).toBeInTheDocument();
    }
    for (const color of PROJECT_COLOR_KEYS) {
      const name = `${color[0]!.toUpperCase()}${color.slice(1)}`;
      expect(within(dialog).getByRole('button', { name })).toBeInTheDocument();
    }
    expect(within(dialog).getByRole('button', { name: 'Gray' })).toHaveAttribute('aria-pressed', 'true');
    for (const icon of PROJECT_ICON_KEYS) {
      const name = icon.split('-').map((part) => `${part[0]!.toUpperCase()}${part.slice(1)}`).join(' ');
      expect(within(dialog).getByRole('button', { name }).querySelector('svg'))
        .toHaveAttribute('stroke', 'var(--av-sys-color-project-gray)');
    }
    fireEvent.click(within(dialog).getByRole('button', { name: 'Red' }));
    for (const icon of PROJECT_ICON_KEYS) {
      const name = icon.split('-').map((part) => `${part[0]!.toUpperCase()}${part.slice(1)}`).join(' ');
      expect(within(dialog).getByRole('button', { name }).querySelector('svg'))
        .toHaveAttribute('stroke', 'var(--av-sys-color-project-red)');
    }

    const scope = within(dialog).getByRole('combobox', { name: 'Project scope' });
    expect(scope).toHaveClass('dropdown-select-trigger-primary');
    fireEvent.click(scope);
    expect(screen.getByRole('option', { name: 'Project participants' })).toBeVisible();
    // 30s rather than the suite's 15s `testTimeout`. Naming every choice means
    // about ninety accessible-name lookups over the open dialog — bounded and
    // deterministic, but by far the most expensive test in this file (1.6s here
    // against 20-400ms for its siblings), and on a CPU-loaded machine it is the
    // one that overruns. Measured at 10x oversubscription on 4 cores: 20s, and
    // the only failure in the file. There is no `waitFor` here to widen; the
    // wall clock is the whole budget.
  }, 30_000);

  it('given project creation is pending, when it succeeds, then the dialog waits before opening and selecting the project', async () => {
    const created = project('00000000-0000-7000-8000-0000000000f5', 'Planning');
    let finishCreate!: (project: ProjectSummary) => void;
    const onCreate = vi.fn(() => new Promise<ProjectSummary>((resolve) => { finishCreate = resolve; }));
    render(
      <Tooltip.Provider>
        <MemoryRouter initialEntries={['/workstreams/new']}>
          <CreateFlowHarness onCreate={onCreate} />
        </MemoryRouter>
      </Tooltip.Provider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'New project' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'Planning' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create project' }));

    expect(onCreate).toHaveBeenCalledWith({
      colorKey: 'gray',
      iconKey: 'briefcase',
      name: 'Planning',
      scope: 'personal',
    });
    expect(screen.getByTestId('location')).toHaveTextContent('/workstreams/new');
    expect(screen.getByRole('button', { name: 'Create project' })).toBeDisabled();

    await act(async () => { finishCreate(created); });

    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent(`/projects/${created.id}`));
    expect(screen.getByRole('link', { name: /Planning/u })).toHaveClass('is-active');
    expect(screen.getByRole('button', { name: 'Collapse Planning' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.queryByRole('dialog', { name: 'New project' })).not.toBeInTheDocument();
  });

  it('given the color grid, when a color receives focus, then its name appears in the standard tooltip', async () => {
    renderSection({ projects: [] });
    fireEvent.click(screen.getByRole('button', { name: 'New project' }));

    fireEvent.focus(screen.getByRole('button', { name: 'Blue' }));

    await waitFor(() => expect(screen.getByRole('tooltip')).toHaveClass('tooltip'));
    expect(screen.getByRole('tooltip')).toHaveTextContent('Blue');
  });

  it('given a customized new-project form, when it is cancelled and reopened, then it starts from gray again', () => {
    renderSection({ projects: [] });
    fireEvent.click(screen.getByRole('button', { name: 'New project' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'Temporary' } });
    fireEvent.click(screen.getByRole('button', { name: 'Red' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    fireEvent.click(screen.getByRole('button', { name: 'New project' }));
    const reopened = screen.getByRole('dialog', { name: 'New project' });
    expect(within(reopened).getByRole('button', { name: 'Gray' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(reopened).getByRole('textbox', { name: 'Name' })).toHaveValue('');
  });

  it('given a failed restore, when recovery is closed and project creation opens, then the restore error stays out of the new-project form', async () => {
    const onRestore = vi.fn(async () => { throw new Error('Resolve the project conflict'); });
    renderSection({ inactiveProjects: [{ ...hiring, status: 'archived' }], onRestore, projects: [] });
    fireEvent.click(screen.getByRole('button', { name: 'New project' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'Temporary' } });
    fireEvent.click(screen.getByRole('button', { name: 'Red' }));
    fireEvent.click(screen.getByRole('button', { name: 'Restore archived project' }));
    fireEvent.click(screen.getByRole('button', { name: /Hiring/u }));
    await screen.findByText('Resolve the project conflict');

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'New project' }));

    expect(screen.queryByText('Resolve the project conflict')).not.toBeInTheDocument();
    const reopened = screen.getByRole('dialog', { name: 'New project' });
    expect(within(reopened).getByRole('button', { name: 'Gray' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(reopened).getByRole('textbox', { name: 'Name' })).toHaveValue('');
  });

  it('given fixed server order, when Alt+Arrow moves a row, then the complete new order is saved', async () => {
    const onReorder = vi.fn(async () => undefined);
    const first = project('00000000-0000-7000-8000-0000000000f3', 'First');
    const second = project('00000000-0000-7000-8000-0000000000f4', 'Second');
    renderSection({ projects: [first, second], onReorder });

    fireEvent.keyDown(screen.getByRole('link', { name: /Second/u }), { altKey: true, key: 'ArrowUp' });

    await waitFor(() => expect(onReorder).toHaveBeenCalledWith([second.id, first.id]));
  });

  it('given fixed server order, when saving a reorder fails, then the section explains why the row snapped back', async () => {
    const first = project('00000000-0000-7000-8000-0000000000f3', 'First');
    const second = project('00000000-0000-7000-8000-0000000000f4', 'Second');
    renderSection({
      projects: [first, second],
      onReorder: async () => { throw new Error('Could not save project order'); },
    });

    fireEvent.keyDown(screen.getByRole('link', { name: /Second/u }), { altKey: true, key: 'ArrowUp' });

    expect(await screen.findByText('Could not save project order')).toBeVisible();
  });

  it('given member work streams, when the project expands, then children are newest first', () => {
    const older = { id: '00000000-0000-7000-8000-0000000000e1', title: 'Older', lastActivityAt: '2026-08-27T01:00:00.000Z' } as WorkstreamSummary;
    const newer = { id: '00000000-0000-7000-8000-0000000000e2', title: 'Newer', lastActivityAt: '2026-08-27T02:00:00.000Z' } as WorkstreamSummary;
    renderSection({
      projects: [{ ...hiring, workstreamIds: [older.id, newer.id] }],
      workstreams: [older, newer],
    });

    fireEvent.click(screen.getByRole('button', { name: 'Expand Hiring' }));
    const links = screen.getAllByRole('link').filter((link) => ['Older', 'Newer'].includes(link.textContent ?? ''));
    expect(links.map((link) => link.textContent)).toEqual(['Newer', 'Older']);
  });

  it('given a project row, when it is idle, then only its plus is the hover-revealed action', () => {
    renderSection();

    expect(screen.getByRole('button', { name: 'New work stream in Hiring' })).toHaveClass('project-sidebar-row-action');
    expect(screen.getByRole('button', { name: 'New project' })).not.toHaveClass('project-sidebar-row-action');
    expect(screen.getByRole('link', { name: /Hiring/u }).closest('.project-sidebar-row')).toHaveClass('sidebar-row');
  });

  it('given member work streams, when the project expands, then children render through the shared work-stream row', () => {
    const member = {
      id: '00000000-0000-7000-8000-0000000000e1',
      title: 'Ship the launch',
      lastActivityAt: '2026-08-27T01:00:00.000Z',
      preview: 'Draft the announcement',
    } as WorkstreamSummary;
    renderSection({
      projects: [{ ...hiring, workstreamIds: [member.id] }],
      renderWorkstream: (workstream) => (
        <NavLink className="sidebar-row workstream-row" to={`/workstreams/${workstream.id}`}>
          <span className="sidebar-row-title">{workstream.title}</span>
          <span className="sidebar-row-hint">{workstream.preview}</span>
        </NavLink>
      ),
      workstreams: [member],
    });

    fireEvent.click(screen.getByRole('button', { name: 'Expand Hiring' }));
    const row = screen.getByRole('link', { name: /Ship the launch/u });
    expect(row).toHaveClass('sidebar-row', 'workstream-row');
    expect(row.querySelector('.sidebar-row-title')).toHaveTextContent('Ship the launch');
    expect(row.querySelector('.sidebar-row-hint')).toHaveTextContent('Draft the announcement');
  });

  it('given a member outside the loaded sidebar page, when the project expands, then it does not claim to be empty', () => {
    renderSection({
      projects: [{ ...hiring, workstreamIds: ['00000000-0000-7000-8000-0000000000e9'] }],
      workstreams: [],
    });

    fireEvent.click(screen.getByRole('button', { name: 'Expand Hiring' }));

    expect(screen.getByText('1 work streams; load more to see all')).toBeVisible();
    expect(screen.queryByText('No work streams')).not.toBeInTheDocument();
  });

  it('given a dragged work stream, when it is dropped on a project, then membership is requested', async () => {
    const onAddWorkstream = vi.fn(async () => undefined);
    const workstreamId = '00000000-0000-7000-8000-0000000000e3';
    renderSection({ onAddWorkstream });

    fireEvent.drop(screen.getByRole('link', { name: /Hiring/u }).closest('.project-sidebar-item')!, {
      dataTransfer: { getData: (type: string) => type === 'application/x-rally-workstream-id' ? workstreamId : '' },
    });

    await waitFor(() => expect(onAddWorkstream).toHaveBeenCalledWith(hiring.id, workstreamId));
  });

  it('given a dragged work stream, when adding it fails, then the failure is visible outside either modal', async () => {
    renderSection({ onAddWorkstream: async () => { throw new Error('The project changed'); } });

    fireEvent.drop(screen.getByRole('link', { name: /Hiring/u }).closest('.project-sidebar-item')!, {
      dataTransfer: {
        getData: (type: string) => type === 'application/x-rally-workstream-id'
          ? '00000000-0000-7000-8000-0000000000e3'
          : '',
      },
    });

    expect(await screen.findByText('The project changed')).toBeVisible();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
