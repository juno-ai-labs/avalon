import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { SpaceSummarySchema } from '@rally/contracts';
import * as Tooltip from '@radix-ui/react-tooltip';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { NewWorkstreamMenu, type ChannelImportInput } from './new-workstream-menu';

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
  onImportChannel: (input: ChannelImportInput) => Promise<void>;
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
  afterEach(() => vi.unstubAllGlobals());
  it('offers the three consolidated creation choices', () => {
    renderMenu();
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      'Start New Channel',
      'Import Channel from Claude or ChatGPT',
      'Create New Space',
    ]);
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
      onImportChannel: vi.fn(async () => undefined),
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
        onImportChannel={vi.fn(async () => undefined)}
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
    fireEvent.click(screen.getByRole('menuitem', { name: 'Import Channel from Claude or ChatGPT' }));
    const dialog = screen.getByRole('dialog', { name: 'Import channel from Claude or ChatGPT' });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Name of channel' }), { target: { value: 'Research' } });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'URL' }), { target: { value: 'https://chatgpt.com/share/example' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(callbacks.onImportChannel).toHaveBeenCalledWith(expect.objectContaining({
      clientMessageId: expect.any(String), name: 'Research', spaceId: general.id,
      source: { kind: 'link', url: 'https://chatgpt.com/share/example' },
    })));
  });

  it('offers local Claude chats without a data-export source', () => {
    renderMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Import Channel from Claude or ChatGPT' }));
    const dialog = screen.getByRole('dialog', { name: 'Import channel from Claude or ChatGPT' });
    expect(within(dialog).getByRole('combobox', { name: 'Source' })).toHaveTextContent('Claude chats on this Mac');
    expect(within(dialog).getByRole('combobox', { name: 'Source' })).not.toHaveTextContent('Claude data export');
  });

  it('passes a selected Claude Code JSONL file to the import decoder', async () => {
    const callbacks = renderMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Import Channel from Claude or ChatGPT' }));
    const dialog = screen.getByRole('dialog', { name: 'Import channel from Claude or ChatGPT' });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Name of channel' }), { target: { value: 'Code history' } });
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Source' }), { target: { value: 'claude_code' } });
    const line = JSON.stringify({ type: 'user', message: { role: 'user', content: 'Fix this' } });
    const file = new File([line], 'session.jsonl', { type: 'application/json' });
    Object.defineProperty(file, 'text', { value: async () => line });
    fireEvent.change(within(dialog).getByLabelText('Or choose a conversation file'), { target: { files: [file] } });
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Create' })).toBeEnabled());
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(callbacks.onImportChannel).toHaveBeenCalledWith(expect.objectContaining({
      source: { kind: 'export', provider: 'claude_code', text: line },
    })));
  });

  it('lists local Code conversations and imports only the selected transcript', async () => {
    const selected = JSON.stringify({ type: 'user', sessionId: 'second', uuid: 'u2', message: { role: 'user', content: 'Second session' } });
    const longTitle = 'Investigate the customer onboarding flow across every regional and desktop entry point';
    const longProject = '-Users-contributor-01-codex-worktrees-long-project-name';
    const listLocalClaudeCodeSessions = vi.fn(async () => [
      { id: 'project/first.jsonl', title: 'First', project: 'project', updatedAt: 2 },
      { id: 'project/second.jsonl', title: longTitle, project: longProject, updatedAt: 1 },
    ]);
    const readLocalClaudeCodeSession = vi.fn(async (id: string) => id.endsWith('second.jsonl') ? selected : 'wrong source');
    vi.stubGlobal('rally', { listLocalClaudeCodeSessions, readLocalClaudeCodeSession });
    const callbacks = renderMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Import Channel from Claude or ChatGPT' }));
    const dialog = screen.getByRole('dialog', { name: 'Import channel from Claude or ChatGPT' });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Name of channel' }), { target: { value: 'Chosen code' } });
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Source' }), { target: { value: 'claude_code' } });
    const conversation = await within(dialog).findByRole('combobox', { name: 'Conversation' });
    expect(within(conversation).getByRole('option', { name: /Investigate/ }).textContent!.length).toBeLessThan(65);
    expect(within(conversation).getByRole('option', { name: /Investigate/ }).textContent).not.toContain('second.jsonl');
    fireEvent.change(conversation, { target: { value: 'project/second.jsonl' } });
    expect(conversation).toHaveAttribute('title', longTitle);
    expect(dialog.querySelector('.session-import-selection-detail')).toBeNull();
    expect(within(conversation).getByRole('option', { name: /Investigate/ }).textContent).not.toContain(longProject);
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Create' })).toBeEnabled());
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(callbacks.onImportChannel).toHaveBeenCalledWith(expect.objectContaining({
      source: { kind: 'export', provider: 'claude_code', text: selected },
    })));
    expect(readLocalClaudeCodeSession).toHaveBeenCalledTimes(1);
    expect(readLocalClaudeCodeSession).toHaveBeenCalledWith('project/second.jsonl');
  });

  it('lists Claude chats and Cowork tasks using their familiar titles', async () => {
    const chat = JSON.stringify({ uuid: 'b0e003e5-ffb8-4058-ac46-ee5b10b8150a', chat_messages: [{ uuid: 'first', sender: 'human', text: 'Navigation?' }] });
    let sessions = [
      { id: 'b0e003e5-ffb8-4058-ac46-ee5b10b8150a', kind: 'chat', title: 'Apple HIG navigation hierarchy', updatedAt: 2, sourceSessionId: 'b0e003e5-ffb8-4058-ac46-ee5b10b8150a' },
      { id: 'cowork:local_task', kind: 'cowork', title: 'Andrew Ng call lookup', updatedAt: 1, sourceSessionId: 'cli-session' },
    ];
    const listLocalClaudeSessions = vi.fn(async () => sessions);
    let selectedText = chat;
    const readLocalClaudeSession = vi.fn(async () => ({ provider: 'claude' as const, text: selectedText }));
    let foregroundChanged: ((foregrounded: boolean) => void) | undefined;
    const onApplicationForegroundChanged = vi.fn((listener: (foregrounded: boolean) => void) => {
      foregroundChanged = listener;
      return () => { foregroundChanged = undefined; };
    });
    vi.stubGlobal('rally', { listLocalClaudeSessions, readLocalClaudeSession, onApplicationForegroundChanged });
    const callbacks = renderMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Import Channel from Claude or ChatGPT' }));
    const dialog = screen.getByRole('dialog', { name: 'Import channel from Claude or ChatGPT' });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Name of channel' }), { target: { value: 'Navigation' } });
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Source' }), { target: { value: 'claude_local' } });
    const conversation = await within(dialog).findByRole('combobox', { name: 'Conversation' });
    expect(within(conversation).getAllByRole('option').map((option) => option.textContent)).toEqual([
      'Select a Claude conversation', 'Apple HIG navigation hierarchy', 'Andrew Ng call lookup',
    ]);
    expect(within(dialog).getByText('Claude saves only some chats locally. If the desired chat isn’t shown, open it in the Claude app again')).toBeInTheDocument();
    sessions = [...sessions, { id: 'ee7f9de9-96c1-4110-9c27-9b77e907d86f', kind: 'chat', title: 'Newly opened chat', updatedAt: 3, sourceSessionId: 'ee7f9de9-96c1-4110-9c27-9b77e907d86f' }];
    foregroundChanged?.(true);
    await waitFor(() => expect(within(conversation).getByRole('option', { name: 'Newly opened chat' })).toBeInTheDocument());
    expect(listLocalClaudeSessions).toHaveBeenCalledTimes(2);
    fireEvent.change(conversation, { target: { value: 'b0e003e5-ffb8-4058-ac46-ee5b10b8150a' } });
    expect(dialog.querySelector('.session-import-selection-detail')).toBeNull();
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Create' })).toBeEnabled());
    selectedText = JSON.stringify({ uuid: 'b0e003e5-ffb8-4058-ac46-ee5b10b8150a', chat_messages: [{ uuid: 'first', sender: 'human', text: 'Updated navigation?' }] });
    foregroundChanged?.(true);
    await waitFor(() => expect(readLocalClaudeSession).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Create' })).toBeEnabled());
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(callbacks.onImportChannel).toHaveBeenCalledWith(expect.objectContaining({
      source: { kind: 'export', provider: 'claude', text: selectedText },
    })));
    expect(readLocalClaudeSession).toHaveBeenCalledWith('b0e003e5-ffb8-4058-ac46-ee5b10b8150a');
  });

  it('surfaces import errors and reuses the request identity for an unchanged retry', async () => {
    const onImportChannel = vi.fn(async (input: ChannelImportInput) => { void input; throw new Error('This Claude URL requires sign-in.'); });
    renderMenu({
      onCreateChannel: vi.fn(async () => undefined),
      onCreateSpace: vi.fn(async () => undefined),
      onImportChannel,
    });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Import Channel from Claude or ChatGPT' }));
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
