import { TRANSCRIPTION_TICKET_LIFETIME_SECONDS } from '@rally/contracts/realtime-transcription';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { RallyApi } from './api';
import { readDevicePreferences, setDeviceMicrophoneId } from './device-preferences';
import { type PerfTrace, startPerfTrace } from './perf-trace';
import { desktopBridge } from './platform';
import { RealtimeAudioSender } from './realtime-audio-sender';

export type DictationState = 'idle' | 'requesting' | 'listening' | 'paused' | 'transcribing' | 'finalizing' | 'error';

export interface MicrophoneDevice {
  deviceId: string;
  label: string;
}

interface AudioCapture {
  /** Settles once the worklet module is loaded and the graph is built. */
  ready: Promise<void>;
  /** Connects the inputs once they exist; audio reaches the worklet from here on. */
  attach: (streams: MediaStream[], systemAudio: SystemAudioCapture | undefined) => Promise<void>;
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
  audio?: RealtimeAudioSender;
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
  trace: PerfTrace;
  transcript: string;
  completionTimer?: number;
}

export interface RealtimeDictationOptions {
  includeSystemAudio?: boolean;
  /**
   * Receives the meter level of each captured chunk, 0 to 1 from
   * `meterLevel`, and 0 once capture pauses or ends. Called about ten times
   * a second while listening, from the worklet's cadence; a host paints it
   * directly rather than rendering on it.
   */
  onLevel?: (level: number) => void;
  useSystemDefaultMicrophone?: boolean;
}

const AUDIO_FLUSH_TIMEOUT_MS = 2_000;
const AUDIO_CONTROL_TIMEOUT_MS = 2_000;
// The existing 10-second connection budget now includes ticket acquisition
// and backlog drain once capture starts; permission prompts do not consume it.
const CONNECTION_TIMEOUT_MS = 10_000;
// A ticket fetched on hover is presented only while the whole connection
// budget still fits inside its life, so a slow upgrade cannot run it out.
const PREFETCHED_TICKET_USABLE_MS = TRANSCRIPTION_TICKET_LIFETIME_SECONDS * 1_000 - CONNECTION_TIMEOUT_MS;
// Where the level meter reads zero, in dBFS. Speech under automatic gain
// control sits around -20, and the suppressed noise floor well under -50.
const METER_FLOOR_DB = -50;
const COMPLETION_TIMEOUT_MS = 60_000;

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

/** The 0 to 1 meter position for a chunk's RMS, on a dB scale above `METER_FLOOR_DB`. */
export function meterLevel(rms: number): number {
  if (!(rms > 0)) return 0;
  const db = 20 * Math.log10(rms);
  return Math.min(1, Math.max(0, (db - METER_FLOOR_DB) / -METER_FLOOR_DB));
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

/**
 * Builds the capture graph without waiting for an input. The context is
 * created at once, inside the click so no autoplay policy holds it, and the
 * worklet module loads while the microphone is still opening; `attach`
 * builds the nodes and connects the inputs once they exist. The worklet node
 * itself is not created until then: Chromium renders an `AudioWorkletNode`
 * whose output is unconnected as an automatic-pull node, so a node built
 * early would run against silence and fill the backlog with zeros for as
 * long as the permission prompt stays up. Nothing here suspends or resumes:
 * until `attach` the context runs an empty graph.
 *
 * `sinkId: { type: 'none' }` keeps the context off the output device.
 * Nothing in this graph plays, so opening a speaker was a device start the
 * recording never needed, and on a Bluetooth headset a slow one. Engines
 * without the option ignore it; for them the zero-gain path to
 * `destination` is what keeps the graph pulled, which is why it stays.
 *
 * `stop` never waits for the module: a stalled fetch must not hold the
 * microphone or the socket, so teardown closes whatever exists at once and
 * the `stopped` flag keeps a late `ready` from building anything.
 */
function createAudioCapture(onAudio: (buffer: ArrayBuffer, level: number) => void): AudioCapture {
  const context = new AudioContext({ sampleRate: 24_000, sinkId: { type: 'none' } });
  const sources: MediaStreamAudioSourceNode[] = [];
  let inputGain: GainNode | undefined;
  let node: AudioWorkletNode | undefined;
  let silence: GainNode | undefined;
  let systemAudio: SystemAudioCapture | undefined;
  let stopped = false;
  let resolveFlush: (() => void) | undefined;
  let resolvePause: (() => void) | undefined;
  let resolveResume: (() => void) | undefined;

  const ready = context.audioWorklet.addModule(new URL('../audio/pcm16-capture-worklet.js?no-inline', import.meta.url));
  // A failed load surfaces through `attach`, the first thing that waits on it.
  void ready.catch(() => undefined);

  const control = (
    message: 'pause' | 'resume',
    settle: (resolve: (() => void) | undefined) => void,
    timeoutMessage: string,
  ): Promise<void> => new Promise<void>((resolve, reject) => {
    const worklet = node;
    if (!worklet) {
      resolve();
      return;
    }
    const timer = window.setTimeout(() => reject(new Error(timeoutMessage)), AUDIO_CONTROL_TIMEOUT_MS);
    settle(() => {
      window.clearTimeout(timer);
      resolve();
    });
    try { worklet.port.postMessage(message); } catch (error) {
      window.clearTimeout(timer);
      reject(error);
    }
  }).finally(() => settle(undefined));

  return {
    ready,
    async attach(streams, system) {
      await ready;
      if (stopped) return;
      inputGain = context.createGain();
      inputGain.gain.value = 1;
      // The worklet mixes native Core Audio PCM with the microphone. Leave
      // headroom only when both sources are active.
      const worklet = new AudioWorkletNode(context, 'rally-pcm16-capture', {
        channelCount: 1,
        channelCountMode: 'explicit',
        channelInterpretation: 'speakers',
        processorOptions: {
          microphoneGain: system ? 0.65 : 1,
          systemGain: streams.length > 0 ? 0.65 : 1,
        },
      });
      node = worklet;
      silence = context.createGain();
      silence.gain.value = 0;
      worklet.port.onmessage = (event: MessageEvent<{ type?: string; buffer?: ArrayBuffer; level?: number }>) => {
        if (event.data.type === 'audio' && event.data.buffer) onAudio(event.data.buffer, event.data.level ?? 0);
        if (event.data.type === 'flushed') resolveFlush?.();
        if (event.data.type === 'paused') resolvePause?.();
        if (event.data.type === 'resumed') resolveResume?.();
      };
      for (const stream of streams) {
        const source = context.createMediaStreamSource(stream);
        source.connect(inputGain);
        sources.push(source);
      }
      systemAudio = system;
      system?.listen((buffer, sampleRate) => {
        worklet.port.postMessage({ type: 'system-audio', buffer, sampleRate }, [buffer]);
      });
      inputGain.connect(worklet);
      worklet.connect(silence);
      silence.connect(context.destination);
    },
    async pause() {
      if (stopped) return;
      await control('pause', (resolve) => { resolvePause = resolve; }, 'Audio capture did not pause in time.');
    },
    async resume() {
      if (stopped) return;
      await control('resume', (resolve) => { resolveResume = resolve; }, 'Audio capture did not resume in time.');
    },
    async start() {
      // Running already when created inside a user gesture; a context a
      // browser started suspended under its autoplay policy is resumed here,
      // inside the same press.
      if (!stopped && context.state !== 'running') await context.resume();
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
        const worklet = node;
        if (flush && worklet && context.state === 'running') {
          await new Promise<void>((resolve, reject) => {
            resolveFlush = resolve;
            flushTimer = window.setTimeout(() => {
              reject(new Error('Audio capture did not acknowledge its final buffered samples.'));
            }, AUDIO_FLUSH_TIMEOUT_MS);
            try {
              worklet.port.postMessage('flush');
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
        if (node) node.port.onmessage = null;
        for (const source of sources) {
          try { source.disconnect(); } catch (error) { failure ??= error; }
        }
        try { inputGain?.disconnect(); } catch (error) { failure ??= error; }
        try { node?.disconnect(); } catch (error) { failure ??= error; }
        try { silence?.disconnect(); } catch (error) { failure ??= error; }
        try { await context.close(); } catch (error) { failure ??= error; }
      }
      if (failure) throw failure;
    },
  };
}

async function cleanupAttempt(attempt: DictationAttempt): Promise<void> {
  attempt.trace.end({ outcome: 'cancelled' });
  if (attempt.completionTimer !== undefined) {
    window.clearTimeout(attempt.completionTimer);
    attempt.completionTimer = undefined;
  }
  attempt.controller.abort();
  if (attempt.connectionTimer !== undefined) window.clearTimeout(attempt.connectionTimer);
  attempt.audio?.stop();
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

export type RealtimeDictationApi = Pick<RallyApi, 'getTranscriptionSocketTicket' | 'prefetchTranscriptionSocketTicket'>;

export function useRealtimeDictation(
  api: RealtimeDictationApi | undefined,
  onTranscript: (transcript: string) => void,
  options: RealtimeDictationOptions = {},
): {
  devices: MicrophoneDevice[];
  error?: string;
  /** Acknowledge a failed attempt without starting another recording. */
  clearError: () => void;
  warning?: string;
  selectedDeviceId: string;
  setSelectedDeviceId: (deviceId: string) => void;
  commit: () => Promise<string>;
  pause: () => Promise<void>;
  /** Fetches the ticket a coming `start` will present; idle otherwise. */
  prefetch: () => void;
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
  const onLevelRef = useRef(options.onLevel);
  onLevelRef.current = options.onLevel;

  const transition = useCallback((next: DictationState): void => {
    stateRef.current = next;
    setState(next);
  }, []);

  const clearError = useCallback((): void => {
    if (stateRef.current !== 'error') return;
    setError(undefined);
    transition('idle');
  }, [transition]);

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
    // `completed` is the drain's to claim; anything else ending the trace
    // either failed or was stopped before the connection was ready.
    attempt.trace.end({ outcome: nextError ? 'failed' : 'cancelled' });
    onLevelRef.current?.(0);
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
    let committed = false;
    attempt.completionTimer = window.setTimeout(() => {
      finish(
        attempt,
        'error',
        !committed
          ? 'The network could not send the remaining recording audio.'
          : attempt.transcript
            ? 'The transcription service did not confirm the final transcript. The visible text may be incomplete.'
            : 'No speech was detected.',
      );
    }, COMPLETION_TIMEOUT_MS);
    try {
      await attempt.capture.stop(true);
      if (!attempt.connection.ready) await attempt.connection.promise;
      await attempt.audio?.flush();
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
      committed = true;
    } catch (socketError) {
      finish(attempt, 'error', captureErrorMessage(socketError));
      return finalizationPromise;
    }
    return finalizationPromise;
  }, [finish, transition]);

  const pause = useCallback(async (): Promise<void> => {
    const attempt = attemptRef.current;
    if (!attempt?.capture || stateRef.current !== 'listening') return;
    try {
      await attempt.capture.pause();
      onLevelRef.current?.(0);
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
    void promise.catch(() => undefined);
    attempt.segmentCommit = { promise, reject, resolve };
    setError(undefined);
    transition('transcribing');
    let committed = false;
    attempt.completionTimer = window.setTimeout(() => {
      if (attemptRef.current !== attempt || attempt.segmentCommit?.promise !== promise) return;
      finish(
        attempt,
        'error',
        !committed
          ? 'The network could not send the remaining recording audio.'
          : attempt.transcript
            ? 'The transcription service did not confirm this segment. The visible text may be incomplete.'
            : 'The transcription service did not return this segment.',
      );
    }, COMPLETION_TIMEOUT_MS);
    try {
      await attempt.audio?.flush();
      if (attemptRef.current !== attempt) return promise;
      attempt.socket.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
      committed = true;
    } catch (socketError) {
      finish(attempt, 'error', captureErrorMessage(socketError));
      return promise;
    }
    return promise;
  }, [finish, transition]);

  const start = useCallback(async (): Promise<void> => {
    if (!api || !navigator.mediaDevices?.getUserMedia || !['idle', 'error'].includes(stateRef.current)) return;
    // Device-local: the flow is not in the telemetry event's schema. The line
    // is what says which of the parallel branches below was the critical path.
    const trace = startPerfTrace('dictation_start', { report: false });
    const startedAt = performance.now();
    const sinceStartMs = (): number => Math.round((performance.now() - startedAt) * 10) / 10;
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
      id: nextAttemptIdRef.current + 1,
      streams: [],
      trace,
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
      // Three things start at once and none waits for another: the inputs,
      // the capture graph, and the ticket with the socket behind it. The
      // microphone is the only one the recording indicator has to wait for.
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
      const audio = new RealtimeAudioSender({
        bufferedAmount: () => attempt.socket?.bufferedAmount ?? 0,
        send: (message) => {
          if (attempt.socket?.readyState !== WebSocket.OPEN) {
            throw new Error('The dictation connection closed before its audio could be sent.');
          }
          attempt.socket.send(message);
        },
        onError: (error) => finish(attempt, 'error', error.message),
      });
      attempt.audio = audio;
      const handleSessionEvent = (event: RealtimeTranscriptionEvent): void => {
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
      };
      const handleUnexpectedClose = (): void => {
        if (attemptRef.current === attempt) {
          finish(attempt, 'error', 'The dictation connection closed unexpectedly.');
        }
      };
      // The socket is opened the moment the ticket lands, so the Worker's
      // upgrade and the provider's acknowledgement overlap the microphone
      // opening instead of following it. Nothing is sent on it until local
      // capture is running and the backlog drains below.
      const ticketPromise = api.getTranscriptionSocketTicket(attempt.controller.signal);
      const sessionPromise = (async (): Promise<void> => {
        const ticket = await ticketPromise;
        if (attemptRef.current !== attempt) return;
        trace.annotate({ socketTicketMs: sinceStartMs() });
        const socket = new WebSocket(ticket.url, ticket.protocols);
        attempt.socket = socket;
        await waitForTranscriptionSession(socket, handleSessionEvent, handleUnexpectedClose);
        trace.annotate({ sessionReadyMs: sinceStartMs() });
      })();
      // A ticket or handshake failure ends the attempt as soon as it happens
      // rather than when capture gets round to awaiting it; the await below
      // then finds the attempt replaced.
      void sessionPromise.catch((caught: unknown) => {
        if (attemptRef.current === attempt) finish(attempt, 'error', captureErrorMessage(caught));
      });
      const capture = createAudioCapture((buffer, level) => {
        if (attemptRef.current !== attempt) return;
        onLevelRef.current?.(meterLevel(level));
        audio.append(buffer);
      });
      // Held from creation, so a cancel during the permission prompt closes
      // the context the worklet is still loading into.
      attempt.capture = capture;
      void capture.ready.then(() => trace.annotate({ captureGraphMs: sinceStartMs() }), () => undefined);
      await streamsPromise;
      trace.mark('inputs');
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
      await capture.attach(attempt.streams, attempt.systemAudio);
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
      trace.mark('capture');
      const captureWarning = [microphoneWarning, systemAudioWarning].filter(Boolean).join(' ');
      if (captureWarning) setWarning(captureWarning);
      transition('listening');
      void refreshDevices();
      await sessionPromise;
      if (attemptRef.current !== attempt) {
        await cleanupAttempt(attempt);
        return;
      }
      trace.mark('session');
      // Startup, live capture and Stop's final worklet samples share the same
      // ordered queue. Its cadence batches delayed callbacks without changing
      // samples or slowing catch-up to real-time playback.
      audio.start();
      void audio.flush().then(() => {
        if (attemptRef.current !== attempt) return;
        if (attempt.connectionTimer !== undefined) window.clearTimeout(attempt.connectionTimer);
        attempt.connectionTimer = undefined;
        attempt.connection.ready = true;
        attempt.connection.resolve();
        trace.mark('backlog');
        trace.end({ outcome: 'completed' });
      }).catch((caught: unknown) => {
        if (attemptRef.current === attempt) finish(attempt, 'error', captureErrorMessage(caught));
      });
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

  const prefetch = useCallback((): void => {
    if (!api || !['idle', 'error'].includes(stateRef.current)) return;
    api.prefetchTranscriptionSocketTicket(PREFETCHED_TICKET_USABLE_MS);
  }, [api]);

  const selectDevice = useCallback((deviceId: string): void => {
    setSelectedDeviceIdState(deviceId);
    setDeviceMicrophoneId(deviceId);
  }, []);

  return {
    clearError,
    commit,
    devices,
    ...(error ? { error } : {}),
    ...(warning ? { warning } : {}),
    selectedDeviceId,
    setSelectedDeviceId: selectDevice,
    pause,
    prefetch,
    resume,
    start,
    state,
    stop,
  };
}
