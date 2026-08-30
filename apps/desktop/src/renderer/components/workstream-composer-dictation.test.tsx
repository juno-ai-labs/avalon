import * as Tooltip from '@radix-ui/react-tooltip';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as RealtimeDictationModule from '../lib/use-realtime-dictation';
import type { WorkstreamDetail } from '../lib/types';

const dictationHarness = vi.hoisted(() => ({
  emit: undefined as ((transcript: string) => void) | undefined,
  setError: undefined as ((error: string | undefined) => void) | undefined,
  setState: undefined as ((state: 'idle' | 'listening' | 'transcribing' | 'finalizing') => void) | undefined,
  start: vi.fn(),
  stop: vi.fn(),
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
      const [state, setState] = React.useState<'idle' | 'listening' | 'transcribing' | 'finalizing'>('idle');
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
  origin: 'ad_hoc',
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
  automationRuns: [],
};

beforeEach(() => {
  dictationHarness.emit = undefined;
  dictationHarness.setError = undefined;
  dictationHarness.setState = undefined;
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
    fireEvent.click(screen.getByRole('button', { name: 'Click or hold to dictate' }));
    await waitFor(() => expect(dictationHarness.start).toHaveBeenCalledOnce());

    act(() => dictationHarness.emit?.('live words'));

    expect(input).toHaveValue('Existing draft live words');
    expect(input).toHaveAttribute('readonly');
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();

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

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Click or hold to dictate' }), { button: 0, pointerId: 1 });
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

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Click or hold to dictate' }), { button: 0, pointerId: 1 });
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
