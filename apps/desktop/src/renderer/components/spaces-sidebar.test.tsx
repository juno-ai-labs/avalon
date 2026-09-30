import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import * as Tooltip from '@radix-ui/react-tooltip';
import type { SpaceSummary } from '@rally/contracts';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import type { DesktopUpdateStatus } from '../../common/desktop';
import { SpacesSidebar } from './spaces-sidebar';
import type * as PlatformModule from '../lib/platform';

/** Update methods layered over the real bridge while a test sets them. */
const updateBridge = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));
vi.mock('../lib/platform', async (importOriginal) => {
  const original = await importOriginal<typeof PlatformModule>();
  return {
    ...original,
    desktopBridge: () => ({ ...original.desktopBridge(), ...updateBridge.current }),
  };
});


function space(id: string, name: string, channelCount: number): SpaceSummary {
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
    channelCount,
    defaultResourceIds: [],
    defaultSidekickIds: [],
    createdAt: '2026-09-20T00:00:00.000Z',
    updatedAt: '2026-09-20T00:00:00.000Z',
  };
}

function renderSidebar(props: Partial<React.ComponentProps<typeof SpacesSidebar>> = {}) {
  const onCollapsedChange = vi.fn();
  const onWidthChange = vi.fn();
  const onSelect = vi.fn();
  render(
    <MemoryRouter>
      <Tooltip.Provider>
        <SpacesSidebar
          accountSlotRef={vi.fn()}
          availableWidth={400}
          sidekickSlotRef={vi.fn()}
          collapsed={false}
          constrained={false}
          width={280}
          onCollapsedChange={onCollapsedChange}
          onWidthChange={onWidthChange}
          currentPath="/workstreams/current"
          inactiveSpaces={[]}
          onMoveChannel={vi.fn(async () => undefined)}
          onArchive={vi.fn(async () => undefined)}
          onOpenSearch={vi.fn()}
          onCreateChannel={vi.fn(async () => undefined)}
          onCreateSpace={vi.fn(async () => undefined)}
          onOrderPreviewChange={vi.fn()}
          onReorder={vi.fn(async () => undefined)}
          onRetry={vi.fn()}
          onRestore={vi.fn(async () => undefined)}
          onSelect={onSelect}
          ordering={[]}
          outOfDate={false}
          ready
          selectedSpaceId="general"
          spaces={[space('general', 'General', 3), space('launch', 'Launch', 1)]}
          workstreams={[]}
          {...props}
          scrollStateKey={props.scrollStateKey ?? 'test-spaces-scroll'}
        />
      </Tooltip.Provider>
    </MemoryRouter>,
  );
  return { onCollapsedChange, onSelect, onWidthChange };
}

describe('SpacesSidebar', () => {
  it('draws one navigation row per Space without a Channel count and selects the next level', () => {
    const { onSelect } = renderSidebar();
    const sidebar = screen.getByRole('complementary', { name: 'Spaces sidebar' });

    expect(within(sidebar).queryByRole('heading', { name: 'Spaces' })).not.toBeInTheDocument();
    const header = sidebar.querySelector('.sidebar-header');
    expect(header).toHaveClass('sidebar-row');
    expect(header).toHaveAttribute('aria-label', 'Space actions');
    expect(header?.nextElementSibling).toHaveClass('sidebar-horizontal-line', 'sidebar-header-line');
    expect(sidebar.querySelector('.sidebar-horizontal-line')).not.toBeNull();
    expect(sidebar.querySelector('.spaces-sidebar-scroll')).toHaveClass('sidebar-scroll');
    expect(screen.getByRole('link', { name: 'General' })).toHaveClass('is-active');
    expect(screen.getByRole('link', { name: 'General' })).toHaveClass('sidebar-row');
    expect(within(screen.getByRole('link', { name: 'General' })).getByText('Public space'))
      .toHaveClass('sidebar-row-activity');
    expect(screen.queryByText('3 channels')).not.toBeInTheDocument();
    expect(screen.queryByText('1 channel')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('link', { name: 'Launch' }));

    expect(onSelect).toHaveBeenCalledWith('launch');
  });

  it('keeps Space scope but no Channel count in compact row previews', async () => {
    renderSidebar({ collapsed: true });
    const general = screen.getByRole('link', { name: 'General' });
    const launch = screen.getByRole('link', { name: 'Launch' });

    fireEvent.focus(general);
    const generalPreview = await screen.findByRole('tooltip');
    expect(generalPreview).toHaveTextContent('General');
    expect(generalPreview).toHaveTextContent('Organization space');
    expect(generalPreview).not.toHaveTextContent('3 channels');

    fireEvent.blur(general);
    fireEvent.focus(launch);
    await waitFor(
      () => expect(screen.getByRole('tooltip')).toHaveTextContent('Launch'),
      { timeout: 5_000 },
    );
    expect(screen.getByRole('tooltip')).toHaveTextContent('Organization space');
    expect(screen.getByRole('tooltip')).not.toHaveTextContent('1 channel');
  });

  it('omits the private scope subtitle from personal Space rows and previews', async () => {
    renderSidebar({
      collapsed: true,
      spaces: [{ ...space('personal', 'Personal', 0), scope: 'personal', reach: 'participant' }],
    });
    const row = screen.getByRole('link', { name: 'Personal' });
    expect(row).not.toHaveAccessibleDescription('Private space');
    expect(within(row).queryByText('Private space')).not.toBeInTheDocument();

    fireEvent.focus(row);
    const preview = await screen.findByRole('tooltip');
    expect(preview).toHaveTextContent('Personal');
    expect(preview).not.toHaveTextContent('Private space');
  });

  it('draws an attention count on a Space row and omits zero', () => {
    renderSidebar({
      spaces: [
        { ...space('general', 'General', 3), attentionCount: 4 },
        { ...space('launch', 'Launch', 1), attentionCount: 0 },
      ],
    });

    const general = screen.getByRole('link', { name: 'General' });
    expect(general).toHaveAccessibleDescription('4 conversations need attention in General');
    expect(within(general).getByText('4')).toHaveAttribute('aria-hidden', 'true');
    expect(within(screen.getByRole('link', { name: 'Launch' })).queryByText('0')).not.toBeInTheDocument();
  });

  it('describes the keyboard gesture that reorders Spaces', () => {
    renderSidebar();

    expect(screen.getByRole('navigation', { name: 'Spaces' }))
      .toHaveAccessibleDescription('Hold Alt and press the Up or Down Arrow key to reorder a space.');
  });

  it('reports a refused Space reorder in an acknowledged error dialog', async () => {
    renderSidebar({ onReorder: async () => { throw new Error('Could not save the order'); } });

    fireEvent.keyDown(screen.getByRole('link', { name: 'Launch' }), { altKey: true, key: 'ArrowUp' });

    const dialog = await screen.findByRole('dialog', { name: 'Spaces could not be reordered' });
    expect(within(dialog).getByText('The spaces are back in the order they were in. Try again in a moment.')).toBeVisible();
    expect(within(dialog).getByRole('button', { name: 'OK' })).toBeVisible();
    expect(screen.queryByText('Could not save the order')).not.toBeInTheDocument();
  });

  it('does not accept a Channel drop on a read-only Space', () => {
    const onMoveChannel = vi.fn(async () => undefined);
    const readOnly = { ...space('shared', 'Shared', 1), reach: 'through_channel' as const };
    renderSidebar({ onMoveChannel, spaces: [readOnly] });
    const row = screen.getByRole('link', { name: 'Shared' });
    const transfer = {
      dropEffect: 'none',
      getData: (type: string) => type === 'application/x-rally-workstream-id'
        ? 'channel-1'
        : type === 'application/x-rally-channel-source-space-id' ? 'general' : '',
      types: ['application/x-rally-workstream-id', 'application/x-rally-channel-source-space-id'],
    };

    const over = new Event('dragover', { bubbles: true, cancelable: true });
    Object.defineProperty(over, 'dataTransfer', { value: transfer });
    row.dispatchEvent(over);
    fireEvent.drop(row, { dataTransfer: transfer });

    expect(over.defaultPrevented).toBe(false);
    expect(onMoveChannel).not.toHaveBeenCalled();
  });

  it('selects read-only Spaces without opening the member Space dashboard', () => {
    const { onSelect } = renderSidebar({ readOnly: true });

    expect(screen.queryByRole('link', { name: 'Launch' })).not.toBeInTheDocument();
    const row = screen.getByRole('button', { name: 'Launch' });
    expect(row).not.toHaveAttribute('href');
    fireEvent.click(row);
    expect(onSelect).toHaveBeenCalledWith('launch');
  });

  it('marks a cross-rail Channel drop as a move', () => {
    renderSidebar();
    const row = screen.getByRole('link', { name: 'Launch' });
    const transfer = {
      dropEffect: 'none',
      getData: () => '',
      types: ['application/x-rally-workstream-id', 'application/x-rally-channel-source-space-id'],
    };
    const over = new Event('dragover', { bubbles: true, cancelable: true });
    Object.defineProperty(over, 'dataTransfer', { value: transfer });

    row.dispatchEvent(over);

    expect(over.defaultPrevented).toBe(true);
    expect(transfer.dropEffect).toBe('move');
  });

  it('highlights a Space while a Channel is held over its drop target', () => {
    renderSidebar();
    const row = screen.getByRole('link', { name: 'Launch' });
    const transfer = {
      dropEffect: 'none',
      getData: () => '',
      types: ['application/x-rally-workstream-id', 'application/x-rally-channel-source-space-id'],
    };

    fireEvent.dragEnter(row, { dataTransfer: transfer });
    expect(row).toHaveClass('is-channel-drop-target');

    fireEvent.dragLeave(row, { dataTransfer: transfer, relatedTarget: document.body });
    expect(row).not.toHaveClass('is-channel-drop-target');
  });

  it('moves a Channel from its source Space to the Space it is dropped on', async () => {
    let settleMove: (() => void) | undefined;
    const onMoveChannel = vi.fn(() => new Promise<void>((resolve) => {
      settleMove = resolve;
    }));
    renderSidebar({ onMoveChannel });
    const transfer = {
      dropEffect: 'none',
      getData: (type: string) => type === 'application/x-rally-workstream-id'
        ? 'channel-1'
        : type === 'application/x-rally-channel-source-space-id' ? 'general' : '',
      types: ['application/x-rally-workstream-id', 'application/x-rally-channel-source-space-id'],
    };

    const target = screen.getByRole('link', { name: 'Launch' });
    fireEvent.dragEnter(target, { dataTransfer: transfer });
    fireEvent.drop(target, { dataTransfer: transfer });

    await waitFor(() => expect(onMoveChannel).toHaveBeenCalledWith('general', 'launch', 'channel-1'));
    expect(transfer.dropEffect).toBe('move');
    expect(target).not.toHaveClass('is-channel-drop-target');
    expect(target).toHaveClass('is-channel-drop-accepted');

    settleMove?.();
    await waitFor(() => expect(target).toHaveClass('is-channel-drop-accepted'));
  });

  it('shows an acknowledged error dialog when a Channel move is refused', async () => {
    const onMoveChannel = vi.fn(async () => { throw new Error('space_access_denied'); });
    renderSidebar({ onMoveChannel });
    const transfer = {
      dropEffect: 'none',
      getData: (type: string) => type === 'application/x-rally-workstream-id'
        ? 'channel-1'
        : type === 'application/x-rally-channel-source-space-id' ? 'general' : '',
      types: ['application/x-rally-workstream-id', 'application/x-rally-channel-source-space-id'],
    };
    const target = screen.getByRole('link', { name: 'Launch' });

    fireEvent.drop(target, { dataTransfer: transfer });

    const dialog = await screen.findByRole('dialog', { name: 'Channel could not be moved' });
    expect(dialog).toHaveTextContent('The channel is still in the space it came from. Try again in a moment.');
    expect(within(dialog).getByRole('button', { name: 'OK' })).toBeVisible();
    expect(document.querySelector('.spaces-sidebar-error')).not.toBeInTheDocument();
    expect(target).not.toHaveClass('is-channel-drop-accepted');
  });

  it('keeps a newer accepted-drop pulse when an older move is refused', async () => {
    const refusals: Array<(cause: Error) => void> = [];
    const onMoveChannel = vi.fn(() => new Promise<void>((_, reject) => {
      refusals.push(reject);
    }));
    renderSidebar({ onMoveChannel });
    const target = screen.getByRole('link', { name: 'Launch' });
    const transfer = (workstreamId: string) => ({
      dropEffect: 'none',
      getData: (type: string) => type === 'application/x-rally-workstream-id'
        ? workstreamId
        : type === 'application/x-rally-channel-source-space-id' ? 'general' : '',
      types: ['application/x-rally-workstream-id', 'application/x-rally-channel-source-space-id'],
    });

    fireEvent.drop(target, { dataTransfer: transfer('channel-1') });
    fireEvent.drop(target, { dataTransfer: transfer('channel-2') });
    expect(onMoveChannel).toHaveBeenCalledTimes(2);

    await act(async () => refusals[0]?.(new Error('first_refused')));
    expect(target).toHaveClass('is-channel-drop-accepted');

    await act(async () => refusals[1]?.(new Error('second_refused')));
    expect(target).not.toHaveClass('is-channel-drop-accepted');
  });

  it('rejects a move whose source Space is read-only', () => {
    const onMoveChannel = vi.fn(async () => undefined);
    const readOnly = { ...space('shared', 'Shared', 1), reach: 'through_channel' as const };
    renderSidebar({ onMoveChannel, selectedSpaceId: readOnly.id, spaces: [readOnly, space('launch', 'Launch', 1)] });
    const target = screen.getByRole('link', { name: 'Launch' });
    const transfer = {
      dropEffect: 'none',
      getData: (type: string) => type === 'application/x-rally-workstream-id'
        ? 'channel-1'
        : type === 'application/x-rally-channel-source-space-id' ? readOnly.id : '',
      types: ['application/x-rally-workstream-id', 'application/x-rally-channel-source-space-id'],
    };

    fireEvent.drop(target, { dataTransfer: transfer });

    expect(onMoveChannel).not.toHaveBeenCalled();
    expect(transfer.dropEffect).toBe('none');
  });

  it('rechecks the selected Space when the Channel is dropped', () => {
    const onMoveChannel = vi.fn(async () => undefined);
    renderSidebar({ onMoveChannel, selectedSpaceId: 'launch' });
    const transfer = {
      dropEffect: 'none',
      getData: (type: string) => type === 'application/x-rally-workstream-id'
        ? 'channel-1'
        : type === 'application/x-rally-channel-source-space-id' ? 'general' : '',
      types: ['application/x-rally-workstream-id', 'application/x-rally-channel-source-space-id'],
    };

    fireEvent.drop(screen.getByRole('link', { name: 'Launch' }), { dataTransfer: transfer });

    expect(onMoveChannel).not.toHaveBeenCalled();
    expect(transfer.dropEffect).toBe('none');
  });

  it('shows placeholder rows instead of an empty directory while loading', () => {
    renderSidebar({ loading: true, spaces: [] });

    expect(screen.queryByText('No spaces yet')).not.toBeInTheDocument();
    expect(document.querySelectorAll('.spaces-sidebar .skeleton-row')).toHaveLength(4);
  });

  it('keeps the square Space marks when compact and can be expanded again', () => {
    const { onCollapsedChange } = renderSidebar({ collapsed: true });
    const sidebar = screen.getByRole('complementary', { name: 'Spaces sidebar' });

    expect(sidebar).toHaveClass('is-compact');
    expect(sidebar.querySelectorAll('.spaces-sidebar-mark')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Expand spaces' }));
    expect(onCollapsedChange).toHaveBeenCalledWith(false);
  });

  it('uses the shared edge gesture to resize, collapse, and expand', () => {
    const { onCollapsedChange, onWidthChange } = renderSidebar();
    const sidebar = screen.getByRole('complementary', { name: 'Spaces sidebar' });
    vi.spyOn(sidebar, 'getBoundingClientRect').mockReturnValue({
      bottom: 900, height: 900, left: 0, right: 280, top: 0, width: 280, x: 0, y: 0,
      toJSON: () => ({}),
    });
    const handle = screen.getByRole('separator', { name: 'Resize spaces sidebar' });
    handle.setPointerCapture = vi.fn();
    expect(handle.querySelector('svg')).toHaveAttribute('width', '11');
    expect(handle.querySelector('svg')).toHaveAttribute('height', '11');
    expect(handle.querySelector('svg')).toHaveAttribute('stroke-width', '2');

    fireEvent.focus(handle);
    expect(screen.getByRole('tooltip')).toHaveTextContent('Drag to resize');
    expect(screen.getByRole('tooltip')).toHaveTextContent('Double-click or Enter to collapse');

    fireEvent.pointerDown(handle, { button: 0, clientX: 286, pointerId: 7 });
    expect(handle).toHaveFocus();
    expect(sidebar).toHaveClass('is-resizing');
    fireEvent.pointerMove(window, { clientX: 326, pointerId: 7 });
    expect(document.querySelector('.sidebar-drag-guide')).not.toBeNull();
    expect(onWidthChange).toHaveBeenCalledWith(320);
    fireEvent.pointerUp(window, { pointerId: 7 });
    expect(document.querySelector('.sidebar-drag-guide')).toBeNull();

    fireEvent.doubleClick(handle);
    expect(onCollapsedChange).toHaveBeenCalledWith(true);
  });

  it('uses the shared collapse thresholds and keyboard toggle', () => {
    const { onCollapsedChange, onWidthChange } = renderSidebar();
    const handle = screen.getByRole('separator', { name: 'Resize spaces sidebar' });

    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    expect(onWidthChange).toHaveBeenCalledWith(264);
    fireEvent.keyDown(handle, { key: 'Enter' });
    expect(onCollapsedChange).toHaveBeenCalledWith(true);

    const compact = renderSidebar({ collapsed: true });
    fireEvent.doubleClick(screen.getAllByRole('separator', { name: 'Resize spaces sidebar' })[1]!);
    expect(compact.onCollapsedChange).toHaveBeenCalledWith(false);
  });

  it('caps every expansion path at the width left by the full hierarchy', () => {
    const compact = renderSidebar({ availableWidth: 244, collapsed: true, width: 400 });
    const handle = screen.getByRole('separator', { name: 'Resize spaces sidebar' });

    fireEvent.doubleClick(handle);
    expect(compact.onWidthChange).toHaveBeenCalledWith(244);
    expect(compact.onCollapsedChange).toHaveBeenCalledWith(false);
  });

  it('keeps every expansion path disabled when the hierarchy cannot fit', () => {
    const compact = renderSidebar({ availableWidth: 180, collapsed: true, constrained: true });
    const handle = screen.getByRole('separator', { name: 'Resize spaces sidebar' });
    const footer = screen.getByRole('button', { name: 'Expand spaces' });

    expect(footer).toBeDisabled();
    fireEvent.doubleClick(handle);
    fireEvent.keyDown(handle, { key: 'Enter' });
    fireEvent.click(footer);
    expect(compact.onCollapsedChange).not.toHaveBeenCalled();
    expect(compact.onWidthChange).not.toHaveBeenCalled();
  });

  it('keeps stale rows visible and offers a refresh row without warning copy', () => {
    const onRetry = vi.fn();
    renderSidebar({ onRetry, outOfDate: true });

    expect(screen.getByRole('link', { name: 'General' })).toBeVisible();
    expect(screen.queryByText('These spaces may be out of date.')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('archives an editable Space from the row that represents it', async () => {
    const onArchive = vi.fn(async () => undefined);
    renderSidebar({ onArchive });

    fireEvent.contextMenu(screen.getByRole('link', { name: 'Launch' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Archive space' }));
    const dialog = await screen.findByRole('dialog', { name: 'Archive space?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Archive space' }));

    await waitFor(() => expect(onArchive).toHaveBeenCalledWith('launch'));
  });

  it('creates a Space from a right-click on empty list space', async () => {
    const onCreateSpace = vi.fn(async () => undefined);
    renderSidebar({ onCreateSpace });

    // A Space row keeps its own menu.
    fireEvent.contextMenu(screen.getByRole('link', { name: 'Launch' }));
    expect(await screen.findByRole('menuitem', { name: 'Archive space' })).toBeVisible();
    expect(screen.queryByRole('menuitem', { name: 'Create New Space' })).toBeNull();
    fireEvent.contextMenu(screen.getByRole('menuitem', { name: 'Archive space' }), { clientX: 70, clientY: 95 });
    expect(screen.queryByRole('menuitem', { name: 'Create New Space' })).toBeNull();
    fireEvent.keyDown(screen.getByRole('menuitem', { name: 'Archive space' }), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('menuitem', { name: 'Archive space' })).toBeNull());

    fireEvent.contextMenu(screen.getByRole('navigation', { name: 'Spaces' }), { clientX: 60, clientY: 400 });
    await screen.findByRole('menuitem', { name: 'Create New Space' });
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Create New Space']);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Create New Space' }));
    const dialog = await screen.findByRole('dialog', { name: 'Create a new space' });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Name of space' }), { target: { value: 'Hiring' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(onCreateSpace).toHaveBeenCalledWith('Hiring'));
  });

  it('restores an archived Space from the first rail', async () => {
    const onRestore = vi.fn(async () => undefined);
    renderSidebar({ inactiveSpaces: [space('archive', 'Archived', 0)], onRestore });

    fireEvent.click(screen.getByRole('button', { name: 'Restore archived space' }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Restore archived space' }))
      .getByRole('button', { name: 'Archived' }));

    await waitFor(() => expect(onRestore).toHaveBeenCalledWith('archive'));
  });

  it('owns the organization search and New Channel actions', () => {
    renderSidebar();

    expect(screen.getByRole('button', { name: 'Search organization' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'New channel or space' })).toBeVisible();
  });

  it('hands Create between the titlebar and compact command row with the old motion contract', () => {
    const props = {
      accountSlotRef: vi.fn(),
      availableWidth: 400,
      sidekickSlotRef: vi.fn(),
      currentPath: '/workstreams/current',
      inactiveSpaces: [],
      onMoveChannel: vi.fn(async () => undefined),
      onArchive: vi.fn(async () => undefined),
      onCollapsedChange: vi.fn(),
      onWidthChange: vi.fn(),
      constrained: false,
      onCreateChannel: vi.fn(async () => undefined),
      onCreateSpace: vi.fn(async () => undefined),
      onOrderPreviewChange: vi.fn(),
      onOpenSearch: vi.fn(),
      onReorder: vi.fn(async () => undefined),
      onRetry: vi.fn(),
      onRestore: vi.fn(async () => undefined),
      onSelect: vi.fn(),
      ordering: [],
      outOfDate: false,
      ready: true,
      selectedSpaceId: 'general',
      spaces: [space('general', 'General', 3)],
      workstreams: [],
      width: 280,
    };
    const { rerender } = render(<MemoryRouter><Tooltip.Provider>
      <SpacesSidebar scrollStateKey="test-spaces-scroll" {...props} collapsed={false} />
    </Tooltip.Provider></MemoryRouter>);

    const titlebar = document.querySelector('.spaces-sidebar-titlebar');
    const commandbar = document.querySelector('.spaces-sidebar-commandbar');
    expect(titlebar).toContainElement(screen.getByRole('button', { name: 'New channel or space' }));
    expect(commandbar?.querySelector('[data-motion-key="action:new"]')).toBeNull();

    rerender(<MemoryRouter><Tooltip.Provider>
      <SpacesSidebar scrollStateKey="test-spaces-scroll" {...props} collapsed />
    </Tooltip.Provider></MemoryRouter>);

    const compactCreate = within(commandbar as HTMLElement).getByRole('button', { name: 'New channel or space' });
    const compactSearch = within(commandbar as HTMLElement).getByRole('button', { name: 'Search organization' });
    expect(compactCreate).toHaveAttribute('data-motion-insert');
    expect(compactCreate.compareDocumentPosition(compactSearch) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(titlebar?.querySelector('.sidebar-new-button')).toHaveAttribute('aria-hidden', 'true');
    expect(within(titlebar as HTMLElement).queryByRole('button', { name: 'New channel or space' })).not.toBeInTheDocument();
  });

  it('names the compact creation and Search tooltips', async () => {
    renderSidebar({ collapsed: true });

    const create = screen.getByRole('button', { name: 'New channel or space' });
    fireEvent.focus(create);
    expect(await screen.findByRole('tooltip')).toHaveTextContent('New channel or space');
    fireEvent.blur(create);

    fireEvent.focus(screen.getByRole('button', { name: 'Search organization' }));
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Search');
  });

  it('offers a restart once the main process has downloaded an update', async () => {
    const listeners = new Set<(status: DesktopUpdateStatus) => void>();
    const installDownloadedUpdate = vi.fn(async () => undefined);
    updateBridge.current = {
      getUpdateStatus: async () => ({ kind: 'idle' }),
      onUpdateStatusChanged: (listener: (status: DesktopUpdateStatus) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      installDownloadedUpdate,
    };
    try {
      renderSidebar();
      await act(async () => undefined);
      expect(screen.queryByRole('button', { name: /Restart to update/u })).not.toBeInTheDocument();

      act(() => {
        for (const listener of listeners) listener({ kind: 'downloaded', version: '1.2.0' });
      });
      fireEvent.click(screen.getByRole('button', { name: 'Restart to update to Rally 1.2.0' }));

      expect(installDownloadedUpdate).toHaveBeenCalledOnce();
    } finally {
      updateBridge.current = null;
    }
  });
});
