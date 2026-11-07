import * as Tooltip from '@radix-ui/react-tooltip';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as RealtimeDictationModule from '../lib/use-realtime-dictation';
import type { WorkstreamDetail } from '../lib/types';

const dictationHarness = vi.hoisted(() => ({
  emit: undefined as ((transcript: string) => void) | undefined,
  emitLevel: undefined as ((level: number) => void) | undefined,
  prefetch: vi.fn(),
  // Where `start` lands: the real hook sits in `requesting` until the
  // microphone opens, and only then reaches `listening`.
  startState: 'listening' as 'listening' | 'requesting',
  // What `stop` writes out before it settles, standing in for the tail the real
  // hook drains: it delivers the final transcript and only then finishes the
  // attempt, so a caller that submits on `stop` resolving is a render behind it.
  finalTranscript: undefined as string | undefined,
  setError: undefined as ((error: string | undefined) => void) | undefined,
  setState: undefined as ((state: 'idle' | 'listening' | 'transcribing' | 'finalizing' | 'error') => void) | undefined,
  start: vi.fn(),
  stop: vi.fn(),
  stopError: undefined as string | undefined,
  // A finalization that never answers, which the real hook holds open for its
  // 60s completion timeout before failing.
  stopHangs: false,
}));

vi.mock('../lib/use-realtime-dictation', async (importOriginal) => {
  const React = await import('react');
  const actual = await importOriginal<typeof RealtimeDictationModule>();
  return {
    ...actual,
    useRealtimeDictation: (
      _api: unknown,
      onTranscript: (transcript: string) => void,
      options?: { onLevel?: (level: number) => void },
    ) => {
      const [state, setState] = React.useState<'idle' | 'requesting' | 'listening' | 'transcribing' | 'finalizing' | 'error'>('idle');
      const [error, setError] = React.useState<string>();
      dictationHarness.emit = onTranscript;
      dictationHarness.emitLevel = options?.onLevel;
      dictationHarness.setError = setError;
      dictationHarness.setState = setState;
      return {
        clearError: () => {
          setError(undefined);
          if (state === 'error') setState('idle');
        },
        devices: [],
        ...(error ? { error } : {}),
        prefetch: dictationHarness.prefetch,
        selectedDeviceId: 'default',
        setSelectedDeviceId: vi.fn(),
        start: async () => {
          dictationHarness.start();
          setState(dictationHarness.startState);
        },
        state,
        stop: async () => {
          dictationHarness.stop();
          if (dictationHarness.stopHangs) {
            setState('finalizing');
            return new Promise<void>(() => undefined);
          }
          // `finish(attempt, 'error', …)` is where a drain or socket failure
          // lands. It rejects the finalization promise that `stop` returned and
          // then moves to `error`, so the returned promise rejects as well as
          // the state changing — a caller that only watches the state leaves
          // that rejection unhandled, which Vitest fails the run for.
          if (dictationHarness.stopError !== undefined) {
            const failure = new Error(dictationHarness.stopError);
            setError(dictationHarness.stopError);
            setState('error');
            throw failure;
          }
          if (dictationHarness.finalTranscript !== undefined) onTranscript(dictationHarness.finalTranscript);
          setState('idle');
        },
      };
    },
  };
});

import { WorkstreamComposer } from './workstream-composer';
import { MessageIssueProvider } from './message-issue-dialog';
import { MessageActions } from './workstream-blocks';
import { asSubstreamId } from '@rally/contracts';

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
  dictationHarness.emitLevel = undefined;
  dictationHarness.prefetch.mockReset();
  dictationHarness.startState = 'listening';
  dictationHarness.finalTranscript = undefined;
  dictationHarness.setError = undefined;
  dictationHarness.setState = undefined;
  dictationHarness.stopError = undefined;
  dictationHarness.stopHangs = false;
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
          draftKey="test-draft"
          api={{ getTranscriptionSocketTicket: vi.fn(), prefetchTranscriptionSocketTicket: vi.fn() }}
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

    const input = screen.getByRole('textbox', { name: 'Message Rally' });
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

  it('keeps the newest transcript words in view once the field is at its height limit', async () => {
    render(
      <Tooltip.Provider>
        <WorkstreamComposer
          draftKey="test-draft"
          api={{ getTranscriptionSocketTicket: vi.fn(), prefetchTranscriptionSocketTicket: vi.fn() }}
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

    // jsdom lays nothing out: the content height is declared, and the scroll
    // position is recorded as the field is told to move it.
    const input = screen.getByRole('textbox', { name: 'Message Rally' });
    Object.defineProperty(input, 'scrollHeight', { configurable: true, value: 400 });
    const scrolledTo: number[] = [];
    Object.defineProperty(input, 'scrollTop', {
      configurable: true,
      get: () => scrolledTo.at(-1) ?? 0,
      set: (top: number) => { scrolledTo.push(top); },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Start voice input' }));
    await waitFor(() => expect(dictationHarness.start).toHaveBeenCalledOnce());

    act(() => dictationHarness.emit?.('a transcript long enough to have gone past the fold'));

    expect(scrolledTo.at(-1)).toBe(400);
  });

  it('does not move a later edit to the end after a dictation that heard nothing', async () => {
    render(
      <Tooltip.Provider>
        <WorkstreamComposer
          draftKey="test-draft"
          api={{ getTranscriptionSocketTicket: vi.fn(), prefetchTranscriptionSocketTicket: vi.fn() }}
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

    const input = screen.getByRole('textbox', { name: 'Message Rally' });
    fireEvent.change(input, { target: { value: 'A draft taller than the field' } });
    Object.defineProperty(input, 'scrollHeight', { configurable: true, value: 400 });
    const scrolledTo: number[] = [];
    Object.defineProperty(input, 'scrollTop', {
      configurable: true,
      get: () => scrolledTo.at(-1) ?? 0,
      set: (top: number) => { scrolledTo.push(top); },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Start voice input' }));
    await waitFor(() => expect(dictationHarness.start).toHaveBeenCalledOnce());
    // The empty transcript a start sends, then a recording that hears nothing.
    act(() => dictationHarness.emit?.(''));
    act(() => dictationHarness.setState?.('idle'));

    fireEvent.change(input, { target: { value: 'A draft taller than the field, edited' } });

    expect(scrolledTo).toEqual([]);
  });

  it('lets the user cancel finalization by editing or using the microphone control', async () => {
    const onSend = vi.fn(async () => undefined);
    render(
      <Tooltip.Provider>
        <WorkstreamComposer
          draftKey="test-draft"
          api={{ getTranscriptionSocketTicket: vi.fn(), prefetchTranscriptionSocketTicket: vi.fn() }}
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

    const input = screen.getByRole('textbox', { name: 'Message Rally' });
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
          draftKey="test-draft"
          api={{ getTranscriptionSocketTicket: vi.fn(), prefetchTranscriptionSocketTicket: vi.fn() }}
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

    const input = screen.getByRole('textbox', { name: 'Message Rally' });
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
          draftKey="test-draft"
          api={{ getTranscriptionSocketTicket: vi.fn(), prefetchTranscriptionSocketTicket: vi.fn() }}
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

  it('stops and sends a recording that has not produced a transcript yet', async () => {
    const onSend = vi.fn(async () => undefined);
    render(
      <Tooltip.Provider>
        <WorkstreamComposer
          draftKey="test-draft"
          api={{ getTranscriptionSocketTicket: vi.fn(), prefetchTranscriptionSocketTicket: vi.fn() }}
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

    // Nothing has been typed and no partial has arrived, so the host still
    // calls the draft empty — but the recording may hold a whole sentence that
    // only lands on the final commit, and Send has to be able to reach it.
    act(() => dictationHarness.setState?.('listening'));
    const send = screen.getByRole('button', { name: 'Send message' });
    expect(send).toBeEnabled();

    dictationHarness.finalTranscript = 'Everything I said at once';
    fireEvent.click(send);

    await waitFor(() => expect(dictationHarness.stop).toHaveBeenCalledOnce());
    await waitFor(() => expect(onSend).toHaveBeenCalledWith('Everything I said at once', [], undefined, undefined));
  });

  it('stops without sending when the recording produced nothing', async () => {
    const onSend = vi.fn(async () => undefined);
    render(
      <Tooltip.Provider>
        <WorkstreamComposer
          draftKey="test-draft"
          api={{ getTranscriptionSocketTicket: vi.fn(), prefetchTranscriptionSocketTicket: vi.fn() }}
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
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));

    await waitFor(() => expect(dictationHarness.stop).toHaveBeenCalledOnce());
    // Silence stops the recording and sends nothing; it must not post an empty
    // message just because Send was allowed to reach the stop.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled());
    expect(onSend).not.toHaveBeenCalled();
  });

  it('keeps the draft and does not send when stopping to send fails', async () => {
    const onSend = vi.fn(async () => undefined);
    render(
      <Tooltip.Provider>
        <WorkstreamComposer
          draftKey="test-draft"
          api={{ getTranscriptionSocketTicket: vi.fn(), prefetchTranscriptionSocketTicket: vi.fn() }}
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
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox', { name: 'Message Rally' })).toHaveValue('Draft the');
  });

  it('lets the microphone cancel a send whose finalization never answers', async () => {
    const onSend = vi.fn(async () => undefined);
    render(
      <Tooltip.Provider>
        <WorkstreamComposer
          draftKey="test-draft"
          api={{ getTranscriptionSocketTicket: vi.fn(), prefetchTranscriptionSocketTicket: vi.fn() }}
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
    act(() => dictationHarness.emit?.('Draft the launch note'));
    dictationHarness.stopHangs = true;
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));

    // Send is spinning, Enter returns on the pending flag, and the field is
    // read-only while finalizing — the microphone is the only control left.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled());
    const microphone = screen.getByRole('button', { name: 'Cancel sending' });
    fireEvent.pointerDown(microphone, { button: 0 });

    await waitFor(() => expect(screen.getByRole('button', { name: 'Send message' })).toBeEnabled());
    expect(onSend).not.toHaveBeenCalled();
    // The drain is left to finish on its own; the transcript stays in the draft.
    expect(screen.getByRole('textbox', { name: 'Message Rally' })).toHaveValue('Draft the launch note');
    expect(dictationHarness.stop).toHaveBeenCalledOnce();
  });

  it('supports pointer click-to-toggle without double stopping', async () => {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    render(
      <Tooltip.Provider>
        <WorkstreamComposer
          draftKey="test-draft"
          api={{ getTranscriptionSocketTicket: vi.fn(), prefetchTranscriptionSocketTicket: vi.fn() }}
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
          draftKey="test-draft"
          api={{ getTranscriptionSocketTicket: vi.fn(), prefetchTranscriptionSocketTicket: vi.fn() }}
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

  it('arms the microphone on the press, and fills it only once capture is listening', async () => {
    dictationHarness.startState = 'requesting';
    render(
      <Tooltip.Provider>
        <WorkstreamComposer
          draftKey="test-draft"
          api={{ getTranscriptionSocketTicket: vi.fn(), prefetchTranscriptionSocketTicket: vi.fn() }}
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
    await waitFor(() => expect(dictationHarness.start).toHaveBeenCalledOnce());
    const button = screen.getByRole('button', { name: 'Stop dictation' });
    const control = button.closest('.microphone-control');
    expect(control).toHaveClass('is-arming');
    expect(control).not.toHaveClass('is-listening');
    // The glyph stays while the stylesheet turns an arc around it; a spinner
    // in its place would read as loading rather than as the microphone opening.
    expect(button.querySelector('.spin')).toBeNull();

    act(() => dictationHarness.setState?.('listening'));
    expect(control).toHaveClass('is-listening');
    expect(control).not.toHaveClass('is-arming');
  });

  it('asks for a ticket when the pointer or focus reaches the microphone', () => {
    render(
      <Tooltip.Provider>
        <WorkstreamComposer
          draftKey="test-draft"
          api={{ getTranscriptionSocketTicket: vi.fn(), prefetchTranscriptionSocketTicket: vi.fn() }}
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

    const button = screen.getByRole('button', { name: 'Start voice input' });
    fireEvent.pointerEnter(button);
    expect(dictationHarness.prefetch).toHaveBeenCalledTimes(1);
    fireEvent.focus(button);
    expect(dictationHarness.prefetch).toHaveBeenCalledTimes(2);
  });

  it('paints the level the hook reports onto the microphone control', () => {
    render(
      <Tooltip.Provider>
        <WorkstreamComposer
          draftKey="test-draft"
          api={{ getTranscriptionSocketTicket: vi.fn(), prefetchTranscriptionSocketTicket: vi.fn() }}
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

    act(() => dictationHarness.setState?.('listening'));
    act(() => dictationHarness.emitLevel?.(0.6));
    const control = screen.getByRole('button', { name: 'Stop dictation' }).closest('.microphone-control') as HTMLElement;
    expect(control.style.getPropertyValue('--dictation-level')).toBe('0.600');
  });

  it('shows the dictation error when the message error prop is an empty string', () => {
    render(
      <Tooltip.Provider>
        <WorkstreamComposer
          draftKey="test-draft"
          api={{ getTranscriptionSocketTicket: vi.fn(), prefetchTranscriptionSocketTicket: vi.fn() }}
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

  it.each(['edit', 'send'] as const)('clears a failed recording notice when the user chooses to %s', async (action) => {
    const onSend = vi.fn(async () => undefined);
    render(
      <Tooltip.Provider>
        <WorkstreamComposer
          draftKey="test-draft"
          api={{ getTranscriptionSocketTicket: vi.fn(), prefetchTranscriptionSocketTicket: vi.fn() }}
          attachments={[]}
          fileInputRef={createRef<HTMLInputElement>()}
          members={[]}
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

    const input = screen.getByRole('textbox', { name: 'Message Rally' });
    fireEvent.change(input, { target: { value: 'Keep the recovered transcript' } });
    act(() => {
      dictationHarness.setState?.('error');
      dictationHarness.setError?.('Dictation audio arrived too quickly.');
    });
    expect(screen.getByRole('alertdialog')).toHaveTextContent('Dictation audio arrived too quickly.');
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    expect(input).toHaveValue('Keep the recovered transcript');
    expect(onSend).not.toHaveBeenCalled();

    if (action === 'edit') {
      fireEvent.change(input, { target: { value: 'Keep the recovered transcript and continue typing' } });
      expect(onSend).not.toHaveBeenCalled();
    } else {
      fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
      await waitFor(() => expect(onSend).toHaveBeenCalledOnce());
      expect(onSend).toHaveBeenCalledWith('Keep the recovered transcript', [], undefined, undefined);
    }
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });
});


describe('Oopsie footer dictation submission', () => {
  it('finalizes an empty recording through the footer Send before reporting', async () => {
    const createMessageIssue = vi.fn(async () => ({ id: 'report-id', createdAt: '2026-10-22T00:00:00.000Z' }));
    render(<Tooltip.Provider><MessageIssueProvider
      api={{ createMessageIssue, getTranscriptionSocketTicket: vi.fn(), prefetchTranscriptionSocketTicket: vi.fn() }}
      target={{ kind: 'conversation', parentId: '00000000-0000-7000-8000-00000000db13', substreamId: asSubstreamId('0') }}
    >
      <MessageActions telemetry={{ messageId: 'turn-1' }} text="Answer" />
    </MessageIssueProvider></Tooltip.Provider>);
    fireEvent.click(screen.getByRole('button', { name: 'Oopsie' }));
    const send = screen.getByRole('button', { name: 'Send' });
    expect(send).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Start voice input' }));
    await waitFor(() => expect(send).toBeEnabled());
    dictationHarness.finalTranscript = 'I expected a different answer.';
    fireEvent.click(send);
    await waitFor(() => expect(createMessageIssue).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      description: 'I expected a different answer.', messageId: 'turn-1',
    })));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
