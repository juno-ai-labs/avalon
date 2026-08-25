import { createRef } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import * as Tooltip from '@radix-ui/react-tooltip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MentionIdentity } from '../lib/api';
import type { WorkspaceMember, WorkstreamDetail } from '../lib/types';
import type { PendingAttachment } from '../lib/use-file-attachments';
import { clearAllDrafts } from '../lib/draft-cache';
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
  origin: 'ad_hoc',
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
  createdAt: '2026-07-31T20:00:00.000Z',
  participants: [creator],
  viewers: [],
  resources: [],
  connections: [],
  backgroundTasks: [],
  automationRuns: [],
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

function mentionOptionCopy(option: HTMLElement): { badge: string | null; description: string | null; label: string | null } {
  return {
    badge: option.querySelector('.badge')?.textContent ?? null,
    description: option.querySelector('small')?.textContent ?? null,
    label: option.querySelector('strong')?.textContent ?? null,
  };
}

describe('WorkstreamComposer mention confirmation', () => {
  it('places dictation after attachments and exposes microphone selection', async () => {
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

    const attach = screen.getByRole('button', { name: 'Attach a file' });
    const dictate = screen.getByRole('button', { name: 'Click or hold to dictate' });
    expect(attach.compareDocumentPosition(dictate) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    await waitFor(() => expect(screen.getByRole('button', { name: 'Choose microphone' })).toBeEnabled());
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Choose microphone' }), { button: 0, ctrlKey: false });
    const studioMicrophone = await screen.findByRole('menuitemradio', { name: 'Studio microphone' });
    expect(studioMicrophone).toBeVisible();
    expect(studioMicrophone).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('menuitemradio', { name: 'Default - MacBook Pro Microphone' }))
      .toHaveAttribute('aria-checked', 'true');
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
        provider: 'avalon_upload',
        mimeType: 'text/plain',
        watchEnabled: false,
        watchStatus: 'unsupported',
        contentAvailable: true,
        sizeBytes: 5,
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
    await waitFor(() => expect(onSend).toHaveBeenCalledWith('', []));
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

    expect(onSend).toHaveBeenCalledWith('Send this now', []);
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

    expect(onSend).toHaveBeenNthCalledWith(1, 'First queued message', []);
    expect(onSend).toHaveBeenNthCalledWith(2, 'Second queued message', []);
    expect(composer).toHaveValue('');
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

  it('confirms every mentioned nonparticipant together and sends their IDs without a preliminary add', async () => {
    const onSend = vi.fn(async () => undefined);
    renderComposer(onSend);

    fireEvent.change(screen.getByLabelText('Message the work stream'), {
      target: { value: 'Please ask @Bob Builder and @Cara Chen to review.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));

    expect(await screen.findByRole('heading', { name: 'Add participants?' })).toBeVisible();
    expect(screen.getByText('bob@example.com')).toBeVisible();
    expect(screen.getByText('cara@example.com')).toBeVisible();
    expect(onSend).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Add all and mention' }));

    await waitFor(() => expect(onSend).toHaveBeenCalledWith(
      'Please ask @Bob Builder and @Cara Chen to review.',
      [],
      ['user-2', 'user-3'],
    ));
    expect(screen.getByLabelText('Message the work stream')).toHaveValue('');
  });

  it('starts a mention where the caret is rather than at the end of the draft', async () => {
    renderComposer();
    const composer = screen.getByLabelText('Message the work stream');

    fireEvent.change(composer, {
      target: { value: 'ask about the release', selectionStart: 3, selectionEnd: 3 },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Mention a participant' }));

    // Someone who came back to finish a sentence keeps it: the `@` lands under
    // the caret, not at the end of what they had already written.
    await waitFor(() => expect(composer).toHaveValue('ask @ about the release'));
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
    const firstOption = options[0];
    if (!firstOption) throw new Error('Expected at least one mention option');
    await within(firstOption).findByText('A');
    expect(options.map(mentionOptionCopy)).toEqual([{
      badge: 'Person',
      description: 'adam@example.com',
      label: 'Adam',
    }]);
  });

  it('offers people only, leaving the work stream\'s connections out of the list and out of the highlight', async () => {
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
    const firstOption = options[0];
    if (!firstOption) throw new Error('Expected at least one mention option');
    await within(firstOption).findByText('A');
    expect(options.map(mentionOptionCopy)).toEqual([
      { badge: 'Person', description: 'adam@example.com', label: 'Adam' },
      { badge: 'Person', description: 'bob@example.com · not participating', label: 'Bob Builder' },
      { badge: 'Person', description: 'cara@example.com · not participating', label: 'Cara Chen' },
    ]);
    expect(options[0]).toHaveAccessibleName('Adam — adam@example.com — Person');
    expect(options[1]).toHaveAccessibleName('Bob Builder — bob@example.com · not participating — Person');
    expect(options[2]).toHaveAccessibleName('Cara Chen — cara@example.com · not participating — Person');
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
    expect(options.map((option) => option.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false']);

    fireEvent.keyDown(composer, { key: 'ArrowDown' });

    expect(screen.getAllByRole('option').map((option) => option.getAttribute('aria-selected')))
      .toEqual(['false', 'true', 'false']);

    fireEvent.keyDown(composer, { key: 'Enter' });

    await waitFor(() => expect(composer).toHaveValue('@Bob Builder '));
    expect(screen.queryByRole('listbox', { name: 'Mentions' })).not.toBeInTheDocument();
    // Enter chose a name rather than sending the half-written mention.
    expect(onSend).not.toHaveBeenCalled();
  });

  it('wraps to the last candidate when the highlight is walked up off the top', async () => {
    renderComposer();
    const composer = screen.getByLabelText('Message the work stream');

    fireEvent.change(composer, { target: { value: '@' } });
    await screen.findAllByRole('option');
    fireEvent.keyDown(composer, { key: 'ArrowUp' });

    expect(screen.getAllByRole('option').map((option) => option.getAttribute('aria-selected')))
      .toEqual(['false', 'false', 'true']);

    fireEvent.keyDown(composer, { key: 'Enter' });

    await waitFor(() => expect(composer).toHaveValue('@Cara Chen '));
  });

  it('returns the highlight to the top when the typed query drops the highlighted candidate', async () => {
    renderComposer();
    const composer = screen.getByLabelText('Message the work stream');

    fireEvent.change(composer, { target: { value: '@' } });
    await screen.findAllByRole('option');
    fireEvent.keyDown(composer, { key: 'ArrowDown' });

    // Bob was highlighted and the narrowed list has no Bob in it, so Enter must
    // fall back to the first row rather than to whoever inherited his place.
    fireEvent.change(composer, { target: { value: '@a' } });

    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(2));
    expect(screen.getAllByRole('option').map((option) => option.getAttribute('aria-selected')))
      .toEqual(['true', 'false']);

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
      .toEqual(['true', 'false', 'false']));
  });

  it('sends participant mentions without asking for confirmation', async () => {
    const onSend = vi.fn(async () => undefined);
    renderComposer(onSend);

    fireEvent.change(screen.getByLabelText('Message the work stream'), { target: { value: '@Adam looks good.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));

    await waitFor(() => expect(onSend).toHaveBeenCalledWith('@Adam looks good.', []));
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
    await waitFor(() => expect(onSend).toHaveBeenCalledWith('Ship it', []));
    cleanup();

    renderComposer();

    await waitFor(() => expect(screen.getByLabelText('Message the work stream')).toHaveValue(''));
  });
});

describe('WorkstreamComposer model readout', () => {
  const ranOn = (model: string | undefined): WorkstreamDetail => ({
    ...workstream,
    latestHarnessRunId: 'run-1',
    latestHarnessRun: {
      id: 'run-1',
      origin: 'opening_message',
      status: 'completed',
      ...(model ? { model } : {}),
      createdAt: '2026-07-31T20:00:00.000Z',
    },
  });

  it('shows no model unless developer mode is on', async () => {
    renderComposer(undefined, false, undefined, ranOn('x-ai/grok-4.5'));

    await screen.findByLabelText('Message the work stream');
    expect(screen.queryByRole('button', { name: /^Model:/u })).not.toBeInTheDocument();
  });

  it('names the model this work stream is running on', async () => {
    applicationSettings.current = { lockdownMode: false, lockdownAvailable: false, debugEnabled: true };
    renderComposer(undefined, false, undefined, ranOn('x-ai/grok-4.5'));

    // The pill is the same one the launch composer offers, so a pinned work
    // stream reads here exactly as it read when it was pinned. Unpinned, the
    // name says the id is the latest run's rather than a standing property:
    // this work stream re-resolves the flag on every launch.
    const readout = await screen.findByRole('button', {
      name: "Model: x-ai/grok-4.5 (the latest run's) — unpinned, so the agent-model-workstream flag decides each run and a later run may differ. It cannot be set here.",
    });
    expect(readout).toHaveTextContent('Grok 4.5');
  });

  it('promises a fixed model only where one is actually pinned', async () => {
    applicationSettings.current = { lockdownMode: false, lockdownAvailable: false, debugEnabled: true };
    // The pin is the only thing that makes the model a property of the work
    // stream rather than of its last run: `resolveWorkstreamModelRouting` stops
    // at the row and never reads the flag. Saying so on an unpinned work stream
    // would be a stability guarantee the server does not keep.
    renderComposer(undefined, false, undefined, {
      ...ranOn('deepseek/deepseek-v4-pro'),
      modelOverride: 'deepseek/deepseek-v4-pro',
    });

    await screen.findByRole('button', {
      name: 'Model: deepseek/deepseek-v4-pro — pinned when this work stream was created, so every run uses it. It cannot be changed.',
    });
  });

  it('is the launch composer’s dropdown with its trigger disabled', async () => {
    applicationSettings.current = { lockdownMode: false, lockdownAvailable: false, debugEnabled: true };
    renderComposer(undefined, false, undefined, ranOn('x-ai/grok-4.5'));

    const readout = await screen.findByRole('button', { name: /^Model: x-ai\/grok-4\.5/u });
    expect(readout).toBeDisabled();

    // The same gesture that opens it on the launch screen. A work stream's model
    // is decided at creation, so a menu here would offer a change no later run
    // would honour.
    fireEvent.pointerDown(readout, { button: 0, ctrlKey: false });
    fireEvent.click(readout);

    await waitFor(() => expect(screen.getByLabelText('Message the work stream')).toBeInTheDocument());
    expect(screen.queryByRole('menuitemradio')).not.toBeInTheDocument();
  });

  it('names a served model the pin list does not admit', async () => {
    applicationSettings.current = { lockdownMode: false, lockdownAvailable: false, debugEnabled: true };
    // A flag variation may serve any OpenRouter id, and an unpinned work stream
    // runs on whatever it served. The pill shortens it; the tooltip does not.
    renderComposer(undefined, false, undefined, ranOn('moonshotai/kimi-k2.5'));

    const readout = await screen.findByRole('button', { name: /^Model: moonshotai\/kimi-k2\.5/u });
    expect(readout).toHaveTextContent('kimi-k2.5');
  });

  it('falls back to the pin when the run never got far enough to record a model', async () => {
    applicationSettings.current = { lockdownMode: false, lockdownAvailable: false, debugEnabled: true };
    // A run that failed before its first token leaves `harness_runs.model` null.
    // Calling a pinned work stream **Default** there would describe it as
    // following a flag it never consults.
    renderComposer(undefined, false, undefined, {
      ...ranOn(undefined),
      modelOverride: 'deepseek/deepseek-v4-pro',
    });

    const readout = await screen.findByRole('button', { name: /^Model: deepseek\/deepseek-v4-pro/u });
    expect(readout).toHaveTextContent('DeepSeek V4 Pro');
  });

  it('prefers what ran over what was pinned', async () => {
    applicationSettings.current = { lockdownMode: false, lockdownAvailable: false, debugEnabled: true };
    // The two agree on every ordinary pinned work stream. Where they disagree
    // the run is the truth — it is what answered.
    renderComposer(undefined, false, undefined, {
      ...ranOn('x-ai/grok-4.5'),
      modelOverride: 'deepseek/deepseek-v4-pro',
    });

    await screen.findByRole('button', { name: /^Model: x-ai\/grok-4\.5/u });
  });

  it('treats a blank recorded model as no model at all', async () => {
    applicationSettings.current = { lockdownMode: false, lockdownAvailable: false, debugEnabled: true };
    // `harness_runs.model` is not constrained to be non-empty, and a Worker with
    // an unset OPENROUTER_* variable resolves to `""` and stores it. Believing
    // that would render a pill with nothing in it; it falls through to the pin
    // instead, exactly as a null would.
    renderComposer(undefined, false, undefined, {
      ...ranOn('   '),
      modelOverride: 'deepseek/deepseek-v4-pro',
    });

    const readout = await screen.findByRole('button', { name: /^Model: deepseek\/deepseek-v4-pro/u });
    expect(readout).toHaveTextContent('DeepSeek V4 Pro');
  });

  it('claims no model before the work stream has a run to read one off', async () => {
    applicationSettings.current = { lockdownMode: false, lockdownAvailable: false, debugEnabled: true };
    renderComposer(undefined, false, undefined, ranOn(undefined));

    // Same answer an untouched launch composer gives, for the same reason: the
    // flag decides and the renderer cannot see the served variation.
    const readout = await screen.findByRole('button', {
      name: 'Model: Default (no run yet) — unpinned, so the agent-model-workstream flag decides each run and a later run may differ. It cannot be set here.',
    });
    expect(readout).toHaveTextContent('Default');
  });
});
