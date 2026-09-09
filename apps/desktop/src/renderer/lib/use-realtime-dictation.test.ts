import { socketTicketProtocols } from '@rally/contracts/socket-tickets';
import type { SocketTicket } from './types';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  appendDictationTranscript,
  isFinalTranscriptionEvent,
  nextLiveTranscript,
  useRealtimeDictation,
} from './use-realtime-dictation';
import { readDevicePreferences, setDeviceMicrophoneId } from './device-preferences';

const systemAudioBridge = vi.hoisted(() => ({
  listener: undefined as ((data: ArrayBuffer, sampleRate: number) => void) | undefined,
  start: vi.fn(),
  stop: vi.fn(),
  subscribe: vi.fn(),
}));

vi.mock('./platform', () => ({
  desktopBridge: () => ({
    onMeetingSystemAudioData: systemAudioBridge.subscribe,
    startMeetingSystemAudioCapture: systemAudioBridge.start,
    stopMeetingSystemAudioCapture: systemAudioBridge.stop,
  }),
}));

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
  bufferedAmount = 0;
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
  const audioTrack = { kind: 'audio', readyState: 'live', stop: trackStop };
  return {
    getAudioTracks: () => [audioTrack],
    getTracks: () => [audioTrack],
  } as unknown as MediaStream;
}

function installMediaDevices(
  getUserMedia: ReturnType<typeof vi.fn>,
): void {
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

beforeEach(() => {
  systemAudioBridge.listener = undefined;
  systemAudioBridge.start.mockReset().mockResolvedValue({ channels: 1, sampleRate: 48_000 });
  systemAudioBridge.stop.mockReset().mockResolvedValue(undefined);
  systemAudioBridge.subscribe.mockReset().mockImplementation(
    (listener: (data: ArrayBuffer, sampleRate: number) => void) => {
      systemAudioBridge.listener = listener;
      return vi.fn(() => {
        if (systemAudioBridge.listener === listener) systemAudioBridge.listener = undefined;
      });
    },
  );
});

function installAudioGraph(options: { acknowledgeFlush?: boolean; flushBuffer?: ArrayBuffer } = {}): {
  contextCount: () => number;
  emitAudio: (buffer: ArrayBuffer) => void;
  acknowledgeFlush: () => void;
  systemAudioMessages: () => unknown[];
} {
  let createdContexts = 0;
  const workletNodes: FakeAudioWorkletNode[] = [];
  class FakeAudioNode {
    readonly connect = vi.fn(() => this);
    readonly disconnect = vi.fn();
  }
  class FakeGainNode extends FakeAudioNode {
    gain = { value: 1 };
  }
  class FakeAudioWorkletNode extends FakeAudioNode {
    constructor() {
      super();
      workletNodes.push(this);
    }
    port = {
      onmessage: null as ((event: MessageEvent<{ buffer?: ArrayBuffer; type: string }>) => void) | null,
      postMessage: vi.fn((message: unknown) => {
        if (message === 'pause') {
          this.port.onmessage?.(new MessageEvent('message', { data: { type: 'paused' } }));
          return;
        }
        if (message === 'resume') {
          this.port.onmessage?.(new MessageEvent('message', { data: { type: 'resumed' } }));
          return;
        }
        if (message !== 'flush') return;
        if (options.flushBuffer) this.port.onmessage?.(new MessageEvent('message', {
          data: { buffer: options.flushBuffer, type: 'audio' },
        }));
        if (options.acknowledgeFlush !== false) {
          this.port.onmessage?.(new MessageEvent('message', { data: { type: 'flushed' } }));
        }
      }),
    };
  }
  class FakeAudioContext {
    constructor() {
      createdContexts += 1;
    }
    state: AudioContextState = 'suspended';
    destination = new FakeAudioNode();
    audioWorklet = { addModule: vi.fn(async () => undefined) };
    close = vi.fn(async () => { this.state = 'closed'; });
    createGain = vi.fn(() => new FakeGainNode());
    createMediaStreamSource = vi.fn(() => new FakeAudioNode());
    resume = vi.fn(async () => { this.state = 'running'; });
    suspend = vi.fn(async () => { this.state = 'suspended'; });
  }
  vi.stubGlobal('AudioContext', FakeAudioContext);
  vi.stubGlobal('AudioWorkletNode', FakeAudioWorkletNode);
  return {
    contextCount: () => createdContexts,
    acknowledgeFlush: () => workletNodes[0]?.port.onmessage?.(new MessageEvent('message', {
      data: { type: 'flushed' },
    })),
    emitAudio: (buffer) => workletNodes[0]?.port.onmessage?.(new MessageEvent('message', {
      data: { buffer, type: 'audio' },
    })),
    systemAudioMessages: () => workletNodes[0]?.port.postMessage.mock.calls
      .map(([message]) => message)
      .filter((message) => typeof message === 'object' && message !== null
        && (message as { type?: unknown }).type === 'system-audio') ?? [],
  };
}

afterEach(() => {
  FakeWebSocket.instances = [];
  window.localStorage.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// One place that knows a ticket now carries its handshake subprotocols.
function socketTicket(url: string, ticket = 'ticket'): SocketTicket {
  return { url, ticket, protocols: socketTicketProtocols(ticket) };
}

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

  it('requests and cleans up microphone and computer audio together', async () => {
    const ticket = deferred<SocketTicket>();
    const microphoneStop = vi.fn();
    installMediaDevices(vi.fn(async () => mediaStream(microphoneStop)));
    const api = { getTranscriptionSocketTicket: vi.fn(() => ticket.promise) };
    const { result } = renderHook(() => useRealtimeDictation(api, vi.fn(), { includeSystemAudio: true }));

    let start!: Promise<void>;
    act(() => { start = result.current.start(); });
    await waitFor(() => expect(systemAudioBridge.start).toHaveBeenCalledOnce());
    await act(async () => result.current.stop());
    ticket.resolve(socketTicket('wss://example.test/system-audio', 'ticket'));
    await act(async () => start);

    expect(microphoneStop).toHaveBeenCalled();
    expect(systemAudioBridge.subscribe).toHaveBeenCalledOnce();
    expect(systemAudioBridge.stop).toHaveBeenCalledOnce();
  });

  it('drains native computer audio before flushing and committing the final transcript', async () => {
    const nativeDrain = deferred<void>();
    systemAudioBridge.stop.mockReturnValue(nativeDrain.promise);
    installMediaDevices(vi.fn(async () => mediaStream()));
    const audioGraph = installAudioGraph({ flushBuffer: new ArrayBuffer(480) });
    const api = {
      getTranscriptionSocketTicket: vi.fn(async () => (socketTicket('wss://example.test/native-drain', 'ticket'))),
    };
    const { result } = renderHook(() => useRealtimeDictation(api, vi.fn(), { includeSystemAudio: true }));

    let start!: Promise<void>;
    act(() => { start = result.current.start(); });
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.dispatchEvent(new MessageEvent('message', {
      data: JSON.stringify({ type: 'transcription_session.updated' }),
    })));
    await act(async () => start);

    let stop!: Promise<void>;
    act(() => { stop = result.current.stop(); });
    await waitFor(() => expect(systemAudioBridge.stop).toHaveBeenCalledOnce());
    act(() => systemAudioBridge.listener?.(new Float32Array([0.25, -0.25]).buffer, 48_000));
    expect(audioGraph.systemAudioMessages()).toHaveLength(1);
    expect(socket.send).not.toHaveBeenCalledWith(JSON.stringify({ type: 'input_audio_buffer.commit' }));

    nativeDrain.resolve(undefined);
    await waitFor(() => expect(socket.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'input_audio_buffer.commit' }),
    ));
    act(() => socket.dispatchEvent(new MessageEvent('message', {
      data: JSON.stringify({
        type: 'conversation.item.input_audio_transcription.completed',
        transcript: 'Final native audio was preserved.',
      }),
    })));
    await act(async () => stop);

    expect(result.current.state).toBe('idle');
  });

  it('pauses and resumes audio without replacing the transcription session or native tap', async () => {
    installMediaDevices(vi.fn(async () => mediaStream()));
    const audioGraph = installAudioGraph();
    const api = {
      getTranscriptionSocketTicket: vi.fn(async () => (socketTicket('wss://example.test/pause-resume', 'ticket'))),
    };
    const { result, unmount } = renderHook(() => useRealtimeDictation(api, vi.fn(), { includeSystemAudio: true }));

    let start!: Promise<void>;
    act(() => { start = result.current.start(); });
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    act(() => FakeWebSocket.instances[0]!.dispatchEvent(new MessageEvent('message', {
      data: JSON.stringify({ type: 'transcription_session.updated' }),
    })));
    await act(async () => start);

    await act(async () => result.current.pause());
    expect(result.current.state).toBe('paused');
    expect(systemAudioBridge.stop).not.toHaveBeenCalled();
    await act(async () => result.current.resume());

    expect(result.current.state).toBe('listening');
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(api.getTranscriptionSocketTicket).toHaveBeenCalledOnce();
    expect(audioGraph.contextCount()).toBe(1);
    expect(systemAudioBridge.start).toHaveBeenCalledOnce();
    expect(systemAudioBridge.stop).not.toHaveBeenCalled();
    unmount();
  });

  it('keeps recording the microphone when native computer audio is unavailable', async () => {
    const microphoneStop = vi.fn();
    systemAudioBridge.start.mockRejectedValue(new Error('Computer audio was not available.'));
    installMediaDevices(vi.fn(async () => mediaStream(microphoneStop)));
    const audioGraph = installAudioGraph();
    const api = {
      getTranscriptionSocketTicket: vi.fn(async () => (socketTicket('wss://example.test/no-system-audio', 'ticket'))),
    };
    const { result, unmount } = renderHook(() => useRealtimeDictation(api, vi.fn(), { includeSystemAudio: true }));

    let start!: Promise<void>;
    act(() => { start = result.current.start(); });
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    act(() => FakeWebSocket.instances[0]!.dispatchEvent(new MessageEvent('message', {
      data: JSON.stringify({ type: 'transcription_session.updated' }),
    })));
    await act(async () => start);

    expect(result.current.state).toBe('listening');
    expect(result.current.error).toBeUndefined();
    expect(result.current.warning).toMatch(/recording microphone only.*computer audio was not available/i);
    expect(systemAudioBridge.stop).not.toHaveBeenCalled();
    expect(microphoneStop).not.toHaveBeenCalled();
    act(() => audioGraph.emitAudio(new ArrayBuffer(4_800)));
    expect(FakeWebSocket.instances[0]!.send).toHaveBeenCalledWith(expect.stringContaining('input_audio_buffer.append'));
    unmount();
  });

  it('keeps recording the microphone when computer-audio permission is denied', async () => {
    const microphoneStop = vi.fn();
    systemAudioBridge.start.mockRejectedValue(new Error('Computer audio access is blocked.'));
    installMediaDevices(vi.fn(async () => mediaStream(microphoneStop)));
    const audioGraph = installAudioGraph();
    const api = {
      getTranscriptionSocketTicket: vi.fn(async () => (socketTicket('wss://example.test/system-audio-denied', 'ticket'))),
    };
    const { result, unmount } = renderHook(() => useRealtimeDictation(api, vi.fn(), { includeSystemAudio: true }));

    let start!: Promise<void>;
    act(() => { start = result.current.start(); });
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    act(() => FakeWebSocket.instances[0]!.dispatchEvent(new MessageEvent('message', {
      data: JSON.stringify({ type: 'transcription_session.updated' }),
    })));
    await act(async () => start);

    expect(result.current.state).toBe('listening');
    expect(result.current.error).toBeUndefined();
    expect(result.current.warning).toMatch(/recording microphone only.*computer audio access is blocked/i);
    expect(microphoneStop).not.toHaveBeenCalled();
    act(() => audioGraph.emitAudio(new ArrayBuffer(4_800)));
    expect(FakeWebSocket.instances[0]!.send).toHaveBeenCalledWith(expect.stringContaining('input_audio_buffer.append'));
    unmount();
  });

  it('keeps recording computer audio when microphone permission is denied', async () => {
    installMediaDevices(vi.fn(async () => { throw new DOMException('Permission denied', 'NotAllowedError'); }));
    const audioGraph = installAudioGraph();
    const api = {
      getTranscriptionSocketTicket: vi.fn(async () => (socketTicket('wss://example.test/microphone-denied', 'ticket'))),
    };
    const { result, unmount } = renderHook(() => useRealtimeDictation(api, vi.fn(), { includeSystemAudio: true }));

    let start!: Promise<void>;
    act(() => { start = result.current.start(); });
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    act(() => FakeWebSocket.instances[0]!.dispatchEvent(new MessageEvent('message', {
      data: JSON.stringify({ type: 'transcription_session.updated' }),
    })));
    await act(async () => start);

    expect(result.current.state).toBe('listening');
    expect(result.current.error).toBeUndefined();
    expect(result.current.warning).toMatch(/recording computer audio only.*microphone access is blocked/i);
    expect(systemAudioBridge.stop).not.toHaveBeenCalled();
    act(() => audioGraph.emitAudio(new ArrayBuffer(4_800)));
    expect(FakeWebSocket.instances[0]!.send).toHaveBeenCalledWith(expect.stringContaining('input_audio_buffer.append'));
    unmount();
  });

  it('reports an error without opening a socket when all requested audio inputs are denied', async () => {
    systemAudioBridge.start.mockRejectedValue(new Error('Computer audio access is blocked.'));
    installMediaDevices(vi.fn(async () => { throw new DOMException('Permission denied', 'NotAllowedError'); }));
    const api = {
      getTranscriptionSocketTicket: vi.fn(async () => (socketTicket('wss://example.test/all-audio-denied', 'ticket'))),
    };
    const { result } = renderHook(() => useRealtimeDictation(api, vi.fn(), { includeSystemAudio: true }));

    await act(async () => result.current.start());

    expect(result.current.state).toBe('error');
    expect(result.current.error).toMatch(/no audio input is available/i);
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it('commits transcript segments without replacing the socket or audio capture', async () => {
    const getUserMedia = vi.fn(async () => mediaStream());
    installMediaDevices(getUserMedia);
    const audioGraph = installAudioGraph();
    const onTranscript = vi.fn();
    const api = {
      getTranscriptionSocketTicket: vi.fn(async () => (socketTicket('wss://example.test/long-running-session', 'ticket'))),
    };
    const { result, unmount } = renderHook(() => useRealtimeDictation(api, onTranscript));

    let start!: Promise<void>;
    act(() => { start = result.current.start(); });
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    act(() => FakeWebSocket.instances[0]!.dispatchEvent(new MessageEvent('message', {
      data: JSON.stringify({ type: 'transcription_session.updated' }),
    })));
    await act(async () => start);
    expect(result.current.state).toBe('listening');

    let commit!: Promise<string>;
    act(() => { commit = result.current.commit(); });
    expect(FakeWebSocket.instances[0]!.send).toHaveBeenCalledWith(JSON.stringify({ type: 'input_audio_buffer.commit' }));
    const audioWhileCommitIsPending = new ArrayBuffer(4_800);
    act(() => audioGraph.emitAudio(audioWhileCommitIsPending));
    expect(FakeWebSocket.instances[0]!.send).toHaveBeenCalledWith(expect.stringContaining('input_audio_buffer.append'));
    act(() => FakeWebSocket.instances[0]!.dispatchEvent(new MessageEvent('message', {
      data: JSON.stringify({ type: 'future_provider_event', item_id: 'unrelated-item' }),
    })));
    act(() => FakeWebSocket.instances[0]!.dispatchEvent(new MessageEvent('message', {
      data: JSON.stringify({
        type: 'conversation.item.input_audio_transcription.completed',
        transcript: 'Finalized first segment.',
        item_id: 'correct-item',
      }),
    })));
    await expect(commit).resolves.toBe('Finalized first segment.');

    expect(result.current.state).toBe('listening');
    const continuedAudio = new ArrayBuffer(4_800);
    act(() => audioGraph.emitAudio(continuedAudio));
    expect(getUserMedia).toHaveBeenCalledOnce();
    expect(audioGraph.contextCount()).toBe(1);
    expect(api.getTranscriptionSocketTicket).toHaveBeenCalledOnce();
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.instances[0]!.send).toHaveBeenCalledWith(expect.stringContaining('input_audio_buffer.append'));
    unmount();
  });

  it('flushes the final partial audio before commit and waits for its matching transcript', async () => {
    installMediaDevices(vi.fn(async () => mediaStream()));
    const audioGraph = installAudioGraph({ flushBuffer: new ArrayBuffer(480) });
    const onTranscript = vi.fn();
    const api = {
      getTranscriptionSocketTicket: vi.fn(async () => (socketTicket('wss://example.test/final-buffer', 'ticket'))),
    };
    const { result } = renderHook(() => useRealtimeDictation(api, onTranscript));

    let start!: Promise<void>;
    act(() => { start = result.current.start(); });
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.dispatchEvent(new MessageEvent('message', {
      data: JSON.stringify({ type: 'transcription_session.updated' }),
    })));
    await act(async () => start);

    let stop!: Promise<void>;
    let settled = false;
    act(() => {
      stop = result.current.stop();
      void stop.then(() => { settled = true; });
    });
    await waitFor(() => expect(result.current.state).toBe('finalizing'));
    await waitFor(() => expect(socket.send).toHaveBeenCalledWith(JSON.stringify({ type: 'input_audio_buffer.commit' })));
    const sentTypes = socket.send.mock.calls.map(([value]) => JSON.parse(String(value)).type as string);
    expect(sentTypes.slice(-2)).toEqual(['input_audio_buffer.append', 'input_audio_buffer.commit']);
    expect(settled).toBe(false);
    let duplicateStop!: Promise<void>;
    act(() => { duplicateStop = result.current.stop(); });

    act(() => socket.dispatchEvent(new MessageEvent('message', {
      data: JSON.stringify({ type: 'input_audio_buffer.committed', item_id: 'final-item' }),
    })));
    act(() => socket.dispatchEvent(new MessageEvent('message', {
      data: JSON.stringify({
        type: 'conversation.item.input_audio_transcription.completed',
        item_id: 'older-item',
        transcript: 'Older transcript that arrived late.',
      }),
    })));
    expect(result.current.state).toBe('finalizing');
    expect(settled).toBe(false);

    act(() => socket.dispatchEvent(new MessageEvent('message', {
      data: JSON.stringify({
        type: 'conversation.item.input_audio_transcription.completed',
        item_id: 'final-item',
        transcript: 'The final buffered word.',
      }),
    })));
    await act(async () => Promise.all([stop, duplicateStop]));

    expect(result.current.state).toBe('idle');
    expect(onTranscript).toHaveBeenCalledWith('The final buffered word.');
    expect(audioGraph.contextCount()).toBe(1);
  });

  it('fails finalization when the audio worklet does not acknowledge its flush', async () => {
    const trackStop = vi.fn();
    installMediaDevices(vi.fn(async () => mediaStream(trackStop)));
    installAudioGraph({ acknowledgeFlush: false });
    const api = {
      getTranscriptionSocketTicket: vi.fn(async () => (socketTicket('wss://example.test/missing-flush', 'ticket'))),
    };
    const { result } = renderHook(() => useRealtimeDictation(api, vi.fn()));

    let start!: Promise<void>;
    act(() => { start = result.current.start(); });
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    act(() => FakeWebSocket.instances[0]!.dispatchEvent(new MessageEvent('message', {
      data: JSON.stringify({ type: 'transcription_session.updated' }),
    })));
    await act(async () => start);

    vi.useFakeTimers();
    let stop!: Promise<void>;
    act(() => { stop = result.current.stop(); });
    const rejection = expect(stop).rejects.toThrow(/did not acknowledge its final buffered samples/i);
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    await rejection;

    expect(result.current.state).toBe('error');
    expect(trackStop).toHaveBeenCalled();
    expect(FakeWebSocket.instances[0]!.send).not.toHaveBeenCalledWith(
      JSON.stringify({ type: 'input_audio_buffer.commit' }),
    );
  });

  it('rejects the pending Stop when the socket closes while final audio is flushing', async () => {
    installMediaDevices(vi.fn(async () => mediaStream()));
    const audioGraph = installAudioGraph({ acknowledgeFlush: false });
    const api = {
      getTranscriptionSocketTicket: vi.fn(async () => (socketTicket('wss://example.test/close-during-flush', 'ticket'))),
    };
    const { result } = renderHook(() => useRealtimeDictation(api, vi.fn()));

    let start!: Promise<void>;
    act(() => { start = result.current.start(); });
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.dispatchEvent(new MessageEvent('message', {
      data: JSON.stringify({ type: 'transcription_session.updated' }),
    })));
    await act(async () => start);

    let stop!: Promise<void>;
    act(() => { stop = result.current.stop(); });
    const rejection = expect(stop).rejects.toThrow(/connection closed unexpectedly/i);
    act(() => socket.dispatchEvent(new CloseEvent('close', { code: 1011 })));
    act(() => audioGraph.acknowledgeFlush());
    await rejection;

    expect(result.current.state).toBe('error');
  });

  it('stops capture when WebSocket backpressure grows beyond the bounded queue', async () => {
    const trackStop = vi.fn();
    installMediaDevices(vi.fn(async () => mediaStream(trackStop)));
    const audioGraph = installAudioGraph();
    const api = {
      getTranscriptionSocketTicket: vi.fn(async () => (socketTicket('wss://example.test/backpressure', 'ticket'))),
    };
    const { result } = renderHook(() => useRealtimeDictation(api, vi.fn()));

    let start!: Promise<void>;
    act(() => { start = result.current.start(); });
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.dispatchEvent(new MessageEvent('message', {
      data: JSON.stringify({ type: 'transcription_session.updated' }),
    })));
    await act(async () => start);
    socket.bufferedAmount = (4 * 1_024 * 1_024) + 1;

    act(() => audioGraph.emitAudio(new ArrayBuffer(4_800)));

    await waitFor(() => expect(result.current.state).toBe('error'));
    expect(result.current.error).toMatch(/network could not keep up/i);
    await waitFor(() => expect(trackStop).toHaveBeenCalled());
  });

  it('ends the session instead of misattributing a late segment after a commit timeout', async () => {
    const trackStop = vi.fn();
    installMediaDevices(vi.fn(async () => mediaStream(trackStop)));
    installAudioGraph();
    const api = {
      getTranscriptionSocketTicket: vi.fn(async () => (socketTicket('wss://example.test/slow-segment-commit', 'ticket'))),
    };
    const { result, unmount } = renderHook(() => useRealtimeDictation(api, vi.fn()));

    let start!: Promise<void>;
    act(() => { start = result.current.start(); });
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.dispatchEvent(new MessageEvent('message', {
      data: JSON.stringify({ type: 'transcription_session.updated' }),
    })));
    await act(async () => start);
    expect(result.current.state).toBe('listening');

    vi.useFakeTimers();
    let commit!: Promise<string>;
    act(() => { commit = result.current.commit(); });
    const rejection = expect(commit).rejects.toThrow(/did not return this segment/i);
    await act(async () => vi.advanceTimersByTimeAsync(60_000));

    await rejection;
    expect(result.current.state).toBe('error');
    expect(result.current.error).toMatch(/did not return this segment/i);
    expect(trackStop).toHaveBeenCalled();
    unmount();
  });

  it('stops retained media after an in-place segment commit', async () => {
    const trackStop = vi.fn();
    installMediaDevices(vi.fn(async () => mediaStream(trackStop)));
    installAudioGraph();
    const api = {
      getTranscriptionSocketTicket: vi.fn(async () => (socketTicket('wss://example.test/handoff-stop', 'ticket'))),
    };
    const { result } = renderHook(() => useRealtimeDictation(api, vi.fn()));

    let start!: Promise<void>;
    act(() => { start = result.current.start(); });
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    act(() => FakeWebSocket.instances[0]!.dispatchEvent(new MessageEvent('message', {
      data: JSON.stringify({ type: 'transcription_session.updated' }),
    })));
    await act(async () => start);
    let commit!: Promise<string>;
    act(() => { commit = result.current.commit(); });
    act(() => FakeWebSocket.instances[0]!.dispatchEvent(new MessageEvent('message', {
      data: JSON.stringify({
        type: 'conversation.item.input_audio_transcription.completed',
        transcript: 'Finalized before stopping.',
      }),
    })));
    await act(async () => commit);
    expect(result.current.state).toBe('listening');

    let stop!: Promise<void>;
    act(() => { stop = result.current.stop(); });
    act(() => FakeWebSocket.instances[0]!.dispatchEvent(new MessageEvent('message', {
      data: JSON.stringify({
        type: 'conversation.item.input_audio_transcription.completed',
        transcript: 'Final segment.',
      }),
    })));
    await act(async () => stop);

    expect(trackStop).toHaveBeenCalled();
  });

  it('uses the operating-system default microphone for meeting capture', async () => {
    setDeviceMicrophoneId('previously-selected-microphone');
    const getUserMedia = vi.fn(async () => mediaStream());
    installMediaDevices(getUserMedia);
    const api = {
      getTranscriptionSocketTicket: vi.fn(async () => (socketTicket('wss://example.test/default-microphone', 'ticket'))),
    };
    const { result } = renderHook(() => useRealtimeDictation(api, vi.fn(), {
      useSystemDefaultMicrophone: true,
    }));

    let start!: Promise<void>;
    act(() => { start = result.current.start(); });
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    act(() => FakeWebSocket.instances[0]!.dispatchEvent(new MessageEvent('message', {
      data: JSON.stringify({ type: 'transcription_session.updated' }),
    })));
    await act(async () => start);

    expect(getUserMedia).toHaveBeenCalledWith({
      audio: expect.not.objectContaining({ deviceId: expect.anything() }),
    });
  });

  it('does not let a cancelled startup resume after a newer attempt begins', async () => {
    const firstTicket = deferred<SocketTicket>();
    const secondTicket = deferred<SocketTicket>();
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

    firstTicket.resolve(socketTicket('wss://example.test/first', 'first'));
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
      getTranscriptionSocketTicket: vi.fn(async () => (socketTicket('wss://example.test/setup-close', 'ticket'))),
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
      getTranscriptionSocketTicket: vi.fn(async () => (socketTicket('wss://example.test/setup-error', 'ticket'))),
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
