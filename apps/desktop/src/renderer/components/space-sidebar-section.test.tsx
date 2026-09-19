import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import * as Tooltip from '@radix-ui/react-tooltip';
import { useState } from 'react';
import { MemoryRouter, NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import {
  SPACE_COLOR_KEYS,
  SPACE_ICON_KEYS,
  SpaceSummarySchema,
  type SpaceSummary,
} from '@rally/contracts';

import { SpaceSidebarSection } from './space-sidebar-section';
import type { WorkstreamSummary } from '../lib/types';

function space(
  id: string,
  name: string,
  overrides: Record<string, unknown> = {},
): SpaceSummary {
  return SpaceSummarySchema.parse({
    id,
    name,
    iconKey: 'briefcase',
    colorKey: 'blue',
    scope: 'personal',
    status: 'active',
    systemRole: null,
    revision: 1,
    participants: [{ userId: '00000000-0000-7000-8000-0000000000f1' }],
    channelCount: 0,
    defaultResourceIds: [],
    defaultSidekickIds: [],
    createdAt: '2026-08-27T00:00:00.000Z',
    updatedAt: '2026-08-27T00:00:00.000Z',
    ...overrides,
  });
}

const general = space('00000000-0000-7000-8000-0000000000f0', 'General', {
  scope: 'workspace',
  systemRole: 'general',
});
const hiring = space('00000000-0000-7000-8000-0000000000f2', 'Hiring');

function channel(id: string, title: string, lastActivityAt: string, ...spaceIds: string[]): WorkstreamSummary {
  return { id, title, lastActivityAt, spaceIds } as WorkstreamSummary;
}

function Location(): React.JSX.Element {
  return <output data-testid="location">{useLocation().pathname}</output>;
}

function renderSection(props: Partial<React.ComponentProps<typeof SpaceSidebarSection>> = {}) {
  return render(
    <Tooltip.Provider>
      <MemoryRouter initialEntries={['/workstreams/new']}>
        <SpaceSidebarSection
          inactiveSpaces={[]}
          loading={false}
          onAddChannel={async () => undefined}
          onCreate={async () => hiring}
          onReorder={async () => undefined}
          onRestore={async () => undefined}
          onRetry={() => undefined}
          outOfDate={false}
          ready
          renderWorkstream={(workstream) => (
            <NavLink to={`/workstreams/${workstream.id}`}>{workstream.title}</NavLink>
          )}
          spaces={[hiring]}
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
  onCreate: React.ComponentProps<typeof SpaceSidebarSection>['onCreate'];
}): React.JSX.Element {
  const [spaces, setSpaces] = useState<SpaceSummary[]>([]);
  return (
    <>
      <SpaceSidebarSection
        inactiveSpaces={[]}
        loading={false}
        onAddChannel={async () => undefined}
        onCreate={async (input) => {
          const created = await onCreate(input);
          setSpaces((current) => [...current, created]);
          return created;
        }}
        onReorder={async () => undefined}
        onRestore={async () => undefined}
        onRetry={() => undefined}
        outOfDate={false}
        ready
        renderWorkstream={(workstream) => (
          <NavLink to={`/workstreams/${workstream.id}`}>{workstream.title}</NavLink>
        )}
        spaces={spaces}
        workstreams={[]}
      />
      <Location />
    </>
  );
}

describe('the Spaces sidebar section', () => {
  it('given no spaces yet, when the first answer is still in flight, then the section holds row-shaped skeletons', () => {
    const { container } = renderSection({ loading: true, spaces: [] });

    // The shape of the rows that are coming, the same placeholder the
    // automations and channels below show while the same answer is out.
    expect(container.querySelectorAll('.skeleton-row')).toHaveLength(3);
    // Nothing claims the organization has no spaces while they are arriving.
    expect(screen.queryByText('No spaces yet')).not.toBeInTheDocument();
    for (const row of container.querySelectorAll('.skeleton-row')) {
      expect(row).toHaveAttribute('aria-hidden', 'true');
    }
  });

  // General is the Organization's fallback home and is in the directory like
  // any other Space, so the section needs no case for it — which is the thing
  // worth pinning, because a special case is what would drift.
  it('given General in the directory, then it is an ordinary row with its own new-channel action', () => {
    renderSection({ spaces: [general, hiring] });

    expect(screen.getByRole('link', { name: /General/u })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New channel in General' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Expand General' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('given one space, when its row opens the dashboard and is clicked again, then the selected row closes its accordion', () => {
    renderSection();

    fireEvent.click(screen.getByRole('link', { name: /Hiring/u }));
    expect(screen.getByTestId('location')).toHaveTextContent(`/spaces/${hiring.id}`);
    expect(screen.getByRole('button', { name: 'Collapse Hiring' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('No channels')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('link', { name: /Hiring/u }));
    expect(screen.getByRole('button', { name: 'Expand Hiring' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('No channels')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'New channel in Hiring' }));
    expect(screen.getByTestId('location')).toHaveTextContent(`/spaces/${hiring.id}/workstreams/new`);
  });

  // A deep link, a restore, Back and Forward all arrive as a route rather than
  // a click, and each of them opens a Space's dashboard.
  it('given a space dashboard opened by the route, then its row is expanded without a click', () => {
    const placement = channel('00000000-0000-7000-8000-0000000000e5', 'Ship it', '2026-08-27T02:00:00.000Z', hiring.id);
    render(
      <Tooltip.Provider>
        <MemoryRouter initialEntries={[`/spaces/${hiring.id}`]}>
          <SpaceSidebarSection
            inactiveSpaces={[]}
            loading={false}
            onAddChannel={async () => undefined}
            onCreate={async () => hiring}
            onReorder={async () => undefined}
            onRestore={async () => undefined}
            onRetry={() => undefined}
            outOfDate={false}
            ready
            renderWorkstream={(workstream) => (
              <NavLink to={`/workstreams/${workstream.id}`}>{workstream.title}</NavLink>
            )}
            spaces={[hiring]}
            workstreams={[placement]}
          />
        </MemoryRouter>
      </Tooltip.Provider>,
    );

    expect(screen.getByRole('button', { name: 'Collapse Hiring' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('link', { name: 'Ship it' })).toBeVisible();
  });

  it('given the new-space dialog, when choices are inspected, then blue is selected by default and all choices are named', () => {
    renderSection({ spaces: [] });
    fireEvent.click(screen.getByRole('button', { name: 'New space' }));
    const dialog = screen.getByRole('dialog', { name: 'New space' });
    for (const icon of SPACE_ICON_KEYS) {
      const name = icon.split('-').map((part) => `${part[0]!.toUpperCase()}${part.slice(1)}`).join(' ');
      expect(within(dialog).getByRole('button', { name })).toBeInTheDocument();
    }
    for (const color of SPACE_COLOR_KEYS) {
      const name = `${color[0]!.toUpperCase()}${color.slice(1)}`;
      expect(within(dialog).getByRole('button', { name })).toBeInTheDocument();
    }
    expect(within(dialog).getByRole('button', { name: 'Blue' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Red' }));
    expect(within(dialog).getByRole('button', { name: 'Briefcase' }).querySelector('svg'))
      .toHaveAttribute('stroke', 'var(--av-sys-color-project-red)');
  }, 30_000);

  it('given space creation is pending, when it succeeds, then the dialog waits before opening and selecting the space', async () => {
    const created = space('00000000-0000-7000-8000-0000000000f5', 'Planning');
    let finishCreate!: (space: SpaceSummary) => void;
    const onCreate = vi.fn(() => new Promise<SpaceSummary>((resolve) => { finishCreate = resolve; }));
    render(
      <Tooltip.Provider>
        <MemoryRouter initialEntries={['/workstreams/new']}>
          <CreateFlowHarness onCreate={onCreate} />
        </MemoryRouter>
      </Tooltip.Provider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'New space' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'Planning' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create space' }));

    // A Space starts personal, with its creator as its participant; the server
    // seats them, so the request says nothing about people.
    expect(onCreate).toHaveBeenCalledWith({
      colorKey: 'blue',
      iconKey: 'briefcase',
      name: 'Planning',
      scope: 'personal',
    });
    expect(screen.getByTestId('location')).toHaveTextContent('/workstreams/new');
    expect(screen.getByRole('button', { name: 'Create space' })).toBeDisabled();

    await act(async () => { finishCreate(created); });

    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent(`/spaces/${created.id}`));
    expect(screen.getByRole('link', { name: /Planning/u })).toHaveClass('is-active');
    expect(screen.getByRole('button', { name: 'Collapse Planning' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.queryByRole('dialog', { name: 'New space' })).not.toBeInTheDocument();
  });

  // Archived Spaces are absent from the section and from every picker; the one
  // way back to one is the footer of the dialog that makes new ones.
  it('given an archived space, when restore is opened from the new-space footer, then it is offered there and nowhere else', async () => {
    const onRestore = vi.fn(async () => undefined);
    renderSection({ inactiveSpaces: [space(hiring.id, 'Hiring', { status: 'archived' })], onRestore, spaces: [general] });

    expect(screen.queryByRole('link', { name: /Hiring/u })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'New space' }));
    fireEvent.click(screen.getByRole('button', { name: 'Restore archived space' }));
    fireEvent.click(screen.getByRole('button', { name: /Hiring/u }));

    await waitFor(() => expect(onRestore).toHaveBeenCalledWith(hiring.id));
  });

  it('given a failed restore, when recovery is closed and space creation opens, then the restore error stays out of the new-space form', async () => {
    const onRestore = vi.fn(async () => { throw new Error('Resolve the space conflict'); });
    renderSection({ inactiveSpaces: [space(hiring.id, 'Hiring', { status: 'archived' })], onRestore, spaces: [] });
    fireEvent.click(screen.getByRole('button', { name: 'New space' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'Temporary' } });
    fireEvent.click(screen.getByRole('button', { name: 'Red' }));
    fireEvent.click(screen.getByRole('button', { name: 'Restore archived space' }));
    fireEvent.click(screen.getByRole('button', { name: /Hiring/u }));
    await screen.findByText('The space couldn’t be restored.');
    expect(screen.queryByText('Resolve the space conflict')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'New space' }));

    expect(screen.queryByText('Resolve the space conflict')).not.toBeInTheDocument();
    const reopened = screen.getByRole('dialog', { name: 'New space' });
    expect(within(reopened).getByRole('button', { name: 'Blue' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(reopened).getByRole('textbox', { name: 'Name' })).toHaveValue('');
  });

  it('given fixed server order, when Alt+Arrow moves a row, then the complete new order is saved', async () => {
    const onReorder = vi.fn(async () => undefined);
    const first = space('00000000-0000-7000-8000-0000000000f3', 'First');
    const second = space('00000000-0000-7000-8000-0000000000f4', 'Second');
    renderSection({ spaces: [first, second], onReorder });

    fireEvent.keyDown(screen.getByRole('link', { name: /Second/u }), { altKey: true, key: 'ArrowUp' });

    await waitFor(() => expect(onReorder).toHaveBeenCalledWith([second.id, first.id]));
  });

  it('given fixed server order, when saving a reorder fails, then the section explains why the row snapped back', async () => {
    const first = space('00000000-0000-7000-8000-0000000000f3', 'First');
    const second = space('00000000-0000-7000-8000-0000000000f4', 'Second');
    renderSection({
      spaces: [first, second],
      onReorder: async () => { throw new Error('Could not save space order'); },
    });

    fireEvent.keyDown(screen.getByRole('link', { name: /Second/u }), { altKey: true, key: 'ArrowUp' });

    expect(await screen.findByText('Spaces couldn’t be reordered.')).toBeVisible();
    expect(screen.queryByText('Could not save space order')).not.toBeInTheDocument();
  });

  it('given placements, when the space expands, then children are newest first and render through the shared channel row', () => {
    const older = channel('00000000-0000-7000-8000-0000000000e1', 'Older', '2026-08-27T01:00:00.000Z', hiring.id);
    const newer = channel('00000000-0000-7000-8000-0000000000e2', 'Newer', '2026-08-27T02:00:00.000Z', hiring.id);
    renderSection({
      spaces: [space(hiring.id, 'Hiring', { channelCount: 2 })],
      workstreams: [older, newer],
    });

    fireEvent.click(screen.getByRole('button', { name: 'Expand Hiring' }));
    const links = screen.getAllByRole('link').filter((link) => ['Older', 'Newer'].includes(link.textContent ?? ''));
    expect(links.map((link) => link.textContent)).toEqual(['Newer', 'Older']);
  });

  // The sidebar holds one page of the Organization's Channels; the Space's own
  // count is the authority on how many it has. An expansion that listed only
  // what this device happens to hold would read as a smaller Space.
  it('given a member outside the loaded sidebar page, when the space expands, then it does not claim to be empty', () => {
    renderSection({ spaces: [space(hiring.id, 'Hiring', { channelCount: 1 })], workstreams: [] });

    fireEvent.click(screen.getByRole('button', { name: 'Expand Hiring' }));

    expect(screen.getByText('1 channel; open this space to see all')).toBeVisible();
    expect(screen.queryByText('No channels')).not.toBeInTheDocument();
  });

  it('given a dragged channel, when it is dropped on a space, then membership is requested', async () => {
    const onAddChannel = vi.fn(async () => undefined);
    const workstreamId = '00000000-0000-7000-8000-0000000000e3';
    renderSection({ onAddChannel });

    fireEvent.drop(screen.getByRole('link', { name: /Hiring/u }).closest('.space-sidebar-item')!, {
      dataTransfer: { getData: (type: string) => type === 'application/x-rally-workstream-id' ? workstreamId : '' },
    });

    await waitFor(() => expect(onAddChannel).toHaveBeenCalledWith(hiring.id, workstreamId));
  });

  // The Channel's row sits inside the Space's own drag item, so its drag start
  // reaches the Space too. Reordering on it moved the Space the Channel was
  // dragged out of, on top of placing the Channel where it was dropped.
  it('given a channel dragged out of an expanded space, then only the placement is requested', async () => {
    const onAddChannel = vi.fn(async () => undefined);
    const onReorder = vi.fn(async () => undefined);
    const launch = space('00000000-0000-7000-8000-0000000000f3', 'Launch');
    const placement = channel('00000000-0000-7000-8000-0000000000e4', 'Ship it', '2026-08-27T02:00:00.000Z', hiring.id);
    renderSection({ onAddChannel, onReorder, spaces: [hiring, launch], workstreams: [placement] });
    fireEvent.click(screen.getByRole('button', { name: 'Expand Hiring' }));

    const dataTransfer = {
      effectAllowed: '',
      getData: (type: string) => type === 'application/x-rally-workstream-id' ? placement.id : '',
      setData: () => undefined,
      types: ['application/x-rally-workstream-id'],
    };
    const row = screen.getByRole('link', { name: 'Ship it' });
    const target = screen.getByText('Launch').closest('.space-sidebar-item')!;
    fireEvent.dragStart(row, { dataTransfer });
    fireEvent.dragEnter(target, { dataTransfer });
    fireEvent.drop(target, { dataTransfer });
    fireEvent.dragEnd(row, { dataTransfer });

    await waitFor(() => expect(onAddChannel).toHaveBeenCalledWith(launch.id, placement.id));
    expect(onReorder).not.toHaveBeenCalled();
  });

  it('given a dragged channel, when adding it fails, then the failure is visible outside either modal', async () => {
    renderSection({ onAddChannel: async () => { throw new Error('The space changed'); } });

    fireEvent.drop(screen.getByRole('link', { name: /Hiring/u }).closest('.space-sidebar-item')!, {
      dataTransfer: {
        getData: (type: string) => type === 'application/x-rally-workstream-id'
          ? '00000000-0000-7000-8000-0000000000e3'
          : '',
      },
    });

    expect(await screen.findByText('That channel couldn’t be added to the space.')).toBeVisible();
    expect(screen.queryByText('The space changed')).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  // A hierarchy that is half built is not a state any surface may render, so
  // there is nothing truthful to draw underneath the card — and nothing to
  // create into, which the server refuses with `space_bootstrap_pending`.
  it('given an organization still opening, then no rows and no create action are drawn', () => {
    renderSection({ ready: false, spaces: [general, hiring] });

    expect(screen.getByText(/Rally is opening this organization/u)).toBeVisible();
    expect(screen.queryByRole('link', { name: /General/u })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New space' })).not.toBeInTheDocument();
  });

  it('given a failed refresh, then the known rows stay, marked out of date, with one retry', () => {
    const onRetry = vi.fn();
    renderSection({ onRetry, outOfDate: true, spaces: [general] });

    expect(screen.getByRole('link', { name: /General/u })).toBeVisible();
    expect(screen.getByText('These spaces may be out of date.')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalled();
  });
});
