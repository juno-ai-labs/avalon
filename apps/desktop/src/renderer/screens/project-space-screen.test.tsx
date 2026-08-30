import * as Tooltip from '@radix-ui/react-tooltip';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import {
  PROJECT_COLOR_KEYS,
  PROJECT_ICON_KEYS,
  ProjectSummarySchema,
  asProjectId,
} from '@rally/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ProjectSpaceScreen } from './project-space';

const api = vi.hoisted(() => ({
  getWorkspaceMembers: vi.fn(),
  addProjectDefaultResource: vi.fn(),
  listResources: vi.fn(),
  updateProject: vi.fn(),
  updateProjectAudience: vi.fn(),
  restoreProject: vi.fn(),
}));

vi.mock('../lib/app-session', () => ({ useAppSession: () => ({ api }) }));
vi.mock('../lib/use-workstreams-query', () => ({ useWorkstreamsQuery: () => ({ data: [] }) }));

const project = ProjectSummarySchema.parse({
  id: asProjectId('019d3c99-63cc-7a88-8eb4-bf54b091be06'),
  name: 'Hiring',
  iconKey: 'briefcase',
  colorKey: 'green',
  scope: 'personal',
  status: 'active',
  presentationRevision: 1,
  audienceGeneration: 1,
  lifecycleGeneration: 1,
  participants: [{ userId: '00000000-0000-7000-8000-000000000002', state: 'active', generation: 1 }],
  defaultResourceIds: [],
  workstreamIds: [],
  createdAt: '2026-08-27T00:00:00.000Z',
  updatedAt: '2026-08-27T00:00:00.000Z',
});

function Location(): React.JSX.Element {
  return <output data-testid="location">{useLocation().pathname}</output>;
}

function renderProject(summary = project): QueryClient {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const active = summary.status === 'active';
  queryClient.setQueryData(['projects'], { waterline: 1, items: active ? [summary] : [] });
  queryClient.setQueryData(['projects-inactive'], { waterline: 1, items: active ? [] : [summary] });
  render(
    <Tooltip.Provider>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[`/projects/${summary.id}`]}>
          <Routes>
            <Route element={<ProjectSpaceScreen />} path="/projects/:projectId" />
            <Route element={<Location />} path="*" />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </Tooltip.Provider>,
  );
  return queryClient;
}

describe('project space appearance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getWorkspaceMembers.mockResolvedValue([{
      id: '00000000-0000-7000-8000-000000000002',
      name: 'Adam Juhasz',
      email: 'adam@example.com',
      timezone: 'America/Los_Angeles',
    }]);
    api.listResources.mockResolvedValue({ items: [{
      id: 'resource-1',
      title: 'Hiring plan',
      resourceType: 'document',
      provider: 'Drive',
      watchEnabled: false,
      watchStatus: 'unsupported',
    }], nextCursor: null });
    api.addProjectDefaultResource.mockResolvedValue({ ...project, defaultResourceIds: ['resource-1'] });
    api.updateProject.mockImplementation(async (_projectId: string, input: { name: string; iconKey: string; colorKey: string }) => ({
      ...project,
      name: input.name,
      iconKey: input.iconKey,
      colorKey: input.colorKey,
      presentationRevision: 2,
    }));
    api.updateProjectAudience.mockImplementation(async (_projectId: string, input: { scope: 'personal' | 'workspace' }) => ({
      ...project,
      scope: input.scope,
      audienceGeneration: 2,
    }));
  });

  it('opens the complete icon and color picker from the project icon and saves the choice', async () => {
    renderProject();

    fireEvent.click(screen.getByRole('button', { name: 'Change icon and color for Hiring' }));
    const dialog = screen.getByRole('dialog', { name: 'Project icon and color' });
    expect(within(dialog).getAllByRole('button').filter((button) => button.hasAttribute('aria-pressed'))).toHaveLength(
      PROJECT_ICON_KEYS.length + PROJECT_COLOR_KEYS.length,
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Target' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Purple' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(api.updateProject).toHaveBeenCalledWith(project.id, {
      name: 'Hiring',
      iconKey: 'target',
      colorKey: 'purple',
    }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Project icon and color' })).not.toBeInTheDocument());
  });

  it('edits the project name inline after a double click', async () => {
    renderProject();

    fireEvent.doubleClick(screen.getByRole('button', { name: 'Hiring' }));
    const input = screen.getByRole('textbox', { name: 'Project name' });
    fireEvent.change(input, { target: { value: 'Recruiting' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(api.updateProject).toHaveBeenCalledWith(project.id, {
      name: 'Recruiting',
      iconKey: 'briefcase',
      colorKey: 'green',
    }));
    expect(await screen.findByRole('button', { name: 'Recruiting' })).toBeVisible();
  });

  it('opens the shared participant face-pile picker from the project header', async () => {
    renderProject();

    fireEvent.click(await screen.findByRole('button', { name: 'Add participant' }));

    const dialog = screen.getByRole('dialog', { name: 'Add people' });
    expect(within(dialog).getByRole('checkbox')).toBeChecked();
    expect(within(dialog).getByText('Adam Juhasz')).toBeVisible();
  });

  it('asks for confirmation before applying a live scope selection', async () => {
    renderProject();

    fireEvent.click(screen.getByRole('combobox', { name: 'Project scope' }));
    fireEvent.click(screen.getByRole('option', { name: 'Everyone in the workspace' }));
    const dialog = screen.getByRole('dialog', { name: 'Change project access?' });
    expect(within(dialog).getByText(/Everyone in the workspace will be able/u)).toBeVisible();
    expect(api.updateProjectAudience).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Continue' }));

    await waitFor(() => expect(api.updateProjectAudience).toHaveBeenCalledWith(project.id, {
      scope: 'workspace',
      participantUserIds: ['00000000-0000-7000-8000-000000000002'],
    }));
  });

  it('opens a participant-style resource selector from the right-side section action', async () => {
    renderProject();

    fireEvent.click(screen.getByRole('button', { name: 'Add resource' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add resources' });
    fireEvent.click(await within(dialog).findByRole('checkbox'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add resources' }));

    await waitFor(() => expect(api.addProjectDefaultResource).toHaveBeenCalledWith(project.id, 'resource-1'));
  });

  it('opens the new project work stream page from the Work streams plus', () => {
    renderProject();

    const heading = screen.getByRole('heading', { name: 'Work streams' });
    const plus = screen.getByRole('button', { name: 'New work stream in Hiring' });
    expect(heading.parentElement).toContainElement(plus);
    expect(plus).toHaveClass('icon-button');
    expect(screen.getByText('Start one with the plus button in this section.')).toBeVisible();
    fireEvent.click(plus);
    expect(screen.getByTestId('location')).toHaveTextContent(`/projects/${project.id}/workstreams/new`);
  });

  it('keeps the Work streams plus disabled on an archived project', () => {
    renderProject(ProjectSummarySchema.parse({ ...project, status: 'archived' }));

    expect(screen.getByRole('button', { name: 'New work stream in Hiring' })).toBeDisabled();
    expect(screen.getByText('This archived project has no work streams.')).toBeVisible();
    expect(screen.queryByText('Start one with the plus button in this section.')).not.toBeInTheDocument();
  });

  it('exposes archive as a danger-colored icon-only control and opens the confirmation dialog', async () => {
    renderProject();

    const archive = screen.getByRole('button', { name: 'Archive project' });
    expect(archive).toHaveClass('icon-button', 'icon-button-danger');
    expect(archive).not.toHaveTextContent('Archive project');

    fireEvent.click(archive);
    const dialog = screen.getByRole('dialog', { name: 'Archive project?' });
    expect(within(dialog).getByRole('button', { name: 'Archive project' })).toHaveClass('button-danger');
  });

  it('keeps restore as a labeled header button', async () => {
    const archived = ProjectSummarySchema.parse({ ...project, status: 'archived' });
    const restored = { ...project, status: 'active' as const };
    api.restoreProject.mockResolvedValue(restored);
    renderProject(archived);

    const restore = screen.getByRole('button', { name: 'Restore project' });
    expect(restore).toHaveClass('button');
    expect(restore).not.toHaveClass('icon-button');
    expect(restore).toHaveTextContent('Restore project');

    fireEvent.click(restore);
    await waitFor(() => expect(api.restoreProject).toHaveBeenCalledWith(archived.id));
  });
});
