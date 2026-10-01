import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import * as Tooltip from '@radix-ui/react-tooltip';
import type { SpaceSummary } from '@rally/contracts';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import { SpacePills } from './space-pills';

function space(id: string, name: string, overrides: Partial<SpaceSummary> = {}): SpaceSummary {
  return {
    id: id as SpaceSummary['id'],
    name,
    iconKey: 'briefcase',
    colorKey: 'blue',
    scope: 'workspace',
    status: 'active',
    systemRole: null,
    revision: 1,
    reach: 'organization',
    participants: [],
    channelCount: 1,
    defaultResourceIds: [],
    defaultSidekickIds: [],
    createdAt: '2026-09-20T00:00:00.000Z',
    updatedAt: '2026-09-20T00:00:00.000Z',
    ...overrides,
  };
}

const general = space('general', 'General', { systemRole: 'general' });
const launch = space('launch', 'Launch');
const hiring = space('hiring', 'Hiring');

function LocationProbe(): React.JSX.Element {
  return <output aria-label="Location">{useLocation().pathname}</output>;
}

function renderPills(props: Partial<React.ComponentProps<typeof SpacePills>> = {}) {
  const onSelect = vi.fn();
  render(
    <MemoryRouter initialEntries={['/workstreams/current']}>
      <Tooltip.Provider>
        <SpacePills
          inactiveSpaces={[]}
          onArchive={vi.fn(async () => undefined)}
          onCreateChannel={vi.fn(async () => undefined)}
          onCreateSpace={vi.fn(async () => undefined)}
          onMoveChannel={vi.fn(async () => undefined)}
          onOrderPreviewChange={vi.fn()}
          onReorder={vi.fn(async () => undefined)}
          onRestore={vi.fn(async () => undefined)}
          onRetry={vi.fn()}
          onSelect={onSelect}
          ordering={[]}
          outOfDate={false}
          ready
          selectedSpaceId={null}
          spaces={[general, launch, hiring]}
          workstreams={[]}
          {...props}
        />
        <LocationProbe />
      </Tooltip.Provider>
    </MemoryRouter>,
  );
  return { onSelect };
}

function pill(name: string): HTMLElement {
  return within(screen.getByRole('group', { name: 'Spaces' })).getByRole('button', { name });
}

function channelTransfer(workstreamId: string, sourceSpaceId: string) {
  return {
    dropEffect: 'none',
    getData: (type: string) => type === 'application/x-rally-workstream-id'
      ? workstreamId
      : type === 'application/x-rally-channel-source-space-id' ? sourceSpaceId : '',
    types: ['application/x-rally-workstream-id', 'application/x-rally-channel-source-space-id'],
  };
}

describe('SpacePills', () => {
  it('draws All first, then a pill per Space except General, with the selection pressed', () => {
    renderPills({ selectedSpaceId: 'launch' });

    const pills = within(screen.getByRole('group', { name: 'Spaces' })).getAllByRole('button');
    expect(pills.map((item) => item.textContent)).toEqual(['All', 'Launch', 'Hiring']);
    expect(pills.map((item) => item.getAttribute('aria-pressed'))).toEqual(['false', 'true', 'false']);
    expect(screen.queryByRole('button', { name: 'General' })).not.toBeInTheDocument();
  });

  it('presses All when no Space is selected', () => {
    renderPills();

    expect(pill('All')).toHaveAttribute('aria-pressed', 'true');
    expect(pill('Launch')).toHaveAttribute('aria-pressed', 'false');
  });

  it('filters by a Space or by All without navigating', () => {
    const { onSelect } = renderPills({ selectedSpaceId: 'launch' });

    fireEvent.click(pill('Hiring'));
    expect(onSelect).toHaveBeenLastCalledWith('hiring');
    fireEvent.click(pill('All'));
    expect(onSelect).toHaveBeenLastCalledWith(null);
    expect(screen.getByRole('status', { name: 'Location' })).toHaveTextContent('/workstreams/current');
  });

  it('opens a Space from its pill menu', async () => {
    renderPills();

    fireEvent.contextMenu(pill('Launch'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Open space' }));

    await waitFor(() => expect(screen.getByRole('status', { name: 'Location' })).toHaveTextContent('/spaces/launch'));
  });

  it('archives a Space from its pill menu and falls back to All when it was selected', async () => {
    const onArchive = vi.fn(async () => undefined);
    const { onSelect } = renderPills({ onArchive, selectedSpaceId: 'launch' });

    fireEvent.contextMenu(pill('Launch'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Archive space' }));
    const dialog = await screen.findByRole('dialog', { name: 'Archive space?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Archive space' }));

    await waitFor(() => expect(onArchive).toHaveBeenCalledWith('launch'));
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith(null));
  });

  it('keeps General in its stored place when Alt+Arrow reorders the visible pills', async () => {
    const onReorder = vi.fn(async () => undefined);
    renderPills({ onReorder });

    expect(screen.getByText('Hold Alt and press the Left or Right Arrow key to reorder a space.')).toBeInTheDocument();
    fireEvent.keyDown(pill('Launch'), { altKey: true, key: 'ArrowRight' });

    await waitFor(() => expect(onReorder).toHaveBeenCalledWith({
      container: { kind: 'organization' },
      itemIds: ['general', 'hiring', 'launch'],
    }));
  });

  it('does not reorder past either end of the strip', () => {
    const onReorder = vi.fn(async () => undefined);
    renderPills({ onReorder });

    fireEvent.keyDown(pill('Launch'), { altKey: true, key: 'ArrowLeft' });
    fireEvent.keyDown(pill('Hiring'), { altKey: true, key: 'ArrowRight' });

    expect(onReorder).not.toHaveBeenCalled();
  });

  it('reports a refused Space reorder in an acknowledged error dialog', async () => {
    renderPills({ onReorder: async () => { throw new Error('Could not save the order'); } });

    fireEvent.keyDown(pill('Hiring'), { altKey: true, key: 'ArrowLeft' });

    const dialog = await screen.findByRole('dialog', { name: 'Spaces could not be reordered' });
    expect(within(dialog).getByText('The spaces are back in the order they were in. Try again in a moment.')).toBeVisible();
    expect(screen.queryByText('Could not save the order')).not.toBeInTheDocument();
  });

  it('opens the Create a new space form from the New space button', async () => {
    const onCreateSpace = vi.fn(async () => undefined);
    renderPills({ onCreateSpace });

    fireEvent.click(screen.getByRole('button', { name: 'New space' }));
    const dialog = await screen.findByRole('dialog', { name: 'Create a new space' });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Name of space' }), { target: { value: 'Research' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(onCreateSpace).toHaveBeenCalledWith('Research'));
  });

  it('restores an archived Space from the New space button menu and selects it', async () => {
    const onRestore = vi.fn(async () => undefined);
    const { onSelect } = renderPills({ inactiveSpaces: [space('archive', 'Archived', { status: 'archived' })], onRestore });

    fireEvent.contextMenu(screen.getByRole('button', { name: 'New space' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Restore archived space' }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Restore archived space' }))
      .getByRole('button', { name: 'Archived' }));

    await waitFor(() => expect(onRestore).toHaveBeenCalledWith('archive'));
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith('archive'));
  });

  it('offers no restore menu when nothing is archived', async () => {
    renderPills();

    fireEvent.contextMenu(screen.getByRole('button', { name: 'New space' }));
    await act(async () => undefined);

    expect(screen.queryByRole('menuitem', { name: 'Restore archived space' })).not.toBeInTheDocument();
  });

  it('offers no New space control to a read-only reader', () => {
    renderPills({ readOnly: true });

    expect(screen.queryByRole('button', { name: 'New space' })).not.toBeInTheDocument();
  });

  it('says the organization is opening before the directory is ready', () => {
    renderPills({ ready: false });

    expect(screen.getByText('Opening this organization…')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'All' })).not.toBeInTheDocument();
  });

  it('draws no pills while the first directory load is in flight', () => {
    renderPills({ loading: true, spaces: [] });

    expect(within(screen.getByRole('group', { name: 'Spaces' })).queryAllByRole('button')).toHaveLength(0);
  });

  it('keeps stale pills and offers a refresh', () => {
    const onRetry = vi.fn();
    renderPills({ onRetry, outOfDate: true });

    expect(pill('Launch')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  describe('dropping a Channel', () => {
    it('marks a held Channel as a move and highlights the target pill', () => {
      renderPills();
      const target = pill('Launch');
      const transfer = channelTransfer('', '');
      const over = new Event('dragover', { bubbles: true, cancelable: true });
      Object.defineProperty(over, 'dataTransfer', { value: transfer });

      target.dispatchEvent(over);
      expect(over.defaultPrevented).toBe(true);
      expect(transfer.dropEffect).toBe('move');

      fireEvent.dragEnter(target, { dataTransfer: transfer });
      expect(target).toHaveClass('is-channel-drop-target');
      fireEvent.dragLeave(target, { dataTransfer: transfer, relatedTarget: document.body });
      expect(target).not.toHaveClass('is-channel-drop-target');
    });

    it('moves the Channel from its source Space to the pill it is dropped on', async () => {
      const onMoveChannel = vi.fn(async () => undefined);
      renderPills({ onMoveChannel });
      const target = pill('Launch');
      const transfer = channelTransfer('channel-1', 'general');

      fireEvent.drop(target, { dataTransfer: transfer });

      await waitFor(() => expect(onMoveChannel).toHaveBeenCalledWith('general', 'launch', 'channel-1'));
      expect(transfer.dropEffect).toBe('move');
      expect(target).toHaveClass('is-channel-drop-accepted');
    });

    it('shows an acknowledged error dialog when the move is refused', async () => {
      const onMoveChannel = vi.fn(async () => { throw new Error('space_access_denied'); });
      renderPills({ onMoveChannel });
      const target = pill('Launch');

      fireEvent.drop(target, { dataTransfer: channelTransfer('channel-1', 'general') });

      const dialog = await screen.findByRole('dialog', { name: 'Channel could not be moved' });
      expect(dialog).toHaveTextContent('The channel is still in the space it came from. Try again in a moment.');
      expect(target).not.toHaveClass('is-channel-drop-accepted');
    });

    it('keeps a newer accepted-drop pulse when an older move is refused', async () => {
      const refusals: Array<(cause: Error) => void> = [];
      const onMoveChannel = vi.fn(() => new Promise<void>((_, reject) => { refusals.push(reject); }));
      renderPills({ onMoveChannel });
      const target = pill('Launch');

      fireEvent.drop(target, { dataTransfer: channelTransfer('channel-1', 'general') });
      fireEvent.drop(target, { dataTransfer: channelTransfer('channel-2', 'general') });
      expect(onMoveChannel).toHaveBeenCalledTimes(2);

      await act(async () => refusals[0]?.(new Error('first_refused')));
      expect(target).toHaveClass('is-channel-drop-accepted');
      await act(async () => refusals[1]?.(new Error('second_refused')));
      expect(target).not.toHaveClass('is-channel-drop-accepted');
    });

    it('refuses a read-only target, a read-only source, and the Space already selected', () => {
      const onMoveChannel = vi.fn(async () => undefined);
      const shared = space('shared', 'Shared', { reach: 'through_channel' });
      renderPills({ onMoveChannel, selectedSpaceId: 'hiring', spaces: [general, launch, hiring, shared] });

      const readOnlyTarget = channelTransfer('channel-1', 'general');
      const over = new Event('dragover', { bubbles: true, cancelable: true });
      Object.defineProperty(over, 'dataTransfer', { value: readOnlyTarget });
      pill('Shared').dispatchEvent(over);
      expect(over.defaultPrevented).toBe(false);
      fireEvent.drop(pill('Shared'), { dataTransfer: readOnlyTarget });

      const readOnlySource = channelTransfer('channel-1', 'shared');
      fireEvent.drop(pill('Launch'), { dataTransfer: readOnlySource });

      const selected = channelTransfer('channel-1', 'general');
      fireEvent.drop(pill('Hiring'), { dataTransfer: selected });

      expect(onMoveChannel).not.toHaveBeenCalled();
      expect([readOnlyTarget.dropEffect, readOnlySource.dropEffect, selected.dropEffect]).toEqual(['none', 'none', 'none']);
    });
  });
});
