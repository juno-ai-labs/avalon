import { act, createRef } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import * as Tooltip from '@radix-ui/react-tooltip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MentionIdentity } from '../lib/api';
import type { WorkspaceMember, WorkstreamDetail } from '../lib/types';
import type { PendingAttachment } from '../lib/use-file-attachments';
import { clearAllDrafts } from '../lib/draft-cache';
import { mentionOptionCopy } from '../test/mention-option-copy';
import { STOPPING_LABEL } from './agent-work-timing';
import type { ComposerModelControl } from './composer-input';
import { WorkstreamComposer } from './workstream-composer';
import { SidekickMentionContext, sidekickMentionDirectory } from '../lib/sidekick-mentions';
import type { WorkspaceInvitee } from '@rally/contracts';

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
  desktopServicesAvailable: () => false,
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
  model?: ComposerModelControl,
  invitees?: WorkspaceInvitee[],
  sharedInviteeEmails?: string[],
): ReturnType<typeof render> {
  vi.stubGlobal('ResizeObserver', class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  });
  return render(
    <Tooltip.Provider>
      <WorkstreamComposer
        draftKey="test-draft"
        attachments={[]}
        fileInputRef={createRef<HTMLInputElement>()}
        members={members}
        {...(invitees ? { invitees } : {})}
        {...(sharedInviteeEmails ? { sharedInviteeEmails } : {})}
        {...(model ? { model } : {})}
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

describe('WorkstreamComposer Stop action', () => {
  it('retains the hidden slot and guards pending stops while keeping their tooltip accessible', async () => {
    vi.stubGlobal('ResizeObserver', class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    });
    const onStop = vi.fn(async () => undefined);
    const composer = (detail: WorkstreamDetail): React.JSX.Element => (
      <Tooltip.Provider>
        <WorkstreamComposer
          draftKey="test-draft"
          attachments={[]}
          fileInputRef={createRef<HTMLInputElement>()}
          members={[creator]}
          onAttach={() => undefined}
          onOpenAttachment={() => undefined}
          onRemoveAttachment={() => undefined}
          onRetryAttachment={() => undefined}
          onSend={async () => undefined}
          onStop={onStop}
          sending={false}
          uploading={false}
          workstream={detail}
        />
      </Tooltip.Provider>
    );
    const view = render(composer(workstream));
    const slot = view.container.querySelector('.composer-stop-slot');
    expect(slot).toHaveAttribute('inert');
    expect(slot).toHaveAttribute('data-visible', 'false');
    // jsdom does not implement inert focus/hit testing; Electron covers that.
    const button = view.container.querySelector<HTMLButtonElement>('.stop-button')!;
    expect(button).toBeInTheDocument();

    view.rerender(composer({ ...workstream, harnessStatus: 'running' }));
    expect(slot).not.toHaveAttribute('inert');
    expect(slot).toHaveAttribute('data-visible', 'true');
    expect(screen.getByRole('button', { name: 'Stop the current run' })).toBe(button);
    act(() => button.focus());
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Stop the current run');
    expect(button).toHaveAccessibleName('Stop the current run');
    expect(button).not.toHaveAccessibleDescription();
    fireEvent.click(button);
    expect(onStop).toHaveBeenCalledTimes(1);

    view.rerender(composer({ ...workstream, harnessStatus: 'running', stopRequested: true }));
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button).not.toBeDisabled();
    act(() => { button.blur(); button.focus(); });
    expect(button).toHaveFocus();
    expect(await screen.findByRole('tooltip')).toHaveTextContent(STOPPING_LABEL);
    expect(button).toHaveAccessibleName(STOPPING_LABEL);
    expect(button).not.toHaveAccessibleDescription();
    fireEvent.click(button);
    expect(onStop).toHaveBeenCalledTimes(1);

    view.rerender(composer(workstream));
    expect(view.container.querySelector('.stop-button')).toBe(button);
    expect(slot).toHaveAttribute('inert');
    expect(slot).toHaveAttribute('data-visible', 'false');
  });
});

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
          draftKey="test-draft"
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

    const composer = screen.getByLabelText('Message Rally');
    fireEvent.change(composer, { target: { value: 'Half a thought' } });
    const send = screen.getByRole('button', { name: 'Send message, available once Rally connects' });
    expect(send).toBeDisabled();
    fireEvent.keyDown(composer, { key: 'Enter' });
    fireEvent.click(send);

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
          draftKey="test-draft"
          api={{ getTranscriptionSocketTicket: vi.fn(), prefetchTranscriptionSocketTicket: vi.fn() }}
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
          draftKey="test-draft"
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

    const composer = screen.getByLabelText('Message Rally');
    fireEvent.change(composer, { target: { value: 'Send this now' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));

    expect(onSend).toHaveBeenCalledWith('Send this now', [], undefined, undefined);
    expect(composer).toHaveValue('');
    finishSend?.();
  });

  it('accepts another message while an earlier submission is still pending', () => {
    const onSend = vi.fn(() => new Promise<void>(() => undefined));
    renderComposer(onSend, true);

    const composer = screen.getByLabelText('Message Rally');
    fireEvent.change(composer, { target: { value: 'First queued message' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    fireEvent.change(composer, { target: { value: 'Second queued message' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));

    expect(onSend).toHaveBeenNthCalledWith(1, 'First queued message', [], undefined, undefined);
    expect(onSend).toHaveBeenNthCalledWith(2, 'Second queued message', [], undefined, undefined);
    expect(composer).toHaveValue('');
  });

  it('uses safe-boundary delivery while a loop is running and does not offer a delivery dropdown', async () => {
    const onSend = vi.fn(async () => undefined);
    renderComposer(onSend, false, vi.fn(), { ...workstream, harnessStatus: 'running' });

    expect(screen.queryByRole('combobox', { name: 'Message delivery' })).not.toBeInTheDocument();
    const composer = screen.getByLabelText('Message Rally');
    fireEvent.change(composer, { target: { value: 'After this run' } });
    fireEvent.keyDown(composer, { key: 'Enter' });
    await waitFor(() => expect(onSend).toHaveBeenCalledWith('After this run', [], undefined, 'steer'));
  });

  it('restores a failed message unless the user has started a new draft', async () => {
    const onSend = vi.fn(async () => {
      throw new Error('offline');
    });
    renderComposer(onSend);

    const composer = screen.getByLabelText('Message Rally');
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

    const composer = screen.getByLabelText('Message Rally');
    fireEvent.change(composer, { target: { value: 'First message' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    fireEvent.change(composer, { target: { value: 'New draft' } });
    failSend?.(new Error('offline'));

    await waitFor(() => expect(composer).toHaveValue('New draft'));
  });

  it('does not repeat participant controls above the in-workstream composer', () => {
    renderComposer();

    expect(screen.queryByLabelText('Channel participants')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add people' })).not.toBeInTheDocument();
  });

  it('filters functional slash commands and opens participant mentions from the keyboard', async () => {
    renderComposer();

    const composer = screen.getByLabelText('Message Rally');
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

    const composer = screen.getByLabelText('Message Rally');
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

    const composer = screen.getByLabelText('Message Rally');
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

    const composer = screen.getByLabelText('Message Rally');
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

    fireEvent.change(screen.getByLabelText('Message Rally'), {
      target: { value: 'Please ask @Bob Builder and @Cara Chen to review.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));

    expect(await screen.findByRole('heading', { name: 'Add participants?' })).toBeVisible();
    expect(screen.getByText('bob@example.com')).toBeVisible();
    expect(screen.getByText('cara@example.com')).toBeVisible();
    expect(screen.getByText(/If you do not add them, they will not be able to see the mentions or this thread/u))
      .toBeVisible();
    expect(onSend).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Add all and mention' }));

    await waitFor(() => expect(onSend).toHaveBeenCalledWith(
      'Please ask @Bob Builder and @Cara Chen to review.',
      [],
      ['user-2', 'user-3'],
      undefined,
    ));
    expect(screen.getByLabelText('Message Rally')).toHaveValue('');
  });

  it.each(['send button', 'Enter'] as const)(
    'warns before a nonparticipant mention in a personal channel is submitted with %s',
    async (gesture) => {
      const onSend = vi.fn(async () => undefined);
      renderComposer(onSend, false, undefined, { ...workstream, scope: 'personal' });
      const composer = screen.getByLabelText('Message Rally');
      fireEvent.change(composer, { target: { value: 'Please ask @Bob Builder.' } });

      if (gesture === 'Enter') fireEvent.keyDown(composer, { key: 'Enter' });
      else fireEvent.click(screen.getByRole('button', { name: 'Send message' }));

      expect(await screen.findByRole('heading', { name: 'Add participant?' })).toBeVisible();
      expect(screen.getByText(
        /If you do not add them, they will not be able to see the mention or this thread/u,
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

  it('confirms a guest mention in an Organization-visible thread', async () => {
    const onSend = vi.fn(async () => undefined);
    renderComposer(onSend, false, undefined, workstream, [creator, { ...bob, accessClass: 'guest' }, cara]);
    fireEvent.change(screen.getByLabelText('Message Rally'), {
      target: { value: 'Please ask @Bob Builder and @Cara Chen to review.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    expect(await screen.findByRole('heading', { name: 'Add participant?' })).toBeVisible();
    expect(screen.getByText('bob@example.com')).toBeVisible();
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Add and mention' }));
    await waitFor(() => expect(onSend).toHaveBeenCalledWith(
      'Please ask @Bob Builder and @Cara Chen to review.', [], ['user-2'], undefined,
    ));
  });

  it('does not block an organization-visible channel on participant status', async () => {
    const onSend = vi.fn(async () => undefined);
    renderComposer(onSend);
    fireEvent.change(screen.getByLabelText('Message Rally'), {
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

    fireEvent.change(screen.getByLabelText('Message Rally'), {
      target: { value: 'Please ask @Bob Builder.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));

    expect(await screen.findByRole('heading', { name: 'Add participant?' })).toBeVisible();
    expect(screen.getByText('bob@example.com')).toBeVisible();
    expect(screen.queryByText('short-bob@example.com')).not.toBeInTheDocument();
  });

  it('opens mentions by typing at the caret without a dedicated mention button', async () => {
    renderComposer();
    const composer = screen.getByLabelText('Message Rally');

    fireEvent.change(composer, {
      target: { value: 'ask @ about the release', selectionStart: 5, selectionEnd: 5 },
    });

    expect(screen.queryByRole('button', { name: 'Mention a participant' })).not.toBeInTheDocument();
    expect(screen.getByRole('listbox', { name: 'Mentions' })).toBeVisible();
  });

  it('keeps Escape from travelling on when it dismissed something here', async () => {
    renderComposer();
    const composer = screen.getByLabelText('Message Rally');

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
    const composer = screen.getByLabelText('Message Rally');

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
    const composer = screen.getByLabelText('Message Rally');

    fireEvent.change(composer, { target: { value: '@' } });

    // Mentioning one adds them to the work stream, and the endpoint refuses a
    // membership that is not active — the participants rail already filters for
    // exactly this reason.
    const options = await screen.findAllByRole('option');
    expect(options.map(mentionOptionCopy)).toEqual([
      { description: null, label: 'Rally' },
      { description: 'adam@example.com', label: 'Adam' },
    ]);
  });

  it('groups participants before other org members and guests, and navigates across headings', async () => {
    renderComposer(undefined, false, undefined, { ...workstream, participants: [creator, { ...cara, accessClass: 'guest' }] },
      [{ ...bob, accessClass: 'guest' }, creator, { ...cara, accessClass: 'guest' },
        { ...bob, id: 'member-bob', name: 'Bob Member' }]);
    const composer = screen.getByLabelText('Message Rally');
    fireEvent.change(composer, { target: { value: '@' } });

    const list = await screen.findByRole('listbox', { name: 'Mentions' });
    expect(within(list).getAllByRole('group').map((group) => group.getAttribute('aria-label')))
      .toEqual(['Rally', 'Participants', 'Org members', 'Guests']);
    expect(within(screen.getByRole('group', { name: 'Participants' })).getAllByRole('option').map(mentionOptionCopy))
      .toEqual([
        { description: 'adam@example.com', label: 'Adam' },
        { description: 'cara@example.com', label: 'Cara Chen' },
      ]);
    expect(within(screen.getByRole('group', { name: 'Org members' })).getAllByRole('option').map(mentionOptionCopy))
      .toEqual([{ description: 'bob@example.com', label: 'Bob Member' }]);
    expect(within(screen.getByRole('group', { name: 'Guests' })).getAllByRole('option').map(mentionOptionCopy))
      .toEqual([{ description: 'bob@example.com', label: 'Bob Builder' }]);

    fireEvent.change(composer, { target: { value: '@Bob' } });
    expect(within(list).getAllByRole('group').map((group) => group.getAttribute('aria-label')))
      .toEqual(['Org members', 'Guests']);
    fireEvent.keyDown(composer, { key: 'ArrowDown' });
    fireEvent.keyDown(composer, { key: 'Enter' });
    expect(composer).toHaveValue('@Bob Builder ');
    expect(list).not.toBeInTheDocument();
  });

  it('keeps guests reachable after a large org member group', async () => {
    const members = Array.from({ length: 9 }, (_, index) => ({ ...bob, id: `member-${index}`, name: `Member ${index}` }));
    renderComposer(undefined, false, undefined, workstream, [...members, { ...cara, accessClass: 'guest' }]);
    fireEvent.change(screen.getByLabelText('Message Rally'), { target: { value: '@' } });
    expect(await screen.findByRole('group', { name: 'Guests' })).toBeInTheDocument();
    expect(screen.getAllByRole('option')).toHaveLength(11);
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
    const composer = screen.getByLabelText('Message Rally');

    fireEvent.change(composer, { target: { value: '@' } });

    const options = await screen.findAllByRole('option');
    expect(options.map(mentionOptionCopy)).toEqual([
      { description: null, label: 'Rally' },
      { description: 'adam@example.com', label: 'Adam' },
      { description: 'bob@example.com', label: 'Bob Builder' },
      { description: 'cara@example.com', label: 'Cara Chen' },
    ]);
    expect(options[0]).toHaveAccessibleName('Rally — Ask Rally to join this part of the conversation — AI');
    expect(options[1]).toHaveAccessibleName('Adam — adam@example.com — Member');
    expect(options[2]).toHaveAccessibleName('Bob Builder — bob@example.com — Member');
    expect(options[3]).toHaveAccessibleName('Cara Chen — cara@example.com — Member');
    expect(screen.queryByText('Organization connection')).not.toBeInTheDocument();

    // The draft's highlight names what the composer can mention, so a
    // connection typed into it by hand stays plain text too.
    fireEvent.change(composer, { target: { value: 'ask @Slack and @Adam' } });

    expect([...document.querySelectorAll('.composer-mention')].map((mark) => mark.textContent)).toEqual(['@Adam']);
  });

  it('walks the mention list with the arrow keys and inserts the highlighted candidate on Enter', async () => {
    const onSend = vi.fn(async () => undefined);
    renderComposer(onSend);
    const composer = screen.getByLabelText('Message Rally');

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
    const composer = screen.getByLabelText('Message Rally');

    fireEvent.change(composer, { target: { value: '@' } });
    fireEvent.click(await screen.findByRole('option', { name: /Rally .* AI/u }));

    expect(composer).toHaveValue('@Rally ');
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(onSend).toHaveBeenCalledWith('@Rally', [], undefined, undefined));
  });

  it('offers published Sidekicks under their own heading and sends a picked one as its link', async () => {
    const onSend = vi.fn(async () => undefined);
    const { rerender } = renderComposer(onSend);
    const sidekicks = sidekickMentionDirectory([
      { id: '0b8c3a52-5f0e-4d6a-9a1c-1d2e3f405162', name: 'Daily digest', description: 'Summarizes the day', status: 'active' },
      { id: '7f1e2d3c-4b5a-4968-8776-655443322110', name: 'Daily draft', description: 'Not published', status: 'draft' },
    ]);
    rerender(
      <SidekickMentionContext.Provider value={sidekicks}>
        <Tooltip.Provider>
          <WorkstreamComposer
            draftKey="test-draft"
            attachments={[]}
            fileInputRef={createRef<HTMLInputElement>()}
            members={[creator, bob, cara]}
            onOpenAttachment={() => undefined}
            onRemoveAttachment={() => undefined}
            onRetryAttachment={() => undefined}
            onSend={onSend}
            onStop={async () => undefined}
            sending={false}
            uploading={false}
            workstream={workstream}
          />
        </Tooltip.Provider>
      </SidekickMentionContext.Provider>,
    );
    const composer = screen.getByLabelText('Message Rally');

    fireEvent.change(composer, { target: { value: 'Ask @dai' } });
    const group = await screen.findByRole('group', { name: 'Sidekicks' });
    expect(within(group).getAllByRole('option').map(mentionOptionCopy))
      .toEqual([{ label: 'Daily digest', description: 'Summarizes the day' }]);
    fireEvent.click(within(group).getByRole('option', { name: /Daily digest .* Sidekick/u }));

    expect(composer).toHaveValue('Ask @Daily digest ');
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(onSend).toHaveBeenCalledWith(
      'Ask [@Daily digest](sidekick://0b8c3a52-5f0e-4d6a-9a1c-1d2e3f405162)',
      [],
      undefined,
      undefined,
    ));
  });

  it('highlights a Sidekick name only while a pick holds it', async () => {
    const sidekicks = sidekickMentionDirectory([
      { id: '0b8c3a52-5f0e-4d6a-9a1c-1d2e3f405162', name: 'Daily digest', description: '', status: 'active' },
    ]);
    vi.stubGlobal('ResizeObserver', class { observe(): void {} unobserve(): void {} disconnect(): void {} });
    render(
      <SidekickMentionContext.Provider value={sidekicks}>
        <Tooltip.Provider>
          <WorkstreamComposer draftKey="test-draft" attachments={[]} fileInputRef={createRef<HTMLInputElement>()}
            members={[creator]} onOpenAttachment={() => undefined} onRemoveAttachment={() => undefined}
            onRetryAttachment={() => undefined} onSend={vi.fn(async () => undefined)} onStop={async () => undefined}
            sending={false} uploading={false} workstream={workstream} />
        </Tooltip.Provider>
      </SidekickMentionContext.Provider>,
    );
    const composer = screen.getByLabelText('Message Rally');
    const marks = (): string[] => [...document.querySelectorAll('mark.composer-mention')].map((mark) => mark.textContent ?? '');

    // Typed by hand it would go out as text, so it must not look like a mention.
    fireEvent.change(composer, { target: { value: 'Ask @Daily digest' } });
    expect(marks()).toEqual([]);

    fireEvent.change(composer, { target: { value: 'Ask @dai' } });
    fireEvent.click(await screen.findByRole('option', { name: /Daily digest .* Sidekick/u }));
    expect(marks()).toEqual(['@Daily digest']);
  });

  it('wraps to the last candidate when the highlight is walked up off the top', async () => {
    renderComposer();
    const composer = screen.getByLabelText('Message Rally');

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
    const composer = screen.getByLabelText('Message Rally');

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
    const composer = screen.getByLabelText('Message Rally');

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

    fireEvent.change(screen.getByLabelText('Message Rally'), { target: { value: '@Adam looks good.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));

    await waitFor(() => expect(onSend).toHaveBeenCalledWith(
      '@Adam looks good.', [], undefined, undefined,
    ));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('highlights mentioned resources behind the draft without altering it', () => {
    renderComposer();
    const textarea = screen.getByLabelText('Message Rally');

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
    const textarea = screen.getByLabelText('Message Rally');
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
    const textarea = screen.getByLabelText('Message Rally');
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
  it('brings a half-written message and its mention back to the same channel', async () => {
    renderComposer();
    const textarea = screen.getByLabelText('Message Rally');
    fireEvent.change(textarea, { target: { value: 'Ask @Bob' } });
    fireEvent.click(await screen.findByRole('option', { name: /Bob Builder/u }));
    await waitFor(() => expect(textarea).toHaveValue('Ask @Bob Builder '));
    cleanup();

    renderComposer();

    await waitFor(() => expect(screen.getByLabelText('Message Rally')).toHaveValue('Ask @Bob Builder '));
  });

  it('forgets the draft once the message is sent', async () => {
    const onSend = vi.fn(async () => undefined);
    renderComposer(onSend);
    const textarea = screen.getByLabelText('Message Rally');
    fireEvent.change(textarea, { target: { value: 'Ship it' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    await waitFor(() => expect(onSend).toHaveBeenCalledWith(
      'Ship it', [], undefined, undefined,
    ));
    cleanup();

    renderComposer();

    await waitFor(() => expect(screen.getByLabelText('Message Rally')).toHaveValue(''));
  });
});

describe('WorkstreamComposer model control', () => {
  it('shows no model control unless developer mode is on', async () => {
    renderComposer(undefined, false, undefined, workstream, [creator], {
      kind: 'settled', model: 'deepseek/deepseek-v4-pro', pinned: true,
    });

    await screen.findByLabelText('Message Rally');
    expect(screen.queryByRole('button', { name: /^Model:/u })).not.toBeInTheDocument();
  });

  it('names the model a created conversation is on and opens nothing', async () => {
    // The pin is written once, at creation, and nothing afterwards edits it —
    // so this control exists to be read. A menu here would offer a change the
    // next run would not honour.
    applicationSettings.current = { lockdownMode: false, lockdownAvailable: false, debugEnabled: true };
    renderComposer(undefined, false, undefined, workstream, [creator], {
      kind: 'settled', model: 'deepseek/deepseek-v4-pro', pinned: true,
    });

    const trigger = await screen.findByRole('button', { name: /^Model:/u });
    expect(trigger).toHaveTextContent('DeepSeek V4 Pro');
    // The exact id and the claim only a pinned conversation may make, because
    // Tab skips a disabled button and the tooltip is not reachable that way.
    expect(trigger).toHaveAccessibleName(
      'Model: deepseek/deepseek-v4-pro — pinned when this conversation was created, so every run uses it. It cannot be changed.',
    );
    expect(trigger).toBeDisabled();
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    expect(screen.queryByRole('menuitemradio')).not.toBeInTheDocument();
  });

  it('says an unpinned conversation may run somewhere else next time', async () => {
    // What is immutable for an unpinned conversation is the setting, not the
    // model: it re-resolves the flag on every launch, so the id shown is only
    // what the latest run happened to get.
    applicationSettings.current = { lockdownMode: false, lockdownAvailable: false, debugEnabled: true };
    renderComposer(undefined, false, undefined, workstream, [creator], {
      kind: 'settled', model: 'x-ai/grok-4.3', pinned: false,
    });

    expect(await screen.findByRole('button', { name: /^Model:/u })).toHaveAccessibleName(
      "Model: x-ai/grok-4.3 (the latest run's) — unpinned, so the agent-model-workstream flag decides each run and a later run may differ. It cannot be set here.",
    );
  });
});

describe('WorkstreamComposer invitees', () => {
  const dana: WorkspaceInvitee = { email: 'dana@example.com', invitedAt: '2026-07-31T20:00:00.000Z' };

  it('shows names and emails without right-side type labels, with an invitee named by address', async () => {
    renderComposer(undefined, false, undefined, workstream, [creator, { ...bob, accessClass: 'guest' }], undefined, [dana]);
    const composer = screen.getByLabelText('Message Rally');

    fireEvent.change(composer, { target: { value: '@' } });

    const options = await screen.findAllByRole('option');
    expect(options.map(mentionOptionCopy)).toEqual([
      { description: null, label: 'Rally' },
      { description: 'adam@example.com', label: 'Adam' },
      { description: null, label: 'dana@example.com' },
      { description: 'bob@example.com', label: 'Bob Builder' },
    ]);
    expect(options[2]).toHaveClass('is-invited');
    expect(screen.getByRole('listbox', { name: 'Mentions' })).not.toHaveTextContent(/\b(?:AI|Member|Guest|Invited)\b/u);
  });

  it('writes the address and hands the host the invitees the message names', async () => {
    const onSend = vi.fn(async () => undefined);
    renderComposer(onSend, false, undefined, workstream, [creator], undefined, [dana]);
    const composer = screen.getByLabelText('Message Rally');

    fireEvent.change(composer, { target: { value: 'hi @dan' } });
    fireEvent.click((await screen.findAllByRole('option')).find((option) => option.textContent?.includes('dana@example.com'))!);
    await waitFor(() => expect(composer).toHaveValue('hi @dana@example.com '));
    fireEvent.change(composer, { target: { value: 'hi @dana@example.com, take a look' } });
    fireEvent.keyDown(composer, { key: 'Enter' });

    await waitFor(() => expect(onSend).toHaveBeenCalledWith('hi @dana@example.com, take a look', [], undefined, undefined, ['dana@example.com']));
  });

  it('neither asks about nor hands over an invitee this conversation is already shared with', async () => {
    const onSend = vi.fn(async () => undefined);
    renderComposer(onSend, false, undefined, { ...workstream, scope: 'personal' }, [creator], undefined, [dana], ['dana@example.com']);
    const composer = screen.getByLabelText('Message Rally');

    fireEvent.change(composer, { target: { value: '@dana@example.com again' } });
    fireEvent.keyDown(composer, { key: 'Enter' });

    await waitFor(() => expect(onSend).toHaveBeenCalledWith('@dana@example.com again', [], undefined, undefined));
    expect(screen.queryByRole('button', { name: 'Add and mention' })).not.toBeInTheDocument();
  });

  it('shares only with the address written, never one it begins with', async () => {
    const onSend = vi.fn(async () => undefined);
    renderComposer(onSend, false, undefined, workstream, [creator], undefined, [dana]);
    const composer = screen.getByLabelText('Message Rally');

    fireEvent.change(composer, { target: { value: 'ask @dana@example.com.au, or `@dana@example.com`' } });
    fireEvent.keyDown(composer, { key: 'Enter' });

    await waitFor(() => expect(onSend).toHaveBeenCalledWith('ask @dana@example.com.au, or `@dana@example.com`', [], undefined, undefined));
  });

  it('asks before bringing an invitee into a private conversation', async () => {
    const onSend = vi.fn(async () => undefined);
    renderComposer(onSend, false, undefined, { ...workstream, scope: 'personal' }, [creator], undefined, [dana]);
    const composer = screen.getByLabelText('Message Rally');

    fireEvent.change(composer, { target: { value: '@dana@example.com can you look' } });
    fireEvent.keyDown(composer, { key: 'Enter' });

    expect(await screen.findByText('dana@example.com is not currently a participant. Would you like to add them with this message? If you do not add them, they will not be able to see the mention or this thread.')).toBeInTheDocument();
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Add and mention' }));

    await waitFor(() => expect(onSend).toHaveBeenCalledWith('@dana@example.com can you look', [], [], undefined, ['dana@example.com']));
  });
});
