import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import * as Tooltip from '@radix-ui/react-tooltip';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
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
          onCreate={async () => undefined}
          onReorder={async () => undefined}
          onRestore={async () => undefined}
          projects={[hiring]}
          workstreams={[]}
          {...props}
        />
        <Routes><Route element={<Location />} path="*" /></Routes>
      </MemoryRouter>
    </Tooltip.Provider>,
  );
}

describe('the Projects sidebar section', () => {
  it('given one project, when each row control is used, then accordion, project link, and plus navigate independently', () => {
    renderSection();

    fireEvent.click(screen.getByRole('link', { name: /Hiring/u }));
    expect(screen.getByTestId('location')).toHaveTextContent(`/projects/${hiring.id}`);
    expect(screen.getByRole('button', { name: 'Collapse Hiring' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('No work streams')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'New work stream in Hiring' }));
    expect(screen.getByTestId('location')).toHaveTextContent(`/projects/${hiring.id}/workstreams/new`);
  });

  it('given the new-project dialog, when choices are inspected, then all shared icons and colors are named', () => {
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
  });

  it('given the color grid, when a color receives focus, then its name appears in the standard tooltip', async () => {
    renderSection({ projects: [] });
    fireEvent.click(screen.getByRole('button', { name: 'New project' }));

    fireEvent.focus(screen.getByRole('button', { name: 'Blue' }));

    await waitFor(() => expect(screen.getByRole('tooltip')).toHaveClass('tooltip'));
    expect(screen.getByRole('tooltip')).toHaveTextContent('Blue');
  });

  it('given a failed restore, when recovery is closed and project creation opens, then the restore error stays out of the new-project form', async () => {
    const onRestore = vi.fn(async () => { throw new Error('Resolve the project conflict'); });
    renderSection({ inactiveProjects: [{ ...hiring, status: 'archived' }], onRestore, projects: [] });
    fireEvent.click(screen.getByRole('button', { name: 'New project' }));
    fireEvent.click(screen.getByRole('button', { name: 'Restore archived project' }));
    fireEvent.click(screen.getByRole('button', { name: /Hiring/u }));
    await screen.findByText('Resolve the project conflict');

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'New project' }));

    expect(screen.queryByText('Resolve the project conflict')).not.toBeInTheDocument();
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
