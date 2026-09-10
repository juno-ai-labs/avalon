import * as Tooltip from '@radix-ui/react-tooltip';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as RealtimeDictationModule from '../lib/use-realtime-dictation';
import type { WorkstreamDetail } from '../lib/types';

const dictationHarness = vi.hoisted(() => ({
  emit: undefined as ((transcript: string) => void) | undefined,
  // What `stop` writes out before it settles, standing in for the tail the real
  // hook drains: it delivers the final transcript and only then finishes the
  // attempt, so a caller that submits on `stop` resolving is a render behind it.
  finalTranscript: undefined as string | undefined,
  setError: undefined as ((error: string | undefined) => void) | undefined,
  setState: undefined as ((state: 'idle' | 'listening' | 'transcribing' | 'finalizing' | 'error') => void) | undefined,
  start: vi.fn(),
  stop: vi.fn(),
  stopError: undefined as string | undefined,
}));

vi.mock('../lib/use-realtime-dictation', async (importOriginal) => {
  const React = await import('react');
  const actual = await importOriginal<typeof RealtimeDictationModule>();
  return {
    ...actual,
    useRealtimeDictation: (
      _api: unknown,
      onTranscript: (transcript: string) => void,
    ) => {
      const [state, setState] = React.useState<'idle' | 'listening' | 'transcribing' | 'finalizing' | 'error'>('idle');
      const [error, setError] = React.useState<string>();
      dictationHarness.emit = onTranscript;
      dictationHarness.setError = setError;
      dictationHarness.setState = setState;
      return {
        devices: [],
        ...(error ? { error } : {}),
        selectedDeviceId: 'default',
        setSelectedDeviceId: vi.fn(),
        start: async () => {
          dictationHarness.start();
          setState('listening');
        },
        state,
        stop: async () => {
          dictationHarness.stop();
          // `finish(attempt, 'error', …)` is where a drain or socket failure
          // lands, and it is a state of its own rather than a quiet idle.
          if (dictationHarness.stopError !== undefined) {
            setError(dictationHarness.stopError);
            setState('error');
            return;
          }
          if (dictationHarness.finalTranscript !== undefined) onTranscript(dictationHarness.finalTranscript);
          setState('idle');
        },
      };
    },
  };
});

import { WorkstreamComposer } from './workstream-composer';

const workstream: WorkstreamDetail = {
  id: 'workstream-1',
  title: 'Live transcript',
  titleStatus: 'settled' as const,
  harnessStatus: 'completed',
  scope: 'workspace' as const,
  lastActivityAt: '2026-08-06T12:00:00.000Z',
  latestAttentionSequenceNumber: 0,
  readThroughSequenceNumber: 0,
  manualUnreadFromSequenceNumber: null,
  manualUnreadGeneration: 0,
  hasUnread: false,
  firstUnreadSequenceNumber: null,
  nextPendingWakeup: null,
  pinPosition: null,
  participantUserIds: [],
  participantExtraCount: 0,
  createdAt: '2026-08-06T12:00:00.000Z',
  participants: [],
  viewers: [],
  resources: [],
  connections: [],
  backgroundTasks: [],
};

beforeEach(() => {
  dictationHarness.emit = undefined;
  dictationHarness.finalTranscript = undefined;
  dictationHarness.setError = undefined;
  dictationHarness.setState = undefined;
  dictationHarness.stopError = undefined;
  dictationHarness.start.mockReset();
  dictationHarness.stop.mockReset();
  vi.stubGlobal('ResizeObserver', class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  });
  Object.defineProperty(HTMLButtonElement.prototype, 'setPointerCapture', {
    configurable: true,
    value: vi.fn(),
  });
});

afterEach(() => {
  Reflect.deleteProperty(HTMLButtonElement.prototype, 'setPointerCapture');
  vi.unstubAllGlobals();
});

describe('WorkstreamComposer live dictation', () => {
  it('renders partial transcript text directly in the draft input', async () => {
    render(
      <Tooltip.Provider>
        <WorkstreamComposer
          api={{ getTranscriptionSocketTicket: vi.fn() }}
          attachments={[]}
          fileInputRef={createRef<HTMLInputElement>()}
          members={[]}
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

    const input = screen.getByRole('textbox', { name: 'Message the work stream' });
    fireEvent.change(input, { target: { value: 'Existing draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start voice input' }));
    await waitFor(() => expect(dictationHarness.start).toHaveBeenCalledOnce());

    act(() => dictationHarness.emit?.('live words'));

    expect(input).toHaveValue('Existing draft live words');
    expect(input).toHaveAttribute('readonly');
    expect(screen.getByRole('button', { name: 'Send message' })).toBeEnabled();

    const stopButton = screen.getByRole('button', { name: 'Stop dictation' });
    act(() => stopButton.focus());
    act(() => dictationHarness.emit?.(' more'));
    expect(stopButton).toHaveFocus();
  });

  it('lets the user cancel finalization by editing or using the microphone control', async () => {
    const onSend = vi.fn(async () => undefined);
    render(
      <Tooltip.Provider>
        <WorkstreamComposer
          api={{ getTranscriptionSocketTicket: vi.fn() }}
          attachments={[]}
          fileInputRef={createRef<HTMLInputElement>()}
          members={[]}
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

    const input = screen.getByRole('textbox', { name: 'Message the work stream' });
    fireEvent.change(input, { target: { value: 'Partial transcript' } });
    act(() => dictationHarness.setState?.('transcribing'));

    expect(input).not.toHaveAttribute('readonly');
    expect(screen.getByRole('button', { name: 'Cancel dictation' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Send message' })).toBeEnabled();

    fireEvent.change(input, { target: { value: 'Edited partial transcript' } });
    await waitFor(() => expect(dictationHarness.stop).toHaveBeenCalledOnce());
    expect(input).toHaveValue('Edited partial transcript');
  });

  it('keeps the draft read-only while final audio is pending and finalizes before sending', async () => {
    const onSend = vi.fn(async () => undefined);
    render(
      <Tooltip.Provider>
        <WorkstreamComposer
          api={{ getTranscriptionSocketTicket: vi.fn() }}
          attachments={[]}
          fileInputRef={createRef<HTMLInputElement>()}
          members={[]}
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

    const input = screen.getByRole('textbox', { name: 'Message the work stream' });
    fireEvent.change(input, { target: { value: 'Final dictated message' } });
    act(() => dictationHarness.setState?.('finalizing'));

    expect(input).toHaveAttribute('readonly');
    expect(screen.getByRole('button', { name: 'Finalizing dictation' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));

    await waitFor(() => expect(dictationHarness.stop).toHaveBeenCalledOnce());
    await waitFor(() => expect(onSend).toHaveBeenCalledOnce());
    expect(dictationHarness.stop.mock.invocationCallOrder[0]).toBeLessThan(onSend.mock.invocationCallOrder[0]!);
  });

  it('sends the finalized transcript when send is pressed mid-recording', async () => {
    const onSend = vi.fn(async () => undefined);
    render(
      <Tooltip.Provider>
        <WorkstreamComposer
          api={{ getTranscriptionSocketTicket: vi.fn() }}
          attachments={[]}
          fileInputRef={createRef<HTMLInputElement>()}
          members={[]}
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

    act(() => dictationHarness.setState?.('listening'));
    act(() => dictationHarness.emit?.('Draft the'));
    const send = screen.getByRole('button', { name: 'Send message' });
    expect(send).toBeEnabled();

    dictationHarness.finalTranscript = 'Draft the launch note';
    fireEvent.click(send);

    await waitFor(() => expect(dictationHarness.stop).toHaveBeenCalledOnce());
    // The tail, not the text as it stood when the click landed.
    await waitFor(() => expect(onSend).toHaveBeenCalledWith('Draft the launch note', [], undefined, undefined));
    expect(onSend).toHaveBeenCalledOnce();
  });

  it('keeps the draft and does not send when stopping to send fails', async () => {
    const onSend = vi.fn(async () => undefined);
    render(
      <Tooltip.Provider>
        <WorkstreamComposer
          api={{ getTranscriptionSocketTicket: vi.fn() }}
          attachments={[]}
          fileInputRef={createRef<HTMLInputElement>()}
          members={[]}
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

    act(() => dictationHarness.setState?.('listening'));
    act(() => dictationHarness.emit?.('Draft the'));
    dictationHarness.stopError = 'The dictation connection closed before transcription completed.';
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));

    await waitFor(() => expect(screen.getByText('The dictation connection closed before transcription completed.')).toBeVisible());
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox', { name: 'Message the work stream' })).toHaveValue('Draft the');
  });

  it('supports pointer click-to-toggle without double stopping', async () => {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    render(
      <Tooltip.Provider>
        <WorkstreamComposer
          api={{ getTranscriptionSocketTicket: vi.fn() }}
          attachments={[]}
          fileInputRef={createRef<HTMLInputElement>()}
          members={[]}
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

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Start voice input' }), { button: 0, pointerId: 1 });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Stop dictation' })).toBeVisible());
    now = 100;
    fireEvent.pointerUp(screen.getByRole('button', { name: 'Stop dictation' }), { button: 0, pointerId: 1 });
    expect(dictationHarness.stop).not.toHaveBeenCalled();

    now = 200;
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Stop dictation' }), { button: 0, pointerId: 2 });
    await waitFor(() => expect(dictationHarness.stop).toHaveBeenCalledOnce());
  });

  it('stops when a pointer press is held for the recording threshold', async () => {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    render(
      <Tooltip.Provider>
        <WorkstreamComposer
          api={{ getTranscriptionSocketTicket: vi.fn() }}
          attachments={[]}
          fileInputRef={createRef<HTMLInputElement>()}
          members={[]}
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

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Start voice input' }), { button: 0, pointerId: 1 });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Stop dictation' })).toBeVisible());
    now = 400;
    fireEvent.pointerUp(screen.getByRole('button', { name: 'Stop dictation' }), { button: 0, pointerId: 1 });
    await waitFor(() => expect(dictationHarness.stop).toHaveBeenCalledOnce());
  });

  it('shows the dictation error when the message error prop is an empty string', () => {
    render(
      <Tooltip.Provider>
        <WorkstreamComposer
          api={{ getTranscriptionSocketTicket: vi.fn() }}
          attachments={[]}
          error=""
          fileInputRef={createRef<HTMLInputElement>()}
          members={[]}
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

    act(() => dictationHarness.setError?.('Microphone disconnected.'));
    expect(screen.getByText('Microphone disconnected.')).toBeVisible();
  });
});
