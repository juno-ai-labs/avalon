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
          loading={false}
          onCreate={async () => undefined}
          onReorder={async () => undefined}
          projects={[hiring]}
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

    fireEvent.click(screen.getByRole('button', { name: 'Expand Hiring' }));
    expect(screen.getByText('No work streams')).toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent('/workstreams/new');

    fireEvent.click(screen.getByRole('link', { name: /Hiring/u }));
    expect(screen.getByTestId('location')).toHaveTextContent(`/projects/${hiring.id}`);

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

  it('given fixed server order, when Alt+Arrow moves a row, then the complete new order is saved', async () => {
    const onReorder = vi.fn(async () => undefined);
    const first = project('00000000-0000-7000-8000-0000000000f3', 'First');
    const second = project('00000000-0000-7000-8000-0000000000f4', 'Second');
    renderSection({ projects: [first, second], onReorder });

    fireEvent.keyDown(screen.getByRole('link', { name: /Second/u }), { altKey: true, key: 'ArrowUp' });

    await waitFor(() => expect(onReorder).toHaveBeenCalledWith([second.id, first.id]));
  });
});
