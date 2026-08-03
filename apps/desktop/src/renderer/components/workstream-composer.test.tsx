import { createRef } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as Tooltip from '@radix-ui/react-tooltip';
import { describe, expect, it, vi } from 'vitest';
import type { MentionIdentity } from '../lib/api';
import type { WorkspaceMember, WorkstreamDetail } from '../lib/types';
import { WorkstreamComposer } from './workstream-composer';

const creator: WorkspaceMember = { id: 'user-1', name: 'Adam', email: 'adam@example.com', timezone: 'America/Los_Angeles' };
const bob: WorkspaceMember = { id: 'user-2', name: 'Bob Builder', email: 'bob@example.com', timezone: 'America/Los_Angeles' };
const cara: WorkspaceMember = { id: 'user-3', name: 'Cara Chen', email: 'cara@example.com', timezone: 'America/Los_Angeles' };

const workstream: WorkstreamDetail = {
  id: 'workstream-1',
  title: 'Investigate the release',
  origin: 'ad_hoc',
  harnessStatus: 'completed',
  lastActivityAt: '2026-07-31T20:00:00.000Z',
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
): ReturnType<typeof render> {
  vi.stubGlobal('ResizeObserver', class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  });
  return render(
    <Tooltip.Provider>
      <WorkstreamComposer
        fileInputRef={createRef<HTMLInputElement>()}
        members={[creator, bob, cara]}
        onAttach={async () => undefined}
        onSend={onSend}
        onStop={async () => undefined}
        sending={false}
        socketState="connected"
        uploading={false}
        workstream={workstream}
      />
    </Tooltip.Provider>,
  );
}

describe('WorkstreamComposer mention confirmation', () => {
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
});
