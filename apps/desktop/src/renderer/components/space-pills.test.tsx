import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import * as Tooltip from '@radix-ui/react-tooltip';
import type { SpaceSummary } from '@rally/contracts';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import { ApiError } from '../lib/api';
import type { WorkstreamSummary } from '../lib/types';
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
  const tree = (pillProps: Partial<React.ComponentProps<typeof SpacePills>>) => (
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
          {...pillProps}
        />
        <LocationProbe />
      </Tooltip.Provider>
    </MemoryRouter>
  );
  const view = render(tree(props));
  return {
    onSelect,
    rerenderPills: (next: Partial<React.ComponentProps<typeof SpacePills>>) => {
      view.rerender(tree({ ...props, ...next }));
    },
  };
}

async function openArchiveConfirmation(name: string): Promise<HTMLElement> {
  fireEvent.contextMenu(pill(name));
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Archive space' }));
  return screen.findByRole('dialog', { name: 'Archive space?' });
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

/**
 * jsdom implements no `DataTransfer`, and the Space drag reads two of its
 * fields: `types`, which is how a pill tells a Channel's drag passing through
 * it from a Space's own, and `dropEffect`, which is how `dragend` tells a
 * release the strip took from one backed out of.
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

  it('brings the selected pill into the strip\'s view', () => {
    const scrolled: Element[] = [];
    Element.prototype.scrollIntoView = function scrollIntoView(this: Element) { scrolled.push(this); };
    try {
      renderPills({ selectedSpaceId: 'hiring' });
      expect(scrolled).toEqual([pill('Hiring')]);
    } finally {
      delete (Element.prototype as Partial<Element>).scrollIntoView;
    }
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

  describe('archiving a Space', () => {
    it('archives only after the confirmation is accepted', async () => {
      const onArchive = vi.fn(async () => undefined);
      renderPills({ onArchive });

      const dialog = await openArchiveConfirmation('Launch');
      expect(onArchive).not.toHaveBeenCalled();
      fireEvent.click(within(dialog).getByRole('button', { name: 'Archive space' }));

      await waitFor(() => expect(onArchive).toHaveBeenCalledWith('launch'));
      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Archive space?' })).not.toBeInTheDocument());
    });

    it('keeps a refused archive open with actionable copy and the named channels', async () => {
      const blockedId = '00000000-0000-7000-8000-0000000000e1';
      const onArchive = vi.fn(async () => {
        throw new ApiError(
          'A Channel in Launch belongs to no other Space',
          409,
          'space_membership_final',
          { channelIds: [blockedId] },
        );
      });
      renderPills({
        onArchive,
        workstreams: [{ id: blockedId, title: 'Launch plan' } as WorkstreamSummary],
      });

      const dialog = await openArchiveConfirmation('Launch');
      fireEvent.click(within(dialog).getByRole('button', { name: 'Archive space' }));

      expect(await within(dialog).findByText('Every channel needs a space, and this would leave one with none. Add it to another space first.')).toBeVisible();
      expect(within(dialog).queryByText(/belongs to no other Space/u)).not.toBeInTheDocument();
      expect(within(within(dialog).getByRole('list', { name: 'Channels to move first' })).getByText('Launch plan')).toBeVisible();
      expect(screen.getByRole('dialog', { name: 'Archive space?' })).toBeVisible();
    });

    it('uses action-specific copy for an archive failure without a Space refusal code', async () => {
      renderPills({ onArchive: async () => { throw new Error('socket closed'); } });

      const dialog = await openArchiveConfirmation('Launch');
      fireEvent.click(within(dialog).getByRole('button', { name: 'Archive space' }));

      expect(await within(dialog).findByText('The space could not be archived.')).toBeVisible();
      expect(within(dialog).queryByText('socket closed')).not.toBeInTheDocument();
      expect(within(dialog).queryByRole('list', { name: 'Channels to move first' })).not.toBeInTheDocument();
    });

    it('disables an open archive confirmation with a visible error when authority is lost', async () => {
      const onArchive = vi.fn(async () => undefined);
      const { rerenderPills } = renderPills({ onArchive });

      const dialog = await openArchiveConfirmation('Launch');
      rerenderPills({ onArchive: undefined });

      expect(await within(dialog).findByText('The space directory is unavailable. Reconnect and try again.')).toBeVisible();
      const confirm = within(dialog).getByRole('button', { name: 'Archive space' });
      expect(confirm).toBeDisabled();
      fireEvent.click(confirm);
      expect(onArchive).not.toHaveBeenCalled();
    });

    it('disables an open archive confirmation when the Space leaves the active directory', async () => {
      const onArchive = vi.fn(async () => undefined);
      const { rerenderPills } = renderPills({ onArchive });

      const dialog = await openArchiveConfirmation('Launch');
      rerenderPills({ spaces: [general, hiring] });

      expect(await within(dialog).findByText('This space is no longer available to archive.')).toBeVisible();
      const confirm = within(dialog).getByRole('button', { name: 'Archive space' });
      expect(confirm).toBeDisabled();
      fireEvent.click(confirm);
      expect(onArchive).not.toHaveBeenCalled();
    });

    it('does not offer archive on a Space reached through a channel', async () => {
      renderPills({ spaces: [general, launch, space('shared', 'Shared', { reach: 'through_channel' })] });

      fireEvent.contextMenu(pill('Shared'));

      expect(await screen.findByRole('menuitem', { name: 'Open space' })).toBeInTheDocument();
      expect(screen.queryByRole('menuitem', { name: 'Archive space' })).not.toBeInTheDocument();
    });

    it('does not offer archive before the Space directory is live', async () => {
      renderPills({ onArchive: undefined });

      fireEvent.contextMenu(pill('Launch'));

      expect(await screen.findByRole('menuitem', { name: 'Open space' })).toBeInTheDocument();
      expect(screen.queryByRole('menuitem', { name: 'Archive space' })).not.toBeInTheDocument();
    });
  });

  it('clears a failed restore when the recovery dialog is reopened', async () => {
    const onRestore = vi.fn(async () => { throw new Error('Resolve the space conflict'); });
    renderPills({ inactiveSpaces: [space('archive', 'Archived', { status: 'archived' })], onRestore });

    fireEvent.contextMenu(screen.getByRole('button', { name: 'New space' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Restore archived space' }));
    const dialog = await screen.findByRole('dialog', { name: 'Restore archived space' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Archived' }));
    expect(await within(dialog).findByText('The space couldn’t be restored.')).toBeVisible();
    expect(screen.queryByText('Resolve the space conflict')).not.toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Restore archived space' })).not.toBeInTheDocument());
    fireEvent.contextMenu(screen.getByRole('button', { name: 'New space' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Restore archived space' }));
    const reopened = await screen.findByRole('dialog', { name: 'Restore archived space' });

    expect(within(reopened).getByRole('button', { name: 'Archived' })).toBeVisible();
    expect(screen.queryByText('The space couldn’t be restored.')).not.toBeInTheDocument();
  });

  describe('dragging a Space', () => {
    it('saves the full new order, General in its stored place, when a drag completes', async () => {
      const onReorder = vi.fn(async () => undefined);
      renderPills({ onReorder });

      const dataTransfer = spaceTransfer();
      fireEvent.dragStart(pill('Hiring'), { dataTransfer });
      fireEvent.dragEnter(pill('Launch'), { dataTransfer });
      fireEvent.dragEnd(pill('Hiring'), { dataTransfer });

      await waitFor(() => expect(onReorder).toHaveBeenCalledWith({
        container: { kind: 'organization' },
        itemIds: ['general', 'hiring', 'launch'],
      }));
    });

    // Escape leaves the drag with no accepted drop, which the browser reports
    // as `none`. Backing out is not finishing: the order persists to every
    // session the person has open.
    it('saves nothing and restores the stored order when a drag is backed out of', async () => {
      const onReorder = vi.fn(async () => undefined);
      renderPills({ onReorder });

      const dataTransfer = spaceTransfer();
      fireEvent.dragStart(pill('Hiring'), { dataTransfer });
      fireEvent.dragEnter(pill('Launch'), { dataTransfer });
      expect(within(screen.getByRole('group', { name: 'Spaces' })).getAllByRole('button').map((item) => item.textContent))
        .toEqual(['All', 'Hiring', 'Launch']);
      fireEvent.dragEnd(pill('Hiring'), { dataTransfer: { ...dataTransfer, dropEffect: 'none' } });

      await waitFor(() => expect(within(screen.getByRole('group', { name: 'Spaces' })).getAllByRole('button')
        .map((item) => item.textContent)).toEqual(['All', 'Launch', 'Hiring']));
      expect(onReorder).not.toHaveBeenCalled();
    });

    it('explains why a dragged order snapped back when saving it fails', async () => {
      renderPills({ onReorder: async () => { throw new Error('Could not save space order'); } });

      const dataTransfer = spaceTransfer();
      fireEvent.dragStart(pill('Hiring'), { dataTransfer });
      fireEvent.dragEnter(pill('Launch'), { dataTransfer });
      fireEvent.dragEnd(pill('Hiring'), { dataTransfer });

      const dialog = await screen.findByRole('dialog', { name: 'Spaces could not be reordered' });
      expect(within(dialog).getByText('The spaces are back in the order they were in. Try again in a moment.')).toBeVisible();
      expect(screen.queryByText('Could not save space order')).not.toBeInTheDocument();
      fireEvent.click(within(dialog).getByRole('button', { name: 'OK' }));
      await waitFor(() => expect(within(screen.getByRole('group', { name: 'Spaces' })).getAllByRole('button')
        .map((item) => item.textContent)).toEqual(['All', 'Launch', 'Hiring']));
    });
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
