import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { SpaceSummarySchema } from '@rally/contracts';
import * as Tooltip from '@radix-ui/react-tooltip';
import { describe, expect, it, vi } from 'vitest';

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
  onImportChannel: (input: { clientMessageId: string; name: string; spaceId: string; url: string }) => Promise<void>;
};

function renderMenu(callbacks: MenuCallbacks = {
  onCreateChannel: vi.fn(async () => undefined),
  onCreateSpace: vi.fn(async () => undefined),
  onImportChannel: vi.fn(async () => undefined),
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
  it('offers the three consolidated creation choices', () => {
    renderMenu();
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      'Start a new channel',
      'Import channel from Claude or ChatGPT',
      'Create a new space',
    ]);
  });

  it('collects a Space and Channel name before continuing to the composer', async () => {
    const callbacks = renderMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Start a new channel' }));
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
      onImportChannel: vi.fn(async () => undefined),
    };
    const view = render(<Tooltip.Provider>
      <NewWorkstreamMenu {...callbacks} spaces={[general, planning]}>
        <button type="button">Plus</button>
      </NewWorkstreamMenu>
    </Tooltip.Provider>);
    fireEvent.keyDown(screen.getByRole('button', { name: 'Plus' }), { key: 'ArrowDown' });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Start a new channel' }));
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
        onImportChannel={vi.fn(async () => undefined)}
        spaces={[reachedThroughChannel, general]}
      >
        <button type="button">Plus</button>
      </NewWorkstreamMenu>
    </Tooltip.Provider>);
    fireEvent.keyDown(screen.getByRole('button', { name: 'Plus' }), { key: 'ArrowDown' });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Start a new channel' }));
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
        onImportChannel={vi.fn(async () => undefined)}
        spaces={[]}
      >
        <button type="button">Plus</button>
      </NewWorkstreamMenu>
    </Tooltip.Provider>);
    expect(screen.getByRole('button', { name: 'Plus' })).toBeDisabled();
  });

  it('collects the required import fields', async () => {
    const callbacks = renderMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Import channel from Claude or ChatGPT' }));
    const dialog = screen.getByRole('dialog', { name: 'Import channel from Claude or ChatGPT' });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Name of channel' }), { target: { value: 'Research' } });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'URL' }), { target: { value: 'https://chatgpt.com/share/example' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(callbacks.onImportChannel).toHaveBeenCalledWith(expect.objectContaining({
      clientMessageId: expect.any(String), name: 'Research', spaceId: general.id, url: 'https://chatgpt.com/share/example',
    })));
  });

  it('surfaces import errors and reuses the request identity for an unchanged retry', async () => {
    const onImportChannel = vi.fn(async (input: {
      clientMessageId: string; name: string; spaceId: string; url: string;
    }) => { void input; throw new Error('This Claude URL requires sign-in.'); });
    renderMenu({
      onCreateChannel: vi.fn(async () => undefined),
      onCreateSpace: vi.fn(async () => undefined),
      onImportChannel,
    });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Import channel from Claude or ChatGPT' }));
    const dialog = screen.getByRole('dialog', { name: 'Import channel from Claude or ChatGPT' });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Name of channel' }), { target: { value: 'Research' } });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'URL' }), { target: { value: 'https://claude.ai/share/example' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
    await screen.findByText('This Claude URL requires sign-in.');
    const firstRequestId = onImportChannel.mock.calls[0]?.[0].clientMessageId;

    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(onImportChannel).toHaveBeenCalledTimes(2));
    expect(onImportChannel.mock.calls[1]?.[0].clientMessageId).toBe(firstRequestId);
  });

  it('keeps the form locked while creation is in flight', async () => {
    let resolveCreate: (() => void) | undefined;
    const callbacks = renderMenu({
      onCreateChannel: vi.fn(() => new Promise<void>((resolve) => { resolveCreate = resolve; })),
      onCreateSpace: vi.fn(async () => undefined),
      onImportChannel: vi.fn(async () => undefined),
    });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Start a new channel' }));
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
    fireEvent.click(screen.getByRole('menuitem', { name: 'Create a new space' }));
    const dialog = screen.getByRole('dialog', { name: 'Create a new space' });
    expect(within(dialog).queryByRole('combobox', { name: 'Space' })).not.toBeInTheDocument();
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Name of space' }), { target: { value: 'Planning' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(callbacks.onCreateSpace).toHaveBeenCalledWith('Planning'));
  });
});
