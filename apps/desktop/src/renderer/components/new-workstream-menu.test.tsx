import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { SpaceSummarySchema } from '@rally/contracts';
import * as Tooltip from '@radix-ui/react-tooltip';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { NewWorkstreamMenu } from './new-workstream-menu';

const general = SpaceSummarySchema.parse({
  id: '00000000-0000-7000-8000-0000000000f0',
  name: 'General',
  iconKey: 'briefcase',
  colorKey: 'blue',
  scope: 'workspace',
  status: 'active',
  systemRole: 'general',
  revision: 1,
  reach: 'organization',
  participants: [],
  channelCount: 0,
  defaultResourceIds: [],
  defaultSidekickIds: [],
  createdAt: '2026-09-20T00:00:00.000Z',
  updatedAt: '2026-09-20T00:00:00.000Z',
});
const planning = SpaceSummarySchema.parse({
  ...general,
  id: '00000000-0000-7000-8000-0000000000f1',
  name: 'Planning',
  systemRole: null,
});
const reachedThroughChannel = SpaceSummarySchema.parse({
  ...planning,
  id: '00000000-0000-7000-8000-0000000000f2',
  name: 'Shared project',
  reach: 'through_channel',
});

type MenuCallbacks = {
  onCreateChannel: (input: { spaceId: string }) => void;
  onCreateSpace: (name: string) => Promise<void>;
};

function renderMenu(callbacks: MenuCallbacks = {
  onCreateChannel: vi.fn(),
  onCreateSpace: vi.fn(async () => undefined),
}) {
  render(<Tooltip.Provider>
    <NewWorkstreamMenu {...callbacks} spaces={[general]}>
      <button type="button">Plus</button>
    </NewWorkstreamMenu>
  </Tooltip.Provider>);
  fireEvent.keyDown(screen.getByRole('button', { name: 'Plus' }), { key: 'ArrowDown' });
  return callbacks;
}

describe('sidebar creation menu', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('offers import only where Rally has a browser to import through', () => {
    vi.stubGlobal('rally', { openBrowserImport: vi.fn(async () => undefined) });
    const desktop = render(<Tooltip.Provider>
      <NewWorkstreamMenu onCreateChannel={vi.fn()} onCreateSpace={vi.fn(async () => undefined)} spaces={[general]}>
        <button type="button">Plus</button>
      </NewWorkstreamMenu>
    </Tooltip.Provider>);
    fireEvent.keyDown(screen.getByRole('button', { name: 'Plus' }), { key: 'ArrowDown' });
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      'Start New Channel',
      'Import Channel from Claude or ChatGPT',
      'Create New Space',
    ]);
    desktop.unmount();
    vi.unstubAllGlobals();
    renderMenu();
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Start New Channel', 'Create New Space']);
  });

  // The new-Channel screen names and places the Channel beside its composer,
  // so starting one opens it at once rather than asking first.
  it('starts a Channel without a dialog, in All when no Space is locked', () => {
    const callbacks = renderMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Start New Channel' }));
    expect(callbacks.onCreateChannel).toHaveBeenCalledWith({ spaceId: general.id });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('starts in All whatever order the Spaces arrive in', () => {
    const onCreateChannel = vi.fn();
    const accounts = SpaceSummarySchema.parse({ ...planning, id: '00000000-0000-7000-8000-0000000000f3', name: 'Accounts' });
    render(<Tooltip.Provider>
      <NewWorkstreamMenu onCreateChannel={onCreateChannel} onCreateSpace={vi.fn(async () => undefined)}
        spaces={[planning, accounts, general]}>
        <button type="button">Plus</button>
      </NewWorkstreamMenu>
    </Tooltip.Provider>);
    fireEvent.keyDown(screen.getByRole('button', { name: 'Plus' }), { key: 'ArrowDown' });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Start New Channel' }));
    expect(onCreateChannel).toHaveBeenCalledWith({ spaceId: general.id });
  });

  it('starts a Channel in the Space the reader is looking at', async () => {
    const onCreateChannel = vi.fn();
    render(<Tooltip.Provider>
      <NewWorkstreamMenu lockedSpaceId={planning.id} offer="channel" spaces={[general, planning]} trigger="context"
        onCreateChannel={onCreateChannel} onCreateSpace={vi.fn(async () => undefined)}>
        <div data-testid="list" />
      </NewWorkstreamMenu>
    </Tooltip.Provider>);
    fireEvent.contextMenu(screen.getByTestId('list'), { clientX: 20, clientY: 20 });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Start New Channel' }));
    expect(onCreateChannel).toHaveBeenCalledWith({ spaceId: planning.id });
  });

  it('offers no Channel in a Space reached only through a shared Channel', () => {
    const onCreateChannel = vi.fn();
    render(<Tooltip.Provider>
      <NewWorkstreamMenu lockedSpaceId={reachedThroughChannel.id} offer="channel" trigger="direct"
        onCreateChannel={onCreateChannel} onCreateSpace={vi.fn(async () => undefined)}
        spaces={[reachedThroughChannel, general]}>
        <button type="button">Plus</button>
      </NewWorkstreamMenu>
    </Tooltip.Provider>);
    expect(screen.getByRole('button', { name: 'Plus' })).toBeDisabled();
  });

  it('disables the launcher while Space capabilities are unavailable', () => {
    render(<Tooltip.Provider>
      <NewWorkstreamMenu
        canCreateSpace={false}
        onCreateChannel={vi.fn()}
        onCreateSpace={vi.fn(async () => undefined)}
        spaces={[]}
      >
        <button type="button">Plus</button>
      </NewWorkstreamMenu>
    </Tooltip.Provider>);
    expect(screen.getByRole('button', { name: 'Plus' })).toBeDisabled();
  });

  it('opens the desktop import window with the placeable Spaces', () => {
    const openBrowserImport = vi.fn(async () => undefined);
    vi.stubGlobal('rally', { openBrowserImport });
    const callbacks = renderMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Import Channel from Claude or ChatGPT' }));
    expect(openBrowserImport).toHaveBeenCalledWith({ spaces: [{ id: general.id, name: 'All' }] });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(callbacks.onCreateChannel).not.toHaveBeenCalled();
  });

  it('creates a Space from its name alone', async () => {
    const callbacks = renderMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Create New Space' }));
    const dialog = screen.getByRole('dialog', { name: 'Create a new space' });
    expect(within(dialog).queryByRole('combobox', { name: 'Space' })).not.toBeInTheDocument();
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Name of space' }), { target: { value: 'Planning' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(callbacks.onCreateSpace).toHaveBeenCalledWith('Planning'));
  });
});
