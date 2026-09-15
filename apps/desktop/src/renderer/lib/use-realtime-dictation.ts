import { TRANSCRIPTION_BACKLOG_SEND_INTERVAL_MS, TRANSCRIPTION_MAX_APPEND_BYTES } from '@rally/contracts/realtime-transcription';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { RallyApi } from './api';
import { readDevicePreferences, setDeviceMicrophoneId } from './device-preferences';
import { desktopBridge } from './platform';

export type DictationState = 'idle' | 'requesting' | 'listening' | 'paused' | 'transcribing' | 'finalizing' | 'error';

export interface MicrophoneDevice {
  deviceId: string;
  label: string;
}

interface AudioCapture {
  pause: () => Promise<void>;
  resume: () => Promise<void>;
  start: () => Promise<void>;
  stop: (flush?: boolean) => Promise<void>;
}

interface SystemAudioCapture {
  listen: (listener: ((data: ArrayBuffer, sampleRate: number) => void) | undefined) => void;
  stop: () => Promise<void>;
}

interface DictationAttempt {
  capture?: AudioCapture;
  connection: { ready: boolean; promise: Promise<void>; resolve: () => void; reject: (error: Error) => void };
  pendingAudio: ArrayBuffer[];
  backlogTimer?: number;
  connectionTimer?: number;
  controller: AbortController;
  finalization?: {
    itemId?: string;
    promise: Promise<void>;
    reject: (error: Error) => void;
    resolve: () => void;
  };
  id: number;
  segmentCommit?: {
    itemId?: string;
    promise: Promise<string>;
    reject: (error: Error) => void;
    resolve: (transcript: string) => void;
  };
  socket?: WebSocket;
  streams: MediaStream[];
  systemAudio?: SystemAudioCapture;
  transcript: string;
  completionTimer?: number;
}

export interface RealtimeDictationOptions {
  includeSystemAudio?: boolean;
  useSystemDefaultMicrophone?: boolean;
}

const AUDIO_FLUSH_TIMEOUT_MS = 2_000;
const AUDIO_CONTROL_TIMEOUT_MS = 2_000;
// The existing 10-second connection budget now includes ticket acquisition
// and backlog drain once capture starts; permission prompts do not consume it.
const CONNECTION_TIMEOUT_MS = 10_000;
const COMPLETION_TIMEOUT_MS = 60_000;
const MAX_SOCKET_BUFFERED_BYTES = 4 * 1_024 * 1_024;

interface RealtimeTranscriptionEvent {
  type?: string;
  delta?: string;
  item_id?: string;
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

class SystemAudioCaptureError extends Error {}

function captureErrorMessage(error: unknown): string {
  if (error instanceof SystemAudioCaptureError) return error.message;
  if (error instanceof DOMException && error.name === 'NotAllowedError') {
    return 'Microphone access is blocked. Allow it in System Settings and try again.';
  }
  if (error instanceof DOMException && (error.name === 'NotFoundError' || error.name === 'OverconstrainedError')) {
    return 'The selected microphone is unavailable.';
  }
  return error instanceof Error ? error.message : 'Dictation could not start.';
}

function stopMediaStream(stream: MediaStream): void {
  for (const track of stream.getTracks()) {
    try { track.stop(); } catch { /* The track is already stopped. */ }
  }
}

async function requestSystemAudioCapture(): Promise<SystemAudioCapture> {
  const bridge = desktopBridge();
  let audioListener: ((data: ArrayBuffer, sampleRate: number) => void) | undefined;
  const unsubscribe = bridge.onSystemAudioData((data, sampleRate) => audioListener?.(data, sampleRate));
  try {
    await bridge.startSystemAudioCapture();
  } catch (error) {
    unsubscribe();
    throw new SystemAudioCaptureError(
      error instanceof Error && error.message
        ? `Computer audio could not start: ${error.message}`
        : 'Computer audio could not start.',
    );
  }
  let stopped = false;
  return {
    listen(listener) {
      audioListener = listener;
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      try {
        await bridge.stopSystemAudioCapture();
      } finally {
        audioListener = undefined;
        unsubscribe();
      }
    },
  };
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

const transcriptionEventTypes = new Set([
  'session.updated', 'transcription_session.updated', 'input_audio_buffer.committed',
  'conversation.item.input_audio_transcription.delta', 'response.text.delta',
  'conversation.item.input_audio_transcription.completed', 'response.text.done',
  'conversation.item.input_audio_transcription.failed', 'error',
]);

function parseRealtimeEvent(data: unknown): RealtimeTranscriptionEvent | undefined {
  try {
    const parsed: unknown = JSON.parse(String(data));
    return parsed && typeof parsed === 'object' && 'type' in parsed
      && typeof parsed.type === 'string' && transcriptionEventTypes.has(parsed.type)
      ? parsed as RealtimeTranscriptionEvent : undefined;
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

    const failBeforeReady = (message: string): void => {
      if (settled) return;
      settled = true;
      reject(new Error(message));
    };

    socket.addEventListener('message', (messageEvent) => {
      const event = parseRealtimeEvent(messageEvent.data);
      if (!event) return;
      if ((event.type === 'session.updated' || event.type === 'transcription_session.updated') && !settled) {
        ready = true;
        settled = true;
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

async function createAudioCapture(
  streams: MediaStream[],
  systemAudio: SystemAudioCapture | undefined,
  onAudio: (buffer: ArrayBuffer) => void,
): Promise<AudioCapture> {
  const context = new AudioContext({ sampleRate: 24_000 });
  const sources: MediaStreamAudioSourceNode[] = [];
  let inputGain: GainNode | undefined;
  let node: AudioWorkletNode | undefined;
  let silence: GainNode | undefined;
  try {
    await context.suspend();
    await context.audioWorklet.addModule(new URL('../audio/pcm16-capture-worklet.js?no-inline', import.meta.url));
    inputGain = context.createGain();
    // The worklet mixes native Core Audio PCM with the microphone. Leave
    // headroom only when both sources are active.
    inputGain.gain.value = 1;
    for (const stream of streams) {
      const source = context.createMediaStreamSource(stream);
      source.connect(inputGain);
      sources.push(source);
    }
    node = new AudioWorkletNode(context, 'rally-pcm16-capture', {
      channelCount: 1,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
      processorOptions: {
        microphoneGain: systemAudio ? 0.65 : 1,
        systemGain: streams.length > 0 ? 0.65 : 1,
      },
    });
    silence = context.createGain();
    silence.gain.value = 0;
    inputGain.connect(node);
    node.connect(silence);
    silence.connect(context.destination);
  } catch (error) {
    for (const source of sources) {
      try { source.disconnect(); } catch { /* Already disconnected. */ }
    }
    try { inputGain?.disconnect(); } catch { /* Already disconnected. */ }
    try { node?.disconnect(); } catch { /* Already disconnected. */ }
    try { silence?.disconnect(); } catch { /* Already disconnected. */ }
    try { await context.close(); } catch { /* Preserve the setup error. */ }
    throw error;
  }

  let stopped = false;
  let resolveFlush: (() => void) | undefined;
  let resolvePause: (() => void) | undefined;
  let resolveResume: (() => void) | undefined;
  node.port.onmessage = (event: MessageEvent<{ type?: string; buffer?: ArrayBuffer }>) => {
    if (event.data.type === 'audio' && event.data.buffer) onAudio(event.data.buffer);
    if (event.data.type === 'flushed') resolveFlush?.();
    if (event.data.type === 'paused') resolvePause?.();
    if (event.data.type === 'resumed') resolveResume?.();
  };
  systemAudio?.listen((buffer, sampleRate) => {
    node.port.postMessage({ type: 'system-audio', buffer, sampleRate }, [buffer]);
  });

  return {
    async pause() {
      if (stopped) return;
      await new Promise<void>((resolve, reject) => {
        resolvePause = resolve;
        const timer = window.setTimeout(
          () => reject(new Error('Audio capture did not pause in time.')),
          AUDIO_CONTROL_TIMEOUT_MS,
        );
        resolvePause = () => {
          window.clearTimeout(timer);
          resolve();
        };
        try { node.port.postMessage('pause'); } catch (error) {
          window.clearTimeout(timer);
          reject(error);
        }
      }).finally(() => { resolvePause = undefined; });
    },
    async resume() {
      if (stopped) return;
      await new Promise<void>((resolve, reject) => {
        resolveResume = resolve;
        const timer = window.setTimeout(
          () => reject(new Error('Audio capture did not resume in time.')),
          AUDIO_CONTROL_TIMEOUT_MS,
        );
        resolveResume = () => {
          window.clearTimeout(timer);
          resolve();
        };
        try { node.port.postMessage('resume'); } catch (error) {
          window.clearTimeout(timer);
          reject(error);
        }
      }).finally(() => { resolveResume = undefined; });
    },
    async start() {
      if (!stopped) await context.resume();
    },
    async stop(flush = false) {
      if (stopped) return;
      stopped = true;
      let failure: unknown;
      let flushTimer: number | undefined;
      try {
        // Core Audio stop is a drain barrier. It resolves only after every
        // native PCM callback has reached this worklet.
        try { await systemAudio?.stop(); } catch (error) { failure = error; }
        if (flush && context.state === 'running') {
          await new Promise<void>((resolve, reject) => {
            resolveFlush = resolve;
            flushTimer = window.setTimeout(() => {
              reject(new Error('Audio capture did not acknowledge its final buffered samples.'));
            }, AUDIO_FLUSH_TIMEOUT_MS);
            try {
              node.port.postMessage('flush');
            } catch (error) {
              reject(error);
            }
          });
        }
      } catch (error) {
        failure ??= error;
      } finally {
        systemAudio?.listen(undefined);
        if (flushTimer !== undefined) window.clearTimeout(flushTimer);
        node.port.onmessage = null;
        for (const source of sources) {
          try { source.disconnect(); } catch (error) { failure ??= error; }
        }
        try { inputGain.disconnect(); } catch (error) { failure ??= error; }
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
  attempt.controller.abort();
  if (attempt.connectionTimer !== undefined) window.clearTimeout(attempt.connectionTimer);
  if (attempt.backlogTimer !== undefined) window.clearTimeout(attempt.backlogTimer);
  attempt.pendingAudio.length = 0;
  attempt.connection.reject(new Error('Recording ended before the transcription service connected.'));
  let failure: unknown;
  if (attempt.capture) {
    try { await attempt.capture.stop(); } catch (error) { failure = error; }
  }
  for (const stream of attempt.streams) {
    for (const track of stream.getTracks()) {
      try { track.stop(); } catch (error) { failure ??= error; }
    }
  }
  if (attempt.systemAudio) {
    try { await attempt.systemAudio.stop(); } catch (error) { failure ??= error; }
  }
  if (attempt.socket && attempt.socket.readyState < WebSocket.CLOSING) {
    try { attempt.socket.close(1000, 'Dictation complete'); } catch (error) { failure ??= error; }
  }
  if (failure) throw failure;
}

export function useRealtimeDictation(
  api: Pick<RallyApi, 'getTranscriptionSocketTicket'> | undefined,
  onTranscript: (transcript: string) => void,
  options: RealtimeDictationOptions = {},
): {
  devices: MicrophoneDevice[];
  error?: string;
  warning?: string;
  selectedDeviceId: string;
  setSelectedDeviceId: (deviceId: string) => void;
  commit: () => Promise<string>;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
  start: () => Promise<void>;
  state: DictationState;
  stop: () => Promise<void>;
} {
  const [state, setState] = useState<DictationState>('idle');
  const [error, setError] = useState<string>();
  const [warning, setWarning] = useState<string>();
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
    const pendingSegment = attempt.segmentCommit;
    attempt.segmentCommit = undefined;
    const finalization = attempt.finalization;
    attempt.finalization = undefined;
    const completionError = new Error(nextError ?? 'Recording ended before the transcript was finalized.');
    pendingSegment?.reject(completionError);
    if (nextError) finalization?.reject(completionError);
    else finalization?.resolve();
    setWarning(undefined);
    if (nextError) setError(nextError);
    transition(nextState);
    void cleanupAttempt(attempt).catch((cleanupError) => {
      if (attemptRef.current || nextAttemptIdRef.current !== attempt.id || nextState === 'error') return;
      setError(captureErrorMessage(cleanupError));
      transition('error');
    });
  }, [transition]);

  const stop = useCallback(async (): Promise<void> => {
    let attempt = attemptRef.current;
    if (!attempt) return;
    if (stateRef.current === 'finalizing') {
      await attempt.finalization?.promise;
      return;
    }
    if (stateRef.current === 'requesting') {
      attemptRef.current = undefined;
      setWarning(undefined);
      transition('idle');
      try {
        await cleanupAttempt(attempt);
      } catch (cleanupError) {
        if (!attemptRef.current && nextAttemptIdRef.current === attempt.id) {
          setError(captureErrorMessage(cleanupError));
          transition('error');
        }
      }
      return;
    }
    if (stateRef.current === 'transcribing') {
      if (!attempt.segmentCommit) return;
      await attempt.segmentCommit.promise;
      attempt = attemptRef.current;
      if (!attempt) return;
    }
    if (!attempt.capture || !['listening', 'paused'].includes(stateRef.current)) return;
    let resolveFinalization!: () => void;
    let rejectFinalization!: (error: Error) => void;
    const finalizationPromise = new Promise<void>((resolve, reject) => {
      resolveFinalization = resolve;
      rejectFinalization = reject;
    });
    // A socket can fail while stop is still awaiting the audio drain/flush.
    // Mark the internal promise handled immediately; the returned stop promise
    // still adopts and reports the same rejection to its caller.
    void finalizationPromise.catch(() => undefined);
    attempt.finalization = {
      promise: finalizationPromise,
      reject: rejectFinalization,
      resolve: resolveFinalization,
    };
    transition('finalizing');
    try {
      await attempt.capture.stop(true);
      if (!attempt.connection.ready) await attempt.connection.promise;
    } catch (cleanupError) {
      finish(attempt, 'error', captureErrorMessage(cleanupError));
      return finalizationPromise;
    }
    if (attemptRef.current !== attempt) return finalizationPromise;
    if (!attempt.socket || attempt.socket.readyState !== WebSocket.OPEN) {
      finish(attempt, 'error', 'The dictation connection closed before transcription completed.');
      return finalizationPromise;
    }
    try {
      attempt.socket.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
    } catch (socketError) {
      finish(attempt, 'error', captureErrorMessage(socketError));
      return finalizationPromise;
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
    return finalizationPromise;
  }, [finish, transition]);

  const pause = useCallback(async (): Promise<void> => {
    const attempt = attemptRef.current;
    if (!attempt?.capture || stateRef.current !== 'listening') return;
    try {
      await attempt.capture.pause();
      if (attemptRef.current === attempt) transition('paused');
    } catch (caught) {
      if (attemptRef.current === attempt) finish(attempt, 'error', captureErrorMessage(caught));
      throw caught;
    }
  }, [finish, transition]);

  const resume = useCallback(async (): Promise<void> => {
    const attempt = attemptRef.current;
    if (!attempt?.capture || stateRef.current !== 'paused') return;
    try {
      await attempt.capture.resume();
      if (attemptRef.current === attempt) transition('listening');
    } catch (caught) {
      if (attemptRef.current === attempt) finish(attempt, 'error', captureErrorMessage(caught));
      throw caught;
    }
  }, [finish, transition]);

  const commit = useCallback(async (): Promise<string> => {
    const attempt = attemptRef.current;
    if (!attempt) return '';
    if (attempt.segmentCommit) return attempt.segmentCommit.promise;
    if (stateRef.current !== 'listening') return '';
    if (!attempt.connection.ready) await attempt.connection.promise;
    if (attemptRef.current !== attempt || !attempt.socket) return '';
    // Another commit or Stop may have arrived while readiness was pending.
    const pendingSegment = attemptRef.current.segmentCommit;
    if (pendingSegment) return pendingSegment.promise;
    if (stateRef.current !== 'listening') return '';
    if (attempt.socket.readyState !== WebSocket.OPEN) {
      const message = 'The dictation connection closed before the transcript segment could be saved.';
      finish(attempt, 'error', message);
      throw new Error(message);
    }

    let resolve!: (transcript: string) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<string>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    attempt.segmentCommit = { promise, reject, resolve };
    setError(undefined);
    transition('transcribing');
    try {
      attempt.socket.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
    } catch (socketError) {
      finish(attempt, 'error', captureErrorMessage(socketError));
      return promise;
    }
    attempt.completionTimer = window.setTimeout(() => {
      if (attemptRef.current !== attempt || attempt.segmentCommit?.promise !== promise) return;
      finish(
        attempt,
        'error',
        attempt.transcript
          ? 'The transcription service did not confirm this segment. The visible text may be incomplete.'
          : 'The transcription service did not return this segment.',
      );
    }, COMPLETION_TIMEOUT_MS);
    return promise;
  }, [finish, transition]);

  const start = useCallback(async (): Promise<void> => {
    if (!api || !navigator.mediaDevices?.getUserMedia || !['idle', 'error'].includes(stateRef.current)) return;
    let resolveConnection!: () => void;
    let rejectConnection!: (error: Error) => void;
    const connectionPromise = new Promise<void>((resolve, reject) => {
      resolveConnection = resolve;
      rejectConnection = reject;
    });
    void connectionPromise.catch(() => undefined);
    const attempt: DictationAttempt = {
      controller: new AbortController(),
      connection: { ready: false, promise: connectionPromise, resolve: resolveConnection, reject: rejectConnection },
      pendingAudio: [],
      id: nextAttemptIdRef.current + 1,
      streams: [],
      transcript: '',
    };
    nextAttemptIdRef.current = attempt.id;
    attemptRef.current = attempt;
    setError(undefined);
    setWarning(undefined);
    onTranscriptRef.current('');
    transition('requesting');
    try {
      let microphoneWarning: string | undefined;
      let systemAudioWarning: string | undefined;
      const registerStream = (stream: MediaStream): MediaStream => {
        attempt.streams.push(stream);
        if (attemptRef.current !== attempt) stopMediaStream(stream);
        for (const track of stream.getAudioTracks()) {
          track.addEventListener?.('ended', () => {
            if (attemptRef.current !== attempt) return;
            const hasLiveAudio = Boolean(attempt.systemAudio)
              || attempt.streams.some((candidate) => candidate.getAudioTracks()
                .some((candidateTrack) => candidateTrack.readyState !== 'ended'));
            if (!hasLiveAudio) {
              finish(attempt, 'error', 'All audio inputs stopped. Check your microphone and computer-audio permissions.');
              return;
            }
            setWarning(attempt.systemAudio
              ? 'The microphone stopped. Recording computer audio only.'
              : 'The microphone stopped. No audio input remains.');
          }, { once: true });
        }
        return stream;
      };
      const streamsPromise = Promise.all([
        navigator.mediaDevices.getUserMedia({
          audio: {
            autoGainControl: true,
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
            ...(
              options.useSystemDefaultMicrophone || selectedDeviceId === 'default'
                ? {}
                : { deviceId: { exact: selectedDeviceId } }
            ),
          },
        }).then(registerStream).catch((microphoneError: unknown) => {
          microphoneWarning = `Recording computer audio only. ${captureErrorMessage(microphoneError)}`;
          return undefined;
        }),
        ...(options.includeSystemAudio ? [requestSystemAudioCapture()
          .then((systemAudio) => {
            attempt.systemAudio = systemAudio;
            return systemAudio;
          })
          .catch((systemAudioError: unknown) => {
            systemAudioWarning = `Recording microphone only. ${captureErrorMessage(systemAudioError)}`;
            return undefined;
          })] : []),
      ]);
      const ticketPromise = api.getTranscriptionSocketTicket(attempt.controller.signal);
      void ticketPromise.catch((caught: unknown) => {
        if (attemptRef.current === attempt) finish(attempt, 'error', captureErrorMessage(caught));
      });
      await streamsPromise;
      if (attemptRef.current !== attempt) {
        await cleanupAttempt(attempt);
        return;
      }
      if (attempt.streams.length === 0 && !attempt.systemAudio) {
        throw new Error([
          'No audio input is available.',
          microphoneWarning?.replace(/^Recording computer audio only\.\s*/u, ''),
          systemAudioWarning?.replace(/^Recording microphone only\.\s*/u, ''),
        ].filter(Boolean).join(' '));
      }
      let sessionReady = false;
      const sendAudio = (buffer: ArrayBuffer): void => {
        const socket = attempt.socket;
        if (attemptRef.current !== attempt || !socket || socket.readyState !== WebSocket.OPEN) return;
        if (socket.bufferedAmount > MAX_SOCKET_BUFFERED_BYTES) {
          finish(attempt, 'error', 'The network could not keep up with the recording audio.');
          return;
        }
        try {
          socket.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: bytesToBase64(buffer) }));
        } catch (socketError) {
          finish(attempt, 'error', captureErrorMessage(socketError));
        }
      };
      const capture = await createAudioCapture(attempt.streams, attempt.systemAudio, (buffer) => {
        if (attemptRef.current !== attempt) return;
        if (sessionReady) sendAudio(buffer);
        else attempt.pendingAudio.push(buffer);
      });
      attempt.capture = capture;
      if (attemptRef.current !== attempt) {
        await cleanupAttempt(attempt);
        return;
      }
      attempt.connectionTimer = window.setTimeout(() => {
        finish(attempt, 'error', 'Dictation took too long to connect.');
      }, CONNECTION_TIMEOUT_MS);
      await capture.start();
      if (attemptRef.current !== attempt) {
        await cleanupAttempt(attempt);
        return;
      }
      const captureWarning = [microphoneWarning, systemAudioWarning].filter(Boolean).join(' ');
      if (captureWarning) setWarning(captureWarning);
      transition('listening');
      void refreshDevices();
      const ticket = await ticketPromise;
      if (attemptRef.current !== attempt) {
        await cleanupAttempt(attempt);
        return;
      }
      const socket = new WebSocket(ticket.url, ticket.protocols);
      attempt.socket = socket;
      await waitForTranscriptionSession(
        socket,
        (event) => {
          if (attemptRef.current !== attempt) return;
          const pendingCommit = attempt.segmentCommit ?? attempt.finalization;
          if (event.type === 'input_audio_buffer.committed') {
            if (pendingCommit && typeof event.item_id === 'string') pendingCommit.itemId = event.item_id;
            return;
          }
          if (
            typeof event.item_id === 'string'
            && pendingCommit?.itemId
            && event.item_id !== pendingCommit.itemId
          ) return;
          if (pendingCommit && typeof event.item_id === 'string' && !pendingCommit.itemId) {
            pendingCommit.itemId = event.item_id;
          }
          const nextTranscript = nextLiveTranscript(attempt.transcript, event);
          if (nextTranscript !== undefined) {
            attempt.transcript = nextTranscript;
            onTranscriptRef.current(attempt.transcript);
            if (isFinalTranscriptionEvent(event)) {
              if (stateRef.current === 'transcribing' && attempt.segmentCommit) {
                if (attempt.completionTimer !== undefined) {
                  window.clearTimeout(attempt.completionTimer);
                  attempt.completionTimer = undefined;
                }
                const pendingSegment = attempt.segmentCommit;
                const finalizedTranscript = attempt.transcript;
                attempt.segmentCommit = undefined;
                attempt.transcript = '';
                onTranscriptRef.current('');
                transition('listening');
                pendingSegment.resolve(finalizedTranscript);
              } else if (stateRef.current === 'finalizing' && attempt.finalization) {
                finish(attempt, 'idle');
              }
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
      // Batch original PCM to catch up without exceeding the proxy frame
      // size or message cadence. Never alter sample rate or discard samples.
      const drainBacklog = (): void => {
        if (attemptRef.current !== attempt) return;
        // Startup batches can fill the socket much faster than live audio.
        // Wait for outbound bytes to drain instead of dropping a recovered
        // recording. The same connection deadline bounds this wait.
        if (socket.bufferedAmount + TRANSCRIPTION_MAX_APPEND_BYTES * 4 / 3 > MAX_SOCKET_BUFFERED_BYTES) {
          attempt.backlogTimer = window.setTimeout(drainBacklog, TRANSCRIPTION_BACKLOG_SEND_INTERVAL_MS);
          return;
        }
        let bytes = 0;
        for (const buffer of attempt.pendingAudio) bytes += buffer.byteLength;
        const batch = new Uint8Array(Math.min(bytes, TRANSCRIPTION_MAX_APPEND_BYTES));
        let offset = 0;
        while (offset < batch.length) {
          const buffer = attempt.pendingAudio[0]!;
          const length = Math.min(buffer.byteLength, batch.length - offset);
          batch.set(new Uint8Array(buffer, 0, length), offset);
          offset += length;
          if (length === buffer.byteLength) attempt.pendingAudio.shift();
          else attempt.pendingAudio[0] = buffer.slice(length);
        }
        if (batch.length) sendAudio(batch.buffer);
        if (attemptRef.current !== attempt) return;
        if (attempt.pendingAudio.length) {
          attempt.backlogTimer = window.setTimeout(drainBacklog, TRANSCRIPTION_BACKLOG_SEND_INTERVAL_MS);
          return;
        }
        if (attempt.connectionTimer !== undefined) window.clearTimeout(attempt.connectionTimer);
        attempt.connectionTimer = undefined;
        sessionReady = true;
        attempt.connection.ready = true;
        attempt.connection.resolve();
      };
      drainBacklog();
    } catch (caught) {
      if (attemptRef.current === attempt) finish(attempt, 'error', captureErrorMessage(caught));
      else await cleanupAttempt(attempt).catch(() => undefined);
    }
  }, [
    api,
    finish,
    options.includeSystemAudio,
    options.useSystemDefaultMicrophone,
    refreshDevices,
    selectedDeviceId,
    transition,
  ]);

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
    commit,
    devices,
    ...(error ? { error } : {}),
    ...(warning ? { warning } : {}),
    selectedDeviceId,
    setSelectedDeviceId: selectDevice,
    pause,
    resume,
    start,
    state,
    stop,
  };
}
