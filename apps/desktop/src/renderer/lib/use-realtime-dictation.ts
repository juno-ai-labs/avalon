import { useCallback, useEffect, useRef, useState } from 'react';
import type { AvalonApi } from './api';
import { readDevicePreferences, setDeviceMicrophoneId } from './device-preferences';

export type DictationState = 'idle' | 'requesting' | 'connecting' | 'listening' | 'transcribing' | 'error';

export interface MicrophoneDevice {
  deviceId: string;
  label: string;
}

interface AudioCapture {
  start: () => Promise<void>;
  stop: (flush?: boolean) => Promise<void>;
}

interface DictationAttempt {
  id: number;
  socket?: WebSocket;
  capture?: AudioCapture;
  stream?: MediaStream;
  transcript: string;
  completionTimer?: number;
}

const COMPLETION_TIMEOUT_MS = 15_000;

interface RealtimeTranscriptionEvent {
  type?: string;
  delta?: string;
  text?: string;
  transcript?: string;
  error?: { message?: string };
}

export function appendDictationTranscript(base: string, transcript: string): string {
  if (!transcript) return base;
  if (!base || /\s$/u.test(base)) return `${base}${transcript}`;
  return `${base} ${transcript}`;
}

export function nextLiveTranscript(
  current: string,
  event: RealtimeTranscriptionEvent,
): string | undefined {
  if (
    (event.type === 'conversation.item.input_audio_transcription.delta' || event.type === 'response.text.delta')
    && typeof event.delta === 'string'
  ) return current + event.delta;
  if (event.type === 'conversation.item.input_audio_transcription.completed' && typeof event.transcript === 'string') {
    return event.transcript;
  }
  if (event.type === 'response.text.done' && typeof event.text === 'string') return event.text;
  return undefined;
}

export function isFinalTranscriptionEvent(event: RealtimeTranscriptionEvent): boolean {
  return event.type === 'conversation.item.input_audio_transcription.completed'
    || event.type === 'response.text.done';
}

function microphoneErrorMessage(error: unknown): string {
  if (error instanceof DOMException && error.name === 'NotAllowedError') {
    return 'Microphone access is blocked. Allow it in System Settings and try again.';
  }
  if (error instanceof DOMException && (error.name === 'NotFoundError' || error.name === 'OverconstrainedError')) {
    return 'The selected microphone is unavailable.';
  }
  return error instanceof Error ? error.message : 'Dictation could not start.';
}

function bytesToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 1) binary += String.fromCharCode(bytes[offset]!);
  return btoa(binary);
}

function providerErrorMessage(event: RealtimeTranscriptionEvent): string {
  return event.error?.message ?? 'The transcription service could not transcribe this recording.';
}

function parseRealtimeEvent(data: unknown): RealtimeTranscriptionEvent | undefined {
  try {
    const parsed: unknown = JSON.parse(String(data));
    return parsed && typeof parsed === 'object' ? parsed as RealtimeTranscriptionEvent : undefined;
  } catch {
    return undefined;
  }
}

async function waitForTranscriptionSession(
  socket: WebSocket,
  onEvent: (event: RealtimeTranscriptionEvent) => void,
  onUnexpectedClose: () => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let ready = false;
    let settled = false;
    const timer = window.setTimeout(() => {
      socket.close();
      reject(new Error('Dictation took too long to connect.'));
    }, 10_000);

    const failBeforeReady = (message: string): void => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      reject(new Error(message));
    };

    socket.addEventListener('message', (messageEvent) => {
      const event = parseRealtimeEvent(messageEvent.data);
      if (!event) return;
      if ((event.type === 'session.updated' || event.type === 'transcription_session.updated') && !settled) {
        ready = true;
        settled = true;
        window.clearTimeout(timer);
        resolve();
        return;
      }
      if (event.type === 'error' && !ready) {
        failBeforeReady(providerErrorMessage(event));
        return;
      }
      onEvent(event);
    });
    socket.addEventListener('error', () => {
      if (!ready) failBeforeReady('Dictation could not connect to the transcription service.');
      else onUnexpectedClose();
    });
    socket.addEventListener('close', () => {
      if (!ready) failBeforeReady('The dictation connection closed during setup.');
      else onUnexpectedClose();
    });
  });
}

async function createAudioCapture(stream: MediaStream, onAudio: (buffer: ArrayBuffer) => void): Promise<AudioCapture> {
  const context = new AudioContext({ sampleRate: 24_000 });
  let source: MediaStreamAudioSourceNode | undefined;
  let node: AudioWorkletNode | undefined;
  let silence: GainNode | undefined;
  try {
    await context.suspend();
    await context.audioWorklet.addModule(new URL('../audio/pcm16-capture-worklet.js?no-inline', import.meta.url));
    source = context.createMediaStreamSource(stream);
    node = new AudioWorkletNode(context, 'avalon-pcm16-capture');
    silence = context.createGain();
    silence.gain.value = 0;
    source.connect(node);
    node.connect(silence);
    silence.connect(context.destination);
  } catch (error) {
    try { source?.disconnect(); } catch { /* Already disconnected. */ }
    try { node?.disconnect(); } catch { /* Already disconnected. */ }
    try { silence?.disconnect(); } catch { /* Already disconnected. */ }
    try { await context.close(); } catch { /* Preserve the setup error. */ }
    throw error;
  }

  let stopped = false;
  let resolveFlush: (() => void) | undefined;
  node.port.onmessage = (event: MessageEvent<{ type?: string; buffer?: ArrayBuffer }>) => {
    if (event.data.type === 'audio' && event.data.buffer) onAudio(event.data.buffer);
    if (event.data.type === 'flushed') resolveFlush?.();
  };

  return {
    async start() {
      if (!stopped) await context.resume();
    },
    async stop(flush = false) {
      if (stopped) return;
      stopped = true;
      let failure: unknown;
      let flushTimer: number | undefined;
      try {
        if (flush && context.state === 'running') {
          await new Promise<void>((resolve, reject) => {
            resolveFlush = resolve;
            flushTimer = window.setTimeout(resolve, 250);
            try {
              node.port.postMessage('flush');
            } catch (error) {
              reject(error);
            }
          });
        }
      } catch (error) {
        failure = error;
      } finally {
        if (flushTimer !== undefined) window.clearTimeout(flushTimer);
        node.port.onmessage = null;
        for (const track of stream.getTracks()) {
          try { track.stop(); } catch (error) { failure ??= error; }
        }
        try { source.disconnect(); } catch (error) { failure ??= error; }
        try { node.disconnect(); } catch (error) { failure ??= error; }
        try { silence.disconnect(); } catch (error) { failure ??= error; }
        try { await context.close(); } catch (error) { failure ??= error; }
      }
      if (failure) throw failure;
    },
  };
}

async function cleanupAttempt(attempt: DictationAttempt): Promise<void> {
  if (attempt.completionTimer !== undefined) {
    window.clearTimeout(attempt.completionTimer);
    attempt.completionTimer = undefined;
  }
  let failure: unknown;
  if (attempt.capture) {
    try { await attempt.capture.stop(); } catch (error) { failure = error; }
  }
  if (attempt.stream) {
    for (const track of attempt.stream.getTracks()) {
      try { track.stop(); } catch (error) { failure ??= error; }
    }
  }
  if (attempt.socket && attempt.socket.readyState < WebSocket.CLOSING) {
    try { attempt.socket.close(1000, 'Dictation complete'); } catch (error) { failure ??= error; }
  }
  if (failure) throw failure;
}

export function useRealtimeDictation(
  api: Pick<AvalonApi, 'getTranscriptionSocketTicket'> | undefined,
  onTranscript: (transcript: string) => void,
): {
  devices: MicrophoneDevice[];
  error?: string;
  selectedDeviceId: string;
  setSelectedDeviceId: (deviceId: string) => void;
  start: () => Promise<void>;
  state: DictationState;
  stop: () => Promise<void>;
} {
  const [state, setState] = useState<DictationState>('idle');
  const [error, setError] = useState<string>();
  const [devices, setDevices] = useState<MicrophoneDevice[]>([]);
  const [selectedDeviceId, setSelectedDeviceIdState] = useState(
    () => readDevicePreferences().microphoneDeviceId ?? 'default',
  );
  const attemptRef = useRef<DictationAttempt | undefined>(undefined);
  const nextAttemptIdRef = useRef(0);
  const stateRef = useRef<DictationState>('idle');
  const onTranscriptRef = useRef(onTranscript);
  onTranscriptRef.current = onTranscript;

  const transition = useCallback((next: DictationState): void => {
    stateRef.current = next;
    setState(next);
  }, []);

  const refreshDevices = useCallback(async (): Promise<void> => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    const inputs = (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === 'audioinput');
    const next = inputs.map((device, index) => ({
      deviceId: device.deviceId || 'default',
      label: device.label || `Microphone ${index + 1}`,
    }));
    if (!next.some((device) => device.deviceId === 'default')) {
      next.unshift({ deviceId: 'default', label: 'Default microphone' });
    }
    setDevices([...new Map(next.map((device) => [device.deviceId, device])).values()]);
    if (inputs.some((device) => Boolean(device.deviceId)) && !next.some((device) => device.deviceId === selectedDeviceId)) {
      setSelectedDeviceIdState('default');
    }
  }, [selectedDeviceId]);

  useEffect(() => {
    void refreshDevices();
    navigator.mediaDevices?.addEventListener?.('devicechange', refreshDevices);
    return () => navigator.mediaDevices?.removeEventListener?.('devicechange', refreshDevices);
  }, [refreshDevices]);

  const finish = useCallback((
    attempt: DictationAttempt,
    nextState: 'idle' | 'error',
    nextError?: string,
  ): void => {
    if (attemptRef.current !== attempt) return;
    attemptRef.current = undefined;
    if (nextError) setError(nextError);
    transition(nextState);
    void cleanupAttempt(attempt).catch((cleanupError) => {
      if (attemptRef.current || nextAttemptIdRef.current !== attempt.id || nextState === 'error') return;
      setError(microphoneErrorMessage(cleanupError));
      transition('error');
    });
  }, [transition]);

  const stop = useCallback(async (): Promise<void> => {
    const attempt = attemptRef.current;
    if (!attempt) return;
    if (stateRef.current === 'requesting' || stateRef.current === 'connecting') {
      attemptRef.current = undefined;
      transition('idle');
      try {
        await cleanupAttempt(attempt);
      } catch (cleanupError) {
        if (!attemptRef.current && nextAttemptIdRef.current === attempt.id) {
          setError(microphoneErrorMessage(cleanupError));
          transition('error');
        }
      }
      return;
    }
    if (stateRef.current === 'transcribing') {
      finish(attempt, 'idle');
      return;
    }
    if (!attempt.capture || !attempt.socket || stateRef.current !== 'listening') return;
    transition('transcribing');
    try {
      await attempt.capture.stop(true);
    } catch (cleanupError) {
      finish(attempt, 'error', microphoneErrorMessage(cleanupError));
      return;
    }
    if (attemptRef.current !== attempt) return;
    if (attempt.socket.readyState !== WebSocket.OPEN) {
      finish(attempt, 'error', 'The dictation connection closed before transcription completed.');
      return;
    }
    try {
      attempt.socket.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
    } catch (socketError) {
      finish(attempt, 'error', microphoneErrorMessage(socketError));
      return;
    }
    attempt.completionTimer = window.setTimeout(() => {
      finish(
        attempt,
        'error',
        attempt.transcript
          ? 'The transcription service did not confirm the final transcript. The visible text may be incomplete.'
          : 'No speech was detected.',
      );
    }, COMPLETION_TIMEOUT_MS);
  }, [finish, transition]);

  const start = useCallback(async (): Promise<void> => {
    if (!api || !navigator.mediaDevices?.getUserMedia || !['idle', 'error'].includes(stateRef.current)) return;
    const attempt: DictationAttempt = {
      id: nextAttemptIdRef.current + 1,
      transcript: '',
    };
    nextAttemptIdRef.current = attempt.id;
    attemptRef.current = attempt;
    setError(undefined);
    onTranscriptRef.current('');
    transition('requesting');
    try {
      const streamPromise = navigator.mediaDevices.getUserMedia({
        audio: {
          autoGainControl: true,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          ...(selectedDeviceId === 'default' ? {} : { deviceId: { exact: selectedDeviceId } }),
        },
      }).then((stream) => {
        attempt.stream = stream;
        if (attemptRef.current !== attempt) stream.getTracks().forEach((track) => track.stop());
        return stream;
      });
      const [ticket] = await Promise.all([
        api.getTranscriptionSocketTicket(),
        streamPromise,
      ]);
      if (attemptRef.current !== attempt || !attempt.stream) {
        await cleanupAttempt(attempt);
        return;
      }
      transition('connecting');
      const socket = new WebSocket(ticket.url);
      attempt.socket = socket;
      await waitForTranscriptionSession(
        socket,
        (event) => {
          if (attemptRef.current !== attempt) return;
          const nextTranscript = nextLiveTranscript(attempt.transcript, event);
          if (nextTranscript !== undefined) {
            attempt.transcript = nextTranscript;
            onTranscriptRef.current(attempt.transcript);
            if (stateRef.current === 'transcribing' && isFinalTranscriptionEvent(event)) {
              finish(attempt, 'idle');
            }
          } else if (event.type === 'error' || event.type === 'conversation.item.input_audio_transcription.failed') {
            finish(attempt, 'error', providerErrorMessage(event));
          }
        },
        () => {
          if (attemptRef.current === attempt) {
            finish(attempt, 'error', 'The dictation connection closed unexpectedly.');
          }
        },
      );
      if (attemptRef.current !== attempt) {
        await cleanupAttempt(attempt);
        return;
      }
      const capture = await createAudioCapture(attempt.stream, (buffer) => {
        if (attemptRef.current === attempt && socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: bytesToBase64(buffer) }));
        }
      });
      attempt.capture = capture;
      if (attemptRef.current !== attempt) {
        await cleanupAttempt(attempt);
        return;
      }
      await capture.start();
      if (attemptRef.current !== attempt) {
        await cleanupAttempt(attempt);
        return;
      }
      transition('listening');
      void refreshDevices();
    } catch (caught) {
      if (attemptRef.current === attempt) finish(attempt, 'error', microphoneErrorMessage(caught));
      else await cleanupAttempt(attempt).catch(() => undefined);
    }
  }, [api, finish, refreshDevices, selectedDeviceId, transition]);

  useEffect(() => () => {
    const attempt = attemptRef.current;
    attemptRef.current = undefined;
    nextAttemptIdRef.current += 1;
    if (attempt) void cleanupAttempt(attempt).catch(() => undefined);
  }, []);

  const selectDevice = useCallback((deviceId: string): void => {
    setSelectedDeviceIdState(deviceId);
    setDeviceMicrophoneId(deviceId);
  }, []);

  return {
    devices,
    ...(error ? { error } : {}),
    selectedDeviceId,
    setSelectedDeviceId: selectDevice,
    start,
    state,
    stop,
  };
}
