import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  appendDictationTranscript,
  isFinalTranscriptionEvent,
  nextLiveTranscript,
  useRealtimeDictation,
} from './use-realtime-dictation';
import { readDevicePreferences, setDeviceMicrophoneId } from './device-preferences';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  return {
    promise: new Promise<T>((next) => { resolve = next; }),
    resolve,
  };
}

class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readonly send = vi.fn();
  readyState = FakeWebSocket.OPEN;

  constructor(readonly url: string) {
    super();
    FakeWebSocket.instances.push(this);
  }

  close(): void {
    if (this.readyState >= FakeWebSocket.CLOSING) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatchEvent(new CloseEvent('close', { code: 1000 }));
  }
}

function mediaStream(trackStop = vi.fn()): MediaStream {
  return { getTracks: () => [{ stop: trackStop }] } as unknown as MediaStream;
}

function installMediaDevices(getUserMedia: ReturnType<typeof vi.fn>): void {
  vi.stubGlobal('navigator', {
    mediaDevices: {
      addEventListener: vi.fn(),
      enumerateDevices: vi.fn(async () => []),
      getUserMedia,
      removeEventListener: vi.fn(),
    },
  });
  vi.stubGlobal('WebSocket', FakeWebSocket);
}

afterEach(() => {
  FakeWebSocket.instances = [];
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

describe('realtime dictation transcript', () => {
  it('builds the visible draft from incremental transcript deltas', () => {
    const first = nextLiveTranscript('', {
      type: 'conversation.item.input_audio_transcription.delta',
      delta: 'Hello',
    });
    const second = nextLiveTranscript(first ?? '', {
      type: 'conversation.item.input_audio_transcription.delta',
      delta: ' world',
    });

    expect(second).toBe('Hello world');
    expect(appendDictationTranscript('Existing draft', second ?? '')).toBe('Existing draft Hello world');
  });

  it('reconciles the live partial with the final transcript', () => {
    expect(nextLiveTranscript('Hello wor', {
      type: 'conversation.item.input_audio_transcription.completed',
      transcript: 'Hello world.',
    })).toBe('Hello world.');
  });

  it('keeps post-commit deltas visible but waits for the completed event to finish', () => {
    expect(isFinalTranscriptionEvent({
      type: 'conversation.item.input_audio_transcription.delta',
      delta: 'partial',
    })).toBe(false);
    expect(isFinalTranscriptionEvent({
      type: 'conversation.item.input_audio_transcription.completed',
      transcript: 'final',
    })).toBe(true);
  });

  it('does not erase a saved microphone before device permission reveals stable ids', async () => {
    setDeviceMicrophoneId('studio-microphone');
    installMediaDevices(vi.fn());

    const { result } = renderHook(() => useRealtimeDictation(undefined, vi.fn()));

    await waitFor(() => expect(navigator.mediaDevices.enumerateDevices).toHaveBeenCalledOnce());
    expect(result.current.selectedDeviceId).toBe('studio-microphone');
    expect(readDevicePreferences().microphoneDeviceId).toBe('studio-microphone');
  });

  it('does not let a cancelled startup resume after a newer attempt begins', async () => {
    const firstTicket = deferred<{ url: string; ticket: string }>();
    const secondTicket = deferred<{ url: string; ticket: string }>();
    const firstStream = deferred<MediaStream>();
    const secondStream = deferred<MediaStream>();
    const firstTrackStop = vi.fn();
    const api = {
      getTranscriptionSocketTicket: vi.fn()
        .mockReturnValueOnce(firstTicket.promise)
        .mockReturnValueOnce(secondTicket.promise),
    };
    installMediaDevices(vi.fn()
      .mockReturnValueOnce(firstStream.promise)
      .mockReturnValueOnce(secondStream.promise));
    const { result, unmount } = renderHook(() => useRealtimeDictation(api, vi.fn()));

    let staleStart!: Promise<void>;
    act(() => { staleStart = result.current.start(); });
    await waitFor(() => expect(result.current.state).toBe('requesting'));
    await act(async () => result.current.stop());
    act(() => { void result.current.start(); });

    firstTicket.resolve({ url: 'wss://example.test/first', ticket: 'first' });
    firstStream.resolve(mediaStream(firstTrackStop));
    await act(async () => staleStart);

    expect(firstTrackStop).toHaveBeenCalled();
    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(api.getTranscriptionSocketTicket).toHaveBeenCalledTimes(2);
    unmount();
  });

  it('fails setup when the provider closes before acknowledging the session', async () => {
    const trackStop = vi.fn();
    installMediaDevices(vi.fn(async () => mediaStream(trackStop)));
    const api = {
      getTranscriptionSocketTicket: vi.fn(async () => ({
        url: 'wss://example.test/setup-close',
        ticket: 'ticket',
      })),
    };
    const { result } = renderHook(() => useRealtimeDictation(api, vi.fn()));

    let start!: Promise<void>;
    act(() => { start = result.current.start(); });
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    act(() => FakeWebSocket.instances[0]!.dispatchEvent(new CloseEvent('close', { code: 1011 })));
    await act(async () => start);

    expect(result.current.state).toBe('error');
    expect(result.current.error).toMatch(/closed during setup/i);
    expect(trackStop).toHaveBeenCalled();
  });

  it('does not misattribute a failed socket admission to Azure', async () => {
    installMediaDevices(vi.fn(async () => mediaStream()));
    const api = {
      getTranscriptionSocketTicket: vi.fn(async () => ({
        url: 'wss://example.test/setup-error',
        ticket: 'ticket',
      })),
    };
    const { result } = renderHook(() => useRealtimeDictation(api, vi.fn()));

    let start!: Promise<void>;
    act(() => { start = result.current.start(); });
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    act(() => FakeWebSocket.instances[0]!.dispatchEvent(new Event('error')));
    await act(async () => start);

    expect(result.current.error).toBe('Dictation could not connect to the transcription service.');
    expect(result.current.error).not.toMatch(/azure/iu);
  });
});
