import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as Tooltip from '@radix-ui/react-tooltip';
import { MemoryRouter, NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { SpaceSummarySchema, type SpaceSummary } from '@rally/contracts';

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
    reach: 'participant',
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

/**
 * jsdom implements no `DataTransfer`, and the Spaces drag reads two of its
 * fields: `types`, which is how a Space row tells a Channel's drag passing
 * through it from its own, and `dropEffect`, which is how `dragend` tells a
 * release the list took from one backed out of.
 */
function spaceTransfer(dropEffect: 'move' | 'none' = 'move'): {
  dropEffect: string; effectAllowed: string; types: string[];
  setData: (type: string, value: string) => void; getData: (type: string) => string;
} {
  const data = new Map<string, string>();
  const transfer = {
    dropEffect,
    effectAllowed: '',
    types: [] as string[],
    setData: (type: string, value: string) => {
      data.set(type, value);
      if (!transfer.types.includes(type)) transfer.types.push(type);
    },
    getData: (type: string) => data.get(type) ?? '',
  };
  return transfer;
}

function Location(): React.JSX.Element {
  return <output data-testid="location">{useLocation().pathname}</output>;
}

function renderSection(props: Partial<React.ComponentProps<typeof SpaceSidebarSection>> = {}) {
  return render(
    <Tooltip.Provider>
      <MemoryRouter initialEntries={['/workstreams/new']}>
        <SpaceSidebarSection
          hasMoreChannels={false}
          inactiveSpaces={[]}
          loading={false}
          loadingMoreChannels={false}
          onAddChannel={async () => undefined}
          onReorder={async () => undefined}
          onRestore={async () => undefined}
          onRetry={() => undefined}
          ordering={[]}
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
  it('given General in the directory, then it is an ordinary row without a creation action', () => {
    renderSection({ spaces: [general, hiring] });

    expect(screen.getByRole('link', { name: /General/u })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New channel in General' })).not.toBeInTheDocument();
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

  });

  // A deep link, a restore, Back and Forward all arrive as a route rather than
  // a click, and each of them opens a Space's dashboard.
  it('given a space dashboard opened by the route, then its row is expanded without a click', () => {
    const placement = channel('00000000-0000-7000-8000-0000000000e5', 'Ship it', '2026-08-27T02:00:00.000Z', hiring.id);
    render(
      <Tooltip.Provider>
        <MemoryRouter initialEntries={[`/spaces/${hiring.id}`]}>
          <SpaceSidebarSection
            hasMoreChannels={false}
            inactiveSpaces={[]}
            loading={false}
            loadingMoreChannels={false}
            onAddChannel={async () => undefined}
            onReorder={async () => undefined}
            onRestore={async () => undefined}
            onRetry={() => undefined}
            ordering={[]}
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

  it('offers no creation button on the Spaces heading or an individual Space', () => {
    renderSection({ spaces: [hiring] });
    expect(screen.queryByRole('button', { name: 'New space' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: `New channel in ${hiring.name}` })).not.toBeInTheDocument();
  });

  it('offers archived Space recovery without restoring either removed plus button', async () => {
    const onRestore = vi.fn(async () => undefined);
    renderSection({ inactiveSpaces: [space(hiring.id, 'Hiring', { status: 'archived' })], onRestore, spaces: [general] });

    expect(screen.queryByRole('link', { name: /Hiring/u })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Restore archived space' }));
    fireEvent.click(screen.getByRole('button', { name: /Hiring/u }));

    await waitFor(() => expect(onRestore).toHaveBeenCalledWith(hiring.id));
  });

  it('clears a failed restore when the recovery dialog is reopened', async () => {
    const onRestore = vi.fn(async () => { throw new Error('Resolve the space conflict'); });
    renderSection({ inactiveSpaces: [space(hiring.id, 'Hiring', { status: 'archived' })], onRestore, spaces: [] });
    fireEvent.click(screen.getByRole('button', { name: 'Restore archived space' }));
    fireEvent.click(screen.getByRole('button', { name: /Hiring/u }));
    await screen.findByText('The space couldn’t be restored.');
    expect(screen.queryByText('Resolve the space conflict')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Restore archived space' }));
    expect(screen.queryByText('Resolve the space conflict')).not.toBeInTheDocument();
    expect(screen.queryByText('The space couldn’t be restored.')).not.toBeInTheDocument();
  });

  it('given fixed server order, when Alt+Arrow moves a row, then the complete new order is saved', async () => {
    const onReorder = vi.fn(async () => undefined);
    const first = space('00000000-0000-7000-8000-0000000000f3', 'First');
    const second = space('00000000-0000-7000-8000-0000000000f4', 'Second');
    renderSection({ spaces: [first, second], onReorder });

    fireEvent.keyDown(screen.getByRole('link', { name: /Second/u }), { altKey: true, key: 'ArrowUp' });

    await waitFor(() => expect(onReorder).toHaveBeenCalledWith({
      container: { kind: 'organization' },
      itemIds: [second.id, first.id],
    }));
  });

  // The pointer's half of the same gesture. The keyboard test below it moves
  // one row by one step; this one is what a reader actually does, and it is the
  // one that can be fooled into comparing the arrangement it just built with
  // itself and concluding nothing moved.
  it('given two spaces, when one is dragged above the other, then the new order is saved', async () => {
    const onReorder = vi.fn(async () => undefined);
    const first = space('00000000-0000-7000-8000-0000000000f3', 'First');
    const second = space('00000000-0000-7000-8000-0000000000f4', 'Second');
    renderSection({ spaces: [first, second], onReorder });

    // jsdom implements no `DataTransfer`, and this drag needs two of its
    // fields: `types`, which is how a Space row tells a Channel's drag from
    // its own, and `dropEffect`, which is how `dragend` tells a release the
    // list took from one backed out of.
    const dataTransfer = spaceTransfer();
    const rows = screen.getAllByRole('link').map((link) => link.closest('.space-sidebar-item')!);
    fireEvent.dragStart(rows[1]!, { dataTransfer });
    fireEvent.dragEnter(rows[0]!, { dataTransfer });
    fireEvent.dragEnd(rows[1]!, { dataTransfer });

    await waitFor(() => expect(onReorder).toHaveBeenCalledWith({
      container: { kind: 'organization' },
      itemIds: [second.id, first.id],
    }));
  });

  /**
   * The third meaning of the gesture, and the one the Spaces list used to get
   * wrong: a reader who starts dragging, passes over three rows and thinks
   * better of it. Backing out of a drag must not be the same thing as
   * finishing one — this list persists to every session the person has open.
   */
  it('given a drag backed out of, when it ends, then nothing is saved', async () => {
    const onReorder = vi.fn(async () => undefined);
    const first = space('00000000-0000-7000-8000-0000000000f3', 'First');
    const second = space('00000000-0000-7000-8000-0000000000f4', 'Second');
    renderSection({ spaces: [first, second], onReorder });

    const dataTransfer = spaceTransfer();
    const rows = screen.getAllByRole('link').map((link) => link.closest('.space-sidebar-item')!);
    fireEvent.dragStart(rows[1]!, { dataTransfer });
    fireEvent.dragEnter(rows[0]!, { dataTransfer });
    // Escape leaves the drag with no accepted drop, which the browser reports
    // as `none`.
    fireEvent.dragEnd(rows[1]!, { dataTransfer: { ...dataTransfer, dropEffect: 'none' } });

    await waitFor(() => expect(screen.getAllByRole('link').map((link) => link.textContent))
      .toEqual([expect.stringContaining('First'), expect.stringContaining('Second')]));
    expect(onReorder).not.toHaveBeenCalled();
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

  // The sidebar holds one page of the Organization's Channels, so an expansion
  // can list fewer than the Space has. It says nothing rather than claiming the
  // Space is empty; the count is not viewer-scoped, so it cannot say a number.
  it('given a member outside the loaded sidebar page, when the space expands, then it does not claim to be empty', () => {
    renderSection({ spaces: [space(hiring.id, 'Hiring', { channelCount: 1 })], workstreams: [] });

    fireEvent.click(screen.getByRole('button', { name: 'Expand Hiring' }));

    expect(screen.queryByText('No channels')).not.toBeInTheDocument();
    expect(screen.queryByText(/open this space to see all/u)).not.toBeInTheDocument();
  });

  /**
   * The sidebar's own page trigger was the nav's scroll reaching the end of the
   * time-grouped list of every Channel, and that list is gone for a member. An
   * expanded Space is what is left that can tell the sidebar it is holding less
   * than the Organization says exists.
   */
  it('given an expanded space short of its channels, when pages remain, then the next one is asked for', async () => {
    const onLoadMoreChannels = vi.fn();
    renderSection({
      hasMoreChannels: true,
      onLoadMoreChannels,
      spaces: [space(hiring.id, 'Hiring', { channelCount: 3 })],
      workstreams: [channel('00000000-0000-7000-8000-0000000000e1', 'Only one', '2026-08-27T01:00:00.000Z', hiring.id)],
    });
    // Collapsed, the Space is drawing nothing and is not short of anything.
    expect(onLoadMoreChannels).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Expand Hiring' }));

    await waitFor(() => expect(onLoadMoreChannels).toHaveBeenCalled());
  });

  // The count is the Organization's rather than this viewer's, so a Space can
  // be permanently "short" of Channels this person may not read. Running out of
  // pages is what stops the asking; the count being reached is not.
  it('given no pages left, when an expanded space is still short, then nothing is asked for', async () => {
    const onLoadMoreChannels = vi.fn();
    renderSection({
      hasMoreChannels: false,
      onLoadMoreChannels,
      spaces: [space(hiring.id, 'Hiring', { channelCount: 3 })],
      workstreams: [channel('00000000-0000-7000-8000-0000000000e1', 'Only one', '2026-08-27T01:00:00.000Z', hiring.id)],
    });

    fireEvent.click(screen.getByRole('button', { name: 'Expand Hiring' }));

    await waitFor(() => expect(screen.getByRole('link', { name: 'Only one' })).toBeVisible());
    expect(onLoadMoreChannels).not.toHaveBeenCalled();
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

  /**
   * A Space this reader reaches only because they can read a Channel in it.
   *
   * It is an ordinary row — mark, name, expansion, placements — because its
   * whole reason to exist is to give that Channel somewhere to be drawn. What
   * it must not carry is a control, because every write on it is refused by
   * name, and a control that can only fail teaches a reader that Rally's
   * controls are suggestions.
   */
  it('given a space reached through a channel, then its row carries no plus and takes no drop', async () => {
    const onAddChannel = vi.fn(async () => undefined);
    const reached = space('00000000-0000-7000-8000-0000000000f4', 'Theirs', {
      reach: 'through_channel',
      participants: [],
      channelCount: 1,
    });
    const placement = channel('00000000-0000-7000-8000-0000000000e4', 'Shared work', '2026-08-27T10:00:00.000Z', reached.id);
    renderSection({ onAddChannel, spaces: [hiring, reached], workstreams: [placement] });

    expect(screen.getByRole('link', { name: /Theirs/u })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New channel in Hiring' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New channel in Theirs' })).not.toBeInTheDocument();

    fireEvent.drop(screen.getByRole('link', { name: /Theirs/u }).closest('.space-sidebar-item')!, {
      dataTransfer: {
        getData: (type: string) => type === 'application/x-rally-workstream-id'
          ? '00000000-0000-7000-8000-0000000000e5'
          : '',
      },
    });

    await waitFor(() => expect(screen.getByRole('link', { name: /Theirs/u })).toBeVisible());
    expect(onAddChannel).not.toHaveBeenCalled();
  });

  it('given a space reached through a channel, when it is expanded, then its placements are drawn', async () => {
    const reached = space('00000000-0000-7000-8000-0000000000f4', 'Theirs', {
      reach: 'through_channel',
      participants: [],
      channelCount: 1,
    });
    const placement = channel('00000000-0000-7000-8000-0000000000e4', 'Shared work', '2026-08-27T10:00:00.000Z', reached.id);
    renderSection({ spaces: [reached], workstreams: [placement] });

    // The point of the disclosure: the Channel is drawn under the Space it
    // actually lives in, rather than in a flat list of rows with no home.
    fireEvent.click(screen.getByRole('button', { name: 'Expand Theirs' }));
    expect(screen.getByRole('link', { name: 'Shared work' })).toBeInTheDocument();
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
