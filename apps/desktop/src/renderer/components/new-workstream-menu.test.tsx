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

function renderMenu(callbacks = {
  onCreateChannel: vi.fn(async () => undefined),
  onCreateSpace: vi.fn(async () => undefined),
  onImportChannel: vi.fn(async () => undefined),
}) {
  render(<Tooltip.Provider>
    <NewWorkstreamMenu {...callbacks} spaces={[general]} onStart={vi.fn()}>
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
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Name of channel' }), { target: { value: 'Launch' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(callbacks.onCreateChannel).toHaveBeenCalledWith({ name: 'Launch', spaceId: general.id }));
  });

  it('selects the first Space when the directory arrives after the dialog opens', async () => {
    const callbacks = {
      onCreateChannel: vi.fn(async () => undefined),
      onCreateSpace: vi.fn(async () => undefined),
      onImportChannel: vi.fn(async () => undefined),
    };
    const view = render(<Tooltip.Provider>
      <NewWorkstreamMenu {...callbacks} spaces={[]} onStart={vi.fn()}>
        <button type="button">Plus</button>
      </NewWorkstreamMenu>
    </Tooltip.Provider>);
    fireEvent.keyDown(screen.getByRole('button', { name: 'Plus' }), { key: 'ArrowDown' });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Start a new channel' }));
    const dialog = screen.getByRole('dialog', { name: 'Start a new channel' });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Name of channel' }), { target: { value: 'Launch' } });
    expect(within(dialog).getByRole('button', { name: 'Create' })).toBeDisabled();

    view.rerender(<Tooltip.Provider>
      <NewWorkstreamMenu {...callbacks} spaces={[general]} onStart={vi.fn()}>
        <button type="button">Plus</button>
      </NewWorkstreamMenu>
    </Tooltip.Provider>);

    await waitFor(() => expect(within(dialog).getByRole('combobox', { name: 'Space' })).toHaveTextContent('General'));
    expect(within(dialog).getByRole('button', { name: 'Create' })).toBeEnabled();
  });

  it('collects the required import fields', async () => {
    const callbacks = renderMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Import channel from Claude or ChatGPT' }));
    const dialog = screen.getByRole('dialog', { name: 'Import channel from Claude or ChatGPT' });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Name of channel' }), { target: { value: 'Research' } });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'URL' }), { target: { value: 'https://chatgpt.com/share/example' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(callbacks.onImportChannel).toHaveBeenCalledWith({
      name: 'Research', spaceId: general.id, url: 'https://chatgpt.com/share/example',
    }));
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
