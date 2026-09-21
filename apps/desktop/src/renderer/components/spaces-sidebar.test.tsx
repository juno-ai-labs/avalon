import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import * as Tooltip from '@radix-ui/react-tooltip';
import type { SpaceSummary } from '@rally/contracts';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import { SpacesSidebar } from './spaces-sidebar';

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
  const onSelect = vi.fn();
  render(
    <MemoryRouter>
      <Tooltip.Provider>
        <SpacesSidebar
          accountSlotRef={vi.fn()}
          sidekickSlotRef={vi.fn()}
          collapsed={false}
          onCollapsedChange={onCollapsedChange}
          currentPath="/workstreams/current"
          inactiveSpaces={[]}
          onAddChannel={vi.fn(async () => undefined)}
          onArchive={vi.fn(async () => undefined)}
          onOpenSearch={vi.fn()}
          onCreateChannel={vi.fn(async () => undefined)}
          onCreateSpace={vi.fn(async () => undefined)}
          onImportChannel={vi.fn(async () => undefined)}
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
        />
      </Tooltip.Provider>
    </MemoryRouter>,
  );
  return { onCollapsedChange, onSelect };
}

describe('SpacesSidebar', () => {
  it('draws one navigation row per Space and selects the next level', () => {
    const { onSelect } = renderSidebar();

    expect(screen.getByRole('link', { name: 'General' })).toHaveClass('is-active');
    expect(screen.getByText('3 channels')).toBeVisible();
    fireEvent.click(screen.getByRole('link', { name: 'Launch' }));

    expect(onSelect).toHaveBeenCalledWith('launch');
  });

  it('describes the keyboard gesture that reorders Spaces', () => {
    renderSidebar();

    expect(screen.getByRole('navigation', { name: 'Spaces' }))
      .toHaveAccessibleDescription('Hold Alt and press the Up or Down Arrow key to reorder a space.');
  });

  it('does not accept a Channel drop on a read-only Space', () => {
    const onAddChannel = vi.fn(async () => undefined);
    const readOnly = { ...space('shared', 'Shared', 1), reach: 'through_channel' as const };
    renderSidebar({ onAddChannel, spaces: [readOnly] });
    const row = screen.getByRole('link', { name: 'Shared' });
    const transfer = {
      dropEffect: 'none',
      getData: (type: string) => type === 'application/x-rally-workstream-id' ? 'channel-1' : '',
      types: ['application/x-rally-workstream-id'],
    };

    const over = new Event('dragover', { bubbles: true, cancelable: true });
    Object.defineProperty(over, 'dataTransfer', { value: transfer });
    row.dispatchEvent(over);
    fireEvent.drop(row, { dataTransfer: transfer });

    expect(over.defaultPrevented).toBe(false);
    expect(onAddChannel).not.toHaveBeenCalled();
  });

  it('marks a Channel placement drop as a copy rather than a source reorder', () => {
    renderSidebar();
    const row = screen.getByRole('link', { name: 'Launch' });
    const transfer = {
      dropEffect: 'none',
      types: ['application/x-rally-workstream-id'],
    };
    const over = new Event('dragover', { bubbles: true, cancelable: true });
    Object.defineProperty(over, 'dataTransfer', { value: transfer });

    row.dispatchEvent(over);

    expect(over.defaultPrevented).toBe(true);
    expect(transfer.dropEffect).toBe('copy');
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

  it('keeps stale rows visible and offers the directory retry', () => {
    const onRetry = vi.fn();
    renderSidebar({ onRetry, outOfDate: true });

    expect(screen.getByRole('link', { name: 'General' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
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
    expect(screen.getByRole('button', { name: 'New channel' })).toBeVisible();
  });

  it('hands Create between the titlebar and compact command row with the old motion contract', () => {
    const props = {
      accountSlotRef: vi.fn(),
      sidekickSlotRef: vi.fn(),
      currentPath: '/workstreams/current',
      inactiveSpaces: [],
      onAddChannel: vi.fn(async () => undefined),
      onArchive: vi.fn(async () => undefined),
      onCollapsedChange: vi.fn(),
      onCreateChannel: vi.fn(async () => undefined),
      onCreateSpace: vi.fn(async () => undefined),
      onImportChannel: vi.fn(async () => undefined),
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
    };
    const { rerender } = render(<MemoryRouter><Tooltip.Provider>
      <SpacesSidebar {...props} collapsed={false} />
    </Tooltip.Provider></MemoryRouter>);

    const titlebar = document.querySelector('.spaces-sidebar-titlebar');
    const commandbar = document.querySelector('.spaces-sidebar-commandbar');
    expect(titlebar).toContainElement(screen.getByRole('button', { name: 'New channel' }));
    expect(commandbar?.querySelector('[data-motion-key="action:new"]')).toBeNull();

    rerender(<MemoryRouter><Tooltip.Provider>
      <SpacesSidebar {...props} collapsed />
    </Tooltip.Provider></MemoryRouter>);

    const compactCreate = within(commandbar as HTMLElement).getByRole('button', { name: 'New channel' });
    const compactSearch = within(commandbar as HTMLElement).getByRole('button', { name: 'Search organization' });
    expect(compactCreate).toHaveAttribute('data-motion-insert');
    expect(compactCreate.compareDocumentPosition(compactSearch) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(titlebar?.querySelector('.sidebar-new-button')).toHaveAttribute('aria-hidden', 'true');
    expect(within(titlebar as HTMLElement).queryByRole('button', { name: 'New channel' })).not.toBeInTheDocument();
  });
});
