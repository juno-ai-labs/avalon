import { createRef } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as Tooltip from '@radix-ui/react-tooltip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MentionIdentity } from '../lib/api';
import type { WorkspaceMember, WorkstreamDetail } from '../lib/types';
import type { PendingAttachment } from '../lib/use-file-attachments';
import { clearAllDrafts } from '../lib/draft-cache';
import { mentionOptionCopy } from '../test/mention-option-copy';
import { WorkstreamComposer } from './workstream-composer';

// The composer shows the work stream's model only while Application →
// Developer → Debug enabled is on, so this bridge is what turns it on and off.
const applicationSettings = vi.hoisted(() => ({
  current: { lockdownMode: false, lockdownAvailable: false, debugEnabled: false },
}));

vi.mock('../lib/platform', () => ({
  desktopBridge: () => ({
    getApplicationSettings: () => Promise.resolve(applicationSettings.current),
    onApplicationSettingsChanged: () => () => undefined,
  }),
}));

beforeEach(() => {
  clearAllDrafts();
  applicationSettings.current = { lockdownMode: false, lockdownAvailable: false, debugEnabled: false };
});
afterEach(() => vi.unstubAllGlobals());

const creator: WorkspaceMember = { id: 'user-1', name: 'Adam', email: 'adam@example.com', timezone: 'America/Los_Angeles' };
const bob: WorkspaceMember = { id: 'user-2', name: 'Bob Builder', email: 'bob@example.com', timezone: 'America/Los_Angeles' };
const cara: WorkspaceMember = { id: 'user-3', name: 'Cara Chen', email: 'cara@example.com', timezone: 'America/Los_Angeles' };

const workstream: WorkstreamDetail = {
  id: 'workstream-1',
  title: 'Investigate the release',
  titleStatus: 'settled' as const,
  harnessStatus: 'completed',
  scope: 'workspace' as const,
  lastActivityAt: '2026-07-31T20:00:00.000Z',
  latestAttentionSequenceNumber: 1,
  readThroughSequenceNumber: 1,
  manualUnreadFromSequenceNumber: null,
  manualUnreadGeneration: 0,
  hasUnread: false,
  firstUnreadSequenceNumber: null,
  nextPendingWakeup: null,
  pinPosition: null,
  participantUserIds: [],
  participantExtraCount: 0,
  createdAt: '2026-07-31T20:00:00.000Z',
  participants: [creator],
  viewers: [],
  resources: [],
  connections: [],
  backgroundTasks: [],
};

function renderComposer(
  onSend: (text: string, mentions: MentionIdentity[], confirmedParticipantUserIds?: string[]) => Promise<void> = vi.fn(async () => undefined),
  sending = false,
  onAttach: (files: FileList | File[]) => void = vi.fn(),
  detail: WorkstreamDetail = workstream,
  members: WorkspaceMember[] = [creator, bob, cara],
): ReturnType<typeof render> {
  vi.stubGlobal('ResizeObserver', class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  });
  return render(
    <Tooltip.Provider>
      <WorkstreamComposer
        attachments={[]}
        fileInputRef={createRef<HTMLInputElement>()}
        members={members}
        onAttach={onAttach}
        onOpenAttachment={() => undefined}
        onRemoveAttachment={() => undefined}
        onRetryAttachment={() => undefined}
        onSend={onSend}
        onStop={async () => undefined}
        sending={sending}
        uploading={false}
        workstream={detail}
      />
    </Tooltip.Provider>,
  );
}

describe('WorkstreamComposer over a remembered conversation', () => {
  it('lets a message be written but not sent while sending is blocked', () => {
    const onSend = vi.fn(async () => undefined);
    vi.stubGlobal('ResizeObserver', class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    });
    render(
      <Tooltip.Provider>
        <WorkstreamComposer
          attachments={[]}
          fileInputRef={createRef<HTMLInputElement>()}
          members={[creator]}
          onAttach={() => undefined}
          onOpenAttachment={() => undefined}
          onRemoveAttachment={() => undefined}
          onRetryAttachment={() => undefined}
          onSend={onSend}
          onStop={async () => undefined}
          sendBlocked
          sending={false}
          uploading={false}
          workstream={workstream}
        />
      </Tooltip.Provider>,
    );

    const composer = screen.getByLabelText('Message the work stream');
    fireEvent.change(composer, { target: { value: 'Half a thought' } });
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();
    fireEvent.keyDown(composer, { key: 'Enter' });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));

    expect(onSend).not.toHaveBeenCalled();
    expect(composer).toHaveValue('Half a thought');
  });
});

describe('WorkstreamComposer mention confirmation', () => {
  it('uses the compact GrokBot input chrome', () => {
    vi.stubGlobal('navigator', {
      mediaDevices: {
        addEventListener: vi.fn(),
        enumerateDevices: vi.fn(async () => [
          { deviceId: 'default', kind: 'audioinput', label: 'Default - MacBook Pro Microphone' },
          { deviceId: 'studio-mic', kind: 'audioinput', label: 'Studio microphone' },
        ]),
        removeEventListener: vi.fn(),
      },
    });
    render(
      <Tooltip.Provider>
        <WorkstreamComposer
          api={{ getTranscriptionSocketTicket: vi.fn() }}
          attachments={[]}
          fileInputRef={createRef<HTMLInputElement>()}
          members={[creator]}
          onAttach={() => undefined}
          onOpenAttachment={() => undefined}
          onRemoveAttachment={() => undefined}
          onRetryAttachment={() => undefined}
          onSend={async () => undefined}
          onStop={async () => undefined}
          sending={false}
          uploading={false}
          workstream={workstream}
        />
      </Tooltip.Provider>,
    );

    expect(document.querySelector('.workstream-composer')).toHaveClass('is-message-capsule');
    expect(screen.getByRole('button', { name: 'Composer actions' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Start voice input' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Choose microphone' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Mention a participant' })).not.toBeInTheDocument();
  });

  it('sends an attachment without requiring message text', async () => {
    const onSend = vi.fn(async () => undefined);
    const attachment: PendingAttachment = {
      localId: '019fcc00-0000-7000-8000-000000000001',
      file: new File(['hello'], 'notes.txt', { type: 'text/plain' }),
      progress: 100,
      status: 'ready',
      resource: {
        id: '019fcc00-0000-7000-8000-000000000001',
        title: 'notes.txt',
        resourceType: 'uploaded_file',
        provider: 'rally_upload',
        mimeType: 'text/plain',
        refreshSupported: false,
        watchEnabled: false,
        watchStatus: 'unsupported',
        contentAvailable: true,
        sizeBytes: 5,
        currentVersion: 1,
        relationshipType: 'attachment',
        direction: 'source',
      },
    };
    vi.stubGlobal('ResizeObserver', class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    });
    render(
      <Tooltip.Provider>
        <WorkstreamComposer
          attachments={[attachment]}
          fileInputRef={createRef<HTMLInputElement>()}
          members={[creator]}
          onAttach={() => undefined}
          onOpenAttachment={() => undefined}
          onRemoveAttachment={() => undefined}
          onRetryAttachment={() => undefined}
          onSend={onSend}
          onStop={async () => undefined}
          sending={false}
          uploading={false}
          workstream={workstream}
        />
      </Tooltip.Provider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(onSend).toHaveBeenCalledWith('', [], undefined, undefined));
  });

  it('clears immediately while a message is still being sent', async () => {
    let finishSend: (() => void) | undefined;
    const onSend = vi.fn(() => new Promise<void>((resolve) => {
      finishSend = resolve;
    }));
    renderComposer(onSend);

    const composer = screen.getByLabelText('Message the work stream');
    fireEvent.change(composer, { target: { value: 'Send this now' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));

    expect(onSend).toHaveBeenCalledWith('Send this now', [], undefined, undefined);
    expect(composer).toHaveValue('');
    finishSend?.();
  });

  it('accepts another message while an earlier submission is still pending', () => {
    const onSend = vi.fn(() => new Promise<void>(() => undefined));
    renderComposer(onSend, true);

    const composer = screen.getByLabelText('Message the work stream');
    fireEvent.change(composer, { target: { value: 'First queued message' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    fireEvent.change(composer, { target: { value: 'Second queued message' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));

    expect(onSend).toHaveBeenNthCalledWith(1, 'First queued message', [], undefined, undefined);
    expect(onSend).toHaveBeenNthCalledWith(2, 'Second queued message', [], undefined, undefined);
    expect(composer).toHaveValue('');
  });

  it('sends queue while a loop is running and does not offer a delivery dropdown', async () => {
    const onSend = vi.fn(async () => undefined);
    renderComposer(onSend, false, vi.fn(), { ...workstream, harnessStatus: 'running' });

    expect(screen.queryByRole('combobox', { name: 'Message delivery' })).not.toBeInTheDocument();
    const composer = screen.getByLabelText('Message the work stream');
    fireEvent.change(composer, { target: { value: 'After this run' } });
    fireEvent.keyDown(composer, { key: 'Enter' });
    await waitFor(() => expect(onSend).toHaveBeenCalledWith('After this run', [], undefined, 'queue'));
  });

  it('restores a failed message unless the user has started a new draft', async () => {
    const onSend = vi.fn(async () => {
      throw new Error('offline');
    });
    renderComposer(onSend);

    const composer = screen.getByLabelText('Message the work stream');
    fireEvent.change(composer, { target: { value: 'Please retry me' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));

    await waitFor(() => expect(composer).toHaveValue('Please retry me'));
  });

  it('does not replace a new draft when the previous send fails', async () => {
    let failSend: ((error: Error) => void) | undefined;
    const onSend = vi.fn(() => new Promise<void>((_resolve, reject) => {
      failSend = reject;
    }));
    renderComposer(onSend);

    const composer = screen.getByLabelText('Message the work stream');
    fireEvent.change(composer, { target: { value: 'First message' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    fireEvent.change(composer, { target: { value: 'New draft' } });
    failSend?.(new Error('offline'));

    await waitFor(() => expect(composer).toHaveValue('New draft'));
  });

  it('does not repeat participant controls above the in-workstream composer', () => {
    renderComposer();

    expect(screen.queryByLabelText('Work-stream participants')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add people' })).not.toBeInTheDocument();
  });

  it('filters functional slash commands and opens participant mentions from the keyboard', async () => {
    renderComposer();

    const composer = screen.getByLabelText('Message the work stream');
    fireEvent.change(composer, { target: { value: '/part' } });

    const commands = screen.getByRole('listbox', { name: 'Composer commands' });
    expect(commands).toBeVisible();
    expect(screen.getByRole('option', { name: /\/participants/u })).toBeVisible();
    expect(screen.queryByRole('option', { name: /\/attach/u })).not.toBeInTheDocument();

    fireEvent.keyDown(composer, { key: 'Enter' });

    await waitFor(() => expect(composer).toHaveValue('@'));
    expect(screen.getByRole('listbox', { name: 'Mentions' })).toBeVisible();
    expect(screen.queryByRole('listbox', { name: 'Composer commands' })).not.toBeInTheDocument();
  });

  it('does not let a composition-committing Enter run the slash command it is displaying', async () => {
    renderComposer();

    const composer = screen.getByLabelText('Message the work stream');
    fireEvent.change(composer, { target: { value: '/part' } });

    const commands = screen.getByRole('listbox', { name: 'Composer commands' });
    expect(commands).toBeVisible();

    fireEvent.keyDown(composer, { key: 'Enter', isComposing: true });
    expect(composer).toHaveValue('/part');
    expect(screen.queryByRole('listbox', { name: 'Mentions' })).not.toBeInTheDocument();
    // The command list is still standing: a blocked keystroke must leave the
    // composer exactly as the IME found it, not quietly dismiss what it shows.
    expect(screen.getByRole('listbox', { name: 'Composer commands' })).toBeVisible();

    fireEvent.keyDown(composer, { key: 'Enter', keyCode: 229 });
    expect(composer).toHaveValue('/part');
    expect(screen.queryByRole('listbox', { name: 'Mentions' })).not.toBeInTheDocument();
    expect(screen.getByRole('listbox', { name: 'Composer commands' })).toBeVisible();

    fireEvent.keyDown(composer, { key: 'Enter' });
    await waitFor(() => expect(composer).toHaveValue('@'));
  });

  it('does not let a composition-committing Tab run the slash command it is displaying', async () => {
    renderComposer();

    const composer = screen.getByLabelText('Message the work stream');
    fireEvent.change(composer, { target: { value: '/part' } });
    expect(screen.getByRole('listbox', { name: 'Composer commands' })).toBeVisible();

    // Tab picks a candidate in an IME's own window, and the command it would
    // otherwise run here can be `/stop`.
    fireEvent.keyDown(composer, { key: 'Tab', isComposing: true });
    expect(composer).toHaveValue('/part');
    expect(screen.getByRole('listbox', { name: 'Composer commands' })).toBeVisible();

    fireEvent.keyDown(composer, { key: 'Tab', keyCode: 229 });
    expect(composer).toHaveValue('/part');
    expect(screen.getByRole('listbox', { name: 'Composer commands' })).toBeVisible();

    fireEvent.keyDown(composer, { key: 'Tab' });
    await waitFor(() => expect(composer).toHaveValue('@'));
  });

  it('keeps the command list open when Escape is cancelling an IME candidate', () => {
    renderComposer();

    const composer = screen.getByLabelText('Message the work stream');
    fireEvent.change(composer, { target: { value: '/part' } });
    expect(screen.getByRole('listbox', { name: 'Composer commands' })).toBeVisible();

    fireEvent.keyDown(composer, { key: 'Escape', isComposing: true });
    expect(screen.getByRole('listbox', { name: 'Composer commands' })).toBeVisible();

    fireEvent.keyDown(composer, { key: 'Escape', keyCode: 229 });
    expect(screen.getByRole('listbox', { name: 'Composer commands' })).toBeVisible();

    fireEvent.keyDown(composer, { key: 'Escape' });
    expect(screen.queryByRole('listbox', { name: 'Composer commands' })).not.toBeInTheDocument();
  });

  it('confirms every mentioned nonparticipant together and sends their IDs without a preliminary add', async () => {
    const onSend = vi.fn(async () => undefined);
    renderComposer(onSend, false, undefined, { ...workstream, scope: 'personal' });

    fireEvent.change(screen.getByLabelText('Message the work stream'), {
      target: { value: 'Please ask @Bob Builder and @Cara Chen to review.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));

    expect(await screen.findByRole('heading', { name: 'Add participants?' })).toBeVisible();
    expect(screen.getByText('bob@example.com')).toBeVisible();
    expect(screen.getByText('cara@example.com')).toBeVisible();
    expect(screen.getByText(/If you do not add them, they will not be able to see the mentions or this work stream/u))
      .toBeVisible();
    expect(onSend).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Add all and mention' }));

    await waitFor(() => expect(onSend).toHaveBeenCalledWith(
      'Please ask @Bob Builder and @Cara Chen to review.',
      [],
      ['user-2', 'user-3'],
      undefined,
    ));
    expect(screen.getByLabelText('Message the work stream')).toHaveValue('');
  });

  it.each(['send button', 'Enter'] as const)(
    'warns before a nonparticipant mention in a personal work stream is submitted with %s',
    async (gesture) => {
      const onSend = vi.fn(async () => undefined);
      renderComposer(onSend, false, undefined, { ...workstream, scope: 'personal' });
      const composer = screen.getByLabelText('Message the work stream');
      fireEvent.change(composer, { target: { value: 'Please ask @Bob Builder.' } });

      if (gesture === 'Enter') fireEvent.keyDown(composer, { key: 'Enter' });
      else fireEvent.click(screen.getByRole('button', { name: 'Send message' }));

      expect(await screen.findByRole('heading', { name: 'Add participant?' })).toBeVisible();
      expect(screen.getByText(
        /If you do not add them, they will not be able to see the mention or this work stream/u,
      )).toBeVisible();
      expect(onSend).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole('button', { name: 'Add and mention' }));
      await waitFor(() => expect(onSend).toHaveBeenCalledWith(
        'Please ask @Bob Builder.',
        [],
        ['user-2'],
        undefined,
      ));
    },
  );

  it('does not block a workspace-visible work stream on participant status', async () => {
    const onSend = vi.fn(async () => undefined);
    renderComposer(onSend);
    fireEvent.change(screen.getByLabelText('Message the work stream'), {
      target: { value: 'Please ask @Bob Builder.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));

    await waitFor(() => expect(onSend).toHaveBeenCalledWith(
      'Please ask @Bob Builder.', [], undefined, undefined,
    ));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('does not treat a shorter prefix name as the person who was mentioned', async () => {
    const shortBob: WorkspaceMember = {
      id: 'user-4', name: 'Bob', email: 'short-bob@example.com', timezone: 'America/Los_Angeles',
    };
    renderComposer(
      vi.fn(async () => undefined),
      false,
      undefined,
      { ...workstream, scope: 'personal' },
      [creator, shortBob, bob],
    );

    fireEvent.change(screen.getByLabelText('Message the work stream'), {
      target: { value: 'Please ask @Bob Builder.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));

    expect(await screen.findByRole('heading', { name: 'Add participant?' })).toBeVisible();
    expect(screen.getByText('bob@example.com')).toBeVisible();
    expect(screen.queryByText('short-bob@example.com')).not.toBeInTheDocument();
  });

  it('opens mentions by typing at the caret without a dedicated mention button', async () => {
    renderComposer();
    const composer = screen.getByLabelText('Message the work stream');

    fireEvent.change(composer, {
      target: { value: 'ask @ about the release', selectionStart: 5, selectionEnd: 5 },
    });

    expect(screen.queryByRole('button', { name: 'Mention a participant' })).not.toBeInTheDocument();
    expect(screen.getByRole('listbox', { name: 'Mentions' })).toBeVisible();
  });

  it('keeps Escape from travelling on when it dismissed something here', async () => {
    renderComposer();
    const composer = screen.getByLabelText('Message the work stream');

    fireEvent.change(composer, { target: { value: '@' } });
    await screen.findAllByRole('option');

    // `fireEvent` returns false when the handler cancelled the event, which is
    // what the other two composers already did with a dismissing Escape.
    expect(fireEvent.keyDown(composer, { key: 'Escape' })).toBe(false);
    expect(screen.queryByRole('listbox', { name: 'Mentions' })).not.toBeInTheDocument();
    // Nothing left to dismiss: this one belongs to whatever else is listening.
    expect(fireEvent.keyDown(composer, { key: 'Escape' })).toBe(true);
  });

  it('inserts one space when the line already continues after the caret', async () => {
    renderComposer();
    const composer = screen.getByLabelText('Message the work stream');

    fireEvent.change(composer, {
      target: { value: 'ask @Bo about the release', selectionStart: 7, selectionEnd: 7 },
    });
    await screen.findAllByRole('option');
    fireEvent.keyDown(composer, { key: 'Enter' });

    await waitFor(() => expect(composer).toHaveValue('ask @Bob Builder about the release'));
  });

  it('leaves a non-active membership out of the list it can be mentioned from', async () => {
    renderComposer(undefined, false, undefined, workstream, [
      creator,
      { ...bob, status: 'invited' },
      { ...cara, status: 'suspended' },
    ]);
    const composer = screen.getByLabelText('Message the work stream');

    fireEvent.change(composer, { target: { value: '@' } });

    // Mentioning one adds them to the work stream, and the endpoint refuses a
    // membership that is not active — the participants rail already filters for
    // exactly this reason.
    const options = await screen.findAllByRole('option');
    expect(options.map(mentionOptionCopy)).toEqual([
      { badge: 'Bot', description: null, label: 'Rally' },
      { badge: 'Person', description: 'adam@example.com', label: 'Adam' },
    ]);
  });

  it('offers Rally and people, leaving connections out of the list and highlight', async () => {
    const connected: WorkstreamDetail = {
      ...workstream,
      connections: [{
        id: 'connection-slack',
        modelPluginId: 'plugin_slack',
        connectorType: 'slack',
        displayName: 'Slack',
        scope: 'workspace',
        status: 'healthy',
      }],
    };
    renderComposer(undefined, false, undefined, connected);
    const composer = screen.getByLabelText('Message the work stream');

    fireEvent.change(composer, { target: { value: '@' } });

    const options = await screen.findAllByRole('option');
    expect(options.map(mentionOptionCopy)).toEqual([
      { badge: 'Bot', description: null, label: 'Rally' },
      { badge: 'Person', description: 'adam@example.com', label: 'Adam' },
      { badge: 'Person', description: 'bob@example.com · not participating', label: 'Bob Builder' },
      { badge: 'Person', description: 'cara@example.com · not participating', label: 'Cara Chen' },
    ]);
    expect(options[0]).toHaveAccessibleName('Rally — Ask Rally to join this part of the conversation — Bot');
    expect(options[1]).toHaveAccessibleName('Adam — adam@example.com — Person');
    expect(options[2]).toHaveAccessibleName('Bob Builder — bob@example.com · not participating — Person');
    expect(options[3]).toHaveAccessibleName('Cara Chen — cara@example.com · not participating — Person');
    expect(screen.queryByText('Workspace connection')).not.toBeInTheDocument();

    // The draft's highlight names what the composer can mention, so a
    // connection typed into it by hand stays plain text too.
    fireEvent.change(composer, { target: { value: 'ask @Slack and @Adam' } });

    expect([...document.querySelectorAll('.composer-mention')].map((mark) => mark.textContent)).toEqual(['@Adam']);
  });

  it('walks the mention list with the arrow keys and inserts the highlighted candidate on Enter', async () => {
    const onSend = vi.fn(async () => undefined);
    renderComposer(onSend);
    const composer = screen.getByLabelText('Message the work stream');

    fireEvent.change(composer, { target: { value: '@' } });

    const options = await screen.findAllByRole('option');
    expect(options.map((option) => option.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false', 'false']);

    fireEvent.keyDown(composer, { key: 'ArrowDown' });

    expect(screen.getAllByRole('option').map((option) => option.getAttribute('aria-selected')))
      .toEqual(['false', 'true', 'false', 'false']);

    fireEvent.keyDown(composer, { key: 'Enter' });

    await waitFor(() => expect(composer).toHaveValue('@Adam '));
    expect(screen.queryByRole('listbox', { name: 'Mentions' })).not.toBeInTheDocument();
    // Enter chose a name rather than sending the half-written mention.
    expect(onSend).not.toHaveBeenCalled();
  });

  it('inserts Rally from the mention picker without forging a person identity', async () => {
    const onSend = vi.fn(async () => undefined);
    renderComposer(onSend);
    const composer = screen.getByLabelText('Message the work stream');

    fireEvent.change(composer, { target: { value: '@' } });
    fireEvent.click(await screen.findByRole('option', { name: /Rally .* Bot/u }));

    expect(composer).toHaveValue('@Rally ');
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(onSend).toHaveBeenCalledWith('@Rally', [], undefined, undefined));
  });

  it('wraps to the last candidate when the highlight is walked up off the top', async () => {
    renderComposer();
    const composer = screen.getByLabelText('Message the work stream');

    fireEvent.change(composer, { target: { value: '@' } });
    await screen.findAllByRole('option');
    fireEvent.keyDown(composer, { key: 'ArrowUp' });

    expect(screen.getAllByRole('option').map((option) => option.getAttribute('aria-selected')))
      .toEqual(['false', 'false', 'false', 'true']);

    fireEvent.keyDown(composer, { key: 'Enter' });

    await waitFor(() => expect(composer).toHaveValue('@Cara Chen '));
  });

  it('returns the highlight to the top when the typed query drops the highlighted candidate', async () => {
    renderComposer();
    const composer = screen.getByLabelText('Message the work stream');

    fireEvent.change(composer, { target: { value: '@' } });
    await screen.findAllByRole('option');
    fireEvent.keyDown(composer, { key: 'ArrowDown' });
    fireEvent.keyDown(composer, { key: 'ArrowDown' });

    // Bob was highlighted and the narrowed list has no Bob in it, so Enter must
    // fall back to the first row rather than to whoever inherited his place.
    fireEvent.change(composer, { target: { value: '@ad' } });

    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(1));
    expect(screen.getAllByRole('option').map((option) => option.getAttribute('aria-selected')))
      .toEqual(['true']);

    fireEvent.keyDown(composer, { key: 'Enter' });

    await waitFor(() => expect(composer).toHaveValue('@Adam '));
  });

  it('opens the mention list at the top again after it has been dismissed', async () => {
    renderComposer();
    const composer = screen.getByLabelText('Message the work stream');

    fireEvent.change(composer, { target: { value: '@' } });
    await screen.findAllByRole('option');
    fireEvent.keyDown(composer, { key: 'ArrowDown' });
    fireEvent.change(composer, { target: { value: 'Ship it' } });

    expect(screen.queryByRole('listbox', { name: 'Mentions' })).not.toBeInTheDocument();

    fireEvent.change(composer, { target: { value: 'Ship it @' } });

    // A highlight left over from the last time it was open would send Enter to
    // whoever was under it, which is not the row this list is showing first.
    await waitFor(() => expect(screen.getAllByRole('option').map((option) => option.getAttribute('aria-selected')))
      .toEqual(['true', 'false', 'false', 'false']));
  });

  it('sends participant mentions without asking for confirmation', async () => {
    const onSend = vi.fn(async () => undefined);
    renderComposer(onSend);

    fireEvent.change(screen.getByLabelText('Message the work stream'), { target: { value: '@Adam looks good.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));

    await waitFor(() => expect(onSend).toHaveBeenCalledWith(
      '@Adam looks good.', [], undefined, undefined,
    ));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('highlights mentioned resources behind the draft without altering it', () => {
    renderComposer();
    const textarea = screen.getByLabelText('Message the work stream');

    fireEvent.change(textarea, { target: { value: 'ask @Bob Builder about @nobody' } });

    const highlight = document.querySelector('.composer-highlight');
    expect(highlight).not.toBeNull();
    expect(highlight).toHaveTextContent('ask @Bob Builder about @nobody');
    const marks = [...document.querySelectorAll('.composer-mention')].map((mark) => mark.textContent);
    expect(marks).toEqual(['@Bob Builder']);
    expect(textarea).toHaveValue('ask @Bob Builder about @nobody');
    expect(highlight).toHaveAttribute('aria-hidden', 'true');
  });

  it('attaches an image pasted into the composer without disturbing the draft', () => {
    const onAttach = vi.fn();
    renderComposer(undefined, false, onAttach);
    const textarea = screen.getByLabelText('Message the work stream');
    fireEvent.change(textarea, { target: { value: 'The crash looks like this:' } });

    fireEvent.paste(textarea, {
      clipboardData: {
        files: [new File(['png'], 'image.png', { type: 'image/png' })],
        getData: () => '',
        types: ['Files'],
      },
    });

    const [pasted] = onAttach.mock.calls[0]![0] as File[];
    expect(pasted!.type).toBe('image/png');
    expect(pasted!.name).toMatch(/^Pasted image \d{4}-\d{2}-\d{2} at \d{2}\.\d{2}\.\d{2}\.png$/u);
    expect(textarea).toHaveValue('The crash looks like this:');
  });

  it('hands the draft back to the textarea while an IME composition is open', () => {
    renderComposer();
    const textarea = screen.getByLabelText('Message the work stream');
    const composer = document.querySelector('.workstream-composer');
    expect(composer).toHaveClass('is-highlighting');
    expect(composer).not.toHaveClass('is-composing');

    fireEvent.compositionStart(textarea);
    expect(composer).toHaveClass('is-composing');

    fireEvent.compositionEnd(textarea);
    expect(composer).not.toHaveClass('is-composing');
  });
});

describe('WorkstreamComposer draft caching', () => {
  it('brings a half-written message and its mention back to the same work stream', async () => {
    renderComposer();
    const textarea = screen.getByLabelText('Message the work stream');
    fireEvent.change(textarea, { target: { value: 'Ask @Bob' } });
    fireEvent.click(await screen.findByRole('option', { name: /Bob Builder/u }));
    await waitFor(() => expect(textarea).toHaveValue('Ask @Bob Builder '));
    cleanup();

    renderComposer();

    await waitFor(() => expect(screen.getByLabelText('Message the work stream')).toHaveValue('Ask @Bob Builder '));
  });

  it('forgets the draft once the message is sent', async () => {
    const onSend = vi.fn(async () => undefined);
    renderComposer(onSend);
    const textarea = screen.getByLabelText('Message the work stream');
    fireEvent.change(textarea, { target: { value: 'Ship it' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    await waitFor(() => expect(onSend).toHaveBeenCalledWith(
      'Ship it', [], undefined, undefined,
    ));
    cleanup();

    renderComposer();

    await waitFor(() => expect(screen.getByLabelText('Message the work stream')).toHaveValue(''));
  });
});

describe('WorkstreamComposer GrokBot chrome', () => {
  it('keeps developer model details out of the conversation input', async () => {
    applicationSettings.current = { lockdownMode: false, lockdownAvailable: false, debugEnabled: true };
    renderComposer(undefined, false, undefined, {
      ...workstream,
      modelOverride: 'deepseek/deepseek-v4-pro',
    });

    await screen.findByLabelText('Message the work stream');
    expect(screen.queryByRole('button', { name: /^Model:/u })).not.toBeInTheDocument();
  });
});
