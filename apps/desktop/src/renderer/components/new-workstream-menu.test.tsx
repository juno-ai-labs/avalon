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
  onCreateChannel: (input: { name: string; spaceId: string }) => Promise<void>;
  onCreateSpace: (name: string) => Promise<void>;
};

function renderMenu(callbacks: MenuCallbacks = {
  onCreateChannel: vi.fn(async () => undefined),
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
      <NewWorkstreamMenu onCreateChannel={vi.fn(async () => undefined)} onCreateSpace={vi.fn(async () => undefined)} spaces={[general]}>
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

  it('collects a Space and Channel name before continuing to the composer', async () => {
    const callbacks = renderMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Start New Channel' }));
    const dialog = screen.getByRole('dialog', { name: 'Start a new channel' });
    expect(within(dialog).getByRole('combobox', { name: 'Space' })).toHaveTextContent('General');
    expect(within(dialog).queryByRole('textbox', { name: 'URL' })).not.toBeInTheDocument();
    const name = within(dialog).getByRole('textbox', { name: 'Name of channel' });
    expect(name).toHaveAttribute('maxlength', '180');
    fireEvent.change(name, { target: { value: 'Launch' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(callbacks.onCreateChannel).toHaveBeenCalledWith({ name: 'Launch', spaceId: general.id }));
  });

  it('repairs a selection when the live directory removes its Space', async () => {
    const callbacks = {
      onCreateChannel: vi.fn(async () => undefined),
      onCreateSpace: vi.fn(async () => undefined),
    };
    const view = render(<Tooltip.Provider>
      <NewWorkstreamMenu {...callbacks} spaces={[general, planning]}>
        <button type="button">Plus</button>
      </NewWorkstreamMenu>
    </Tooltip.Provider>);
    fireEvent.keyDown(screen.getByRole('button', { name: 'Plus' }), { key: 'ArrowDown' });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Start New Channel' }));
    const dialog = screen.getByRole('dialog', { name: 'Start a new channel' });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Name of channel' }), { target: { value: 'Launch' } });
    expect(within(dialog).getByRole('combobox', { name: 'Space' })).toHaveTextContent('General');

    view.rerender(<Tooltip.Provider>
      <NewWorkstreamMenu {...callbacks} spaces={[planning]}>
        <button type="button">Plus</button>
      </NewWorkstreamMenu>
    </Tooltip.Provider>);

    await waitFor(() => expect(within(dialog).getByRole('combobox', { name: 'Space' })).toHaveTextContent('Planning'));
    expect(within(dialog).getByRole('button', { name: 'Create' })).toBeEnabled();
  });

  it('omits Spaces reached only through a shared Channel', () => {
    render(<Tooltip.Provider>
      <NewWorkstreamMenu
        onCreateChannel={vi.fn(async () => undefined)}
        onCreateSpace={vi.fn(async () => undefined)}
        spaces={[reachedThroughChannel, general]}
      >
        <button type="button">Plus</button>
      </NewWorkstreamMenu>
    </Tooltip.Provider>);
    fireEvent.keyDown(screen.getByRole('button', { name: 'Plus' }), { key: 'ArrowDown' });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Start New Channel' }));
    const select = screen.getByRole('combobox', { name: 'Space' });
    expect(select).toHaveTextContent('General');
    fireEvent.click(select);
    expect(screen.queryByRole('option', { name: 'Shared project' })).not.toBeInTheDocument();
  });

  it('disables the launcher while Space capabilities are unavailable', () => {
    render(<Tooltip.Provider>
      <NewWorkstreamMenu
        canCreateSpace={false}
        onCreateChannel={vi.fn(async () => undefined)}
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
    expect(openBrowserImport).toHaveBeenCalledWith({ spaces: [{ id: general.id, name: 'General' }] });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(callbacks.onCreateChannel).not.toHaveBeenCalled();
  });

  it('keeps the form locked while creation is in flight', async () => {
    let resolveCreate: (() => void) | undefined;
    const callbacks = renderMenu({
      onCreateChannel: vi.fn(() => new Promise<void>((resolve) => { resolveCreate = resolve; })),
      onCreateSpace: vi.fn(async () => undefined),
    });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Start New Channel' }));
    const dialog = screen.getByRole('dialog', { name: 'Start a new channel' });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Name of channel' }), { target: { value: 'Launch' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(callbacks.onCreateChannel).toHaveBeenCalledTimes(1));
    expect(within(dialog).getByRole('button', { name: 'Creating…' })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled();

    resolveCreate?.();
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Start a new channel' })).not.toBeInTheDocument());
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
