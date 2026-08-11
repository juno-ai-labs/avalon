import { createRef } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as Tooltip from '@radix-ui/react-tooltip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MentionIdentity } from '../lib/api';
import type { WorkspaceMember, WorkstreamDetail } from '../lib/types';
import type { PendingAttachment } from '../lib/use-file-attachments';
import { clearAllDrafts } from '../lib/draft-cache';
import { WorkstreamComposer } from './workstream-composer';

beforeEach(() => clearAllDrafts());
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
  pinPosition: null,
  createdAt: '2026-07-31T20:00:00.000Z',
  participants: [creator],
  viewers: [],
  resources: [],
  connections: [],
  artifacts: [],
  backgroundTasks: [],
  automationRuns: [],
};

function renderComposer(
  onSend: (text: string, mentions: MentionIdentity[], confirmedParticipantUserIds?: string[]) => Promise<void> = vi.fn(async () => undefined),
  sending = false,
  onAttach: (files: FileList | File[]) => void = vi.fn(),
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
        members={[creator, bob, cara]}
        onAttach={onAttach}
        onOpenAttachment={() => undefined}
        onRemoveAttachment={() => undefined}
        onRetryAttachment={() => undefined}
        onSend={onSend}
        onStop={async () => undefined}
        sending={sending}
        uploading={false}
        workstream={workstream}
      />
    </Tooltip.Provider>,
  );
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
