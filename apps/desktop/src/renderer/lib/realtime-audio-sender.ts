import {
  TRANSCRIPTION_AUDIO_SEND_INTERVAL_MS,
  TRANSCRIPTION_MAX_APPEND_BYTES,
} from '@rally/contracts/realtime-transcription';

// Preserve the existing transport buffer budget, now including PCM waiting to
// be sent rather than checking only bytes already handed to the WebSocket.
const MAX_BUFFERED_AUDIO_BYTES = 4 * 1_024 * 1_024;

function appendMessage(buffer: Uint8Array): string {
  let binary = '';
  for (const byte of buffer) binary += String.fromCharCode(byte);
  return JSON.stringify({ type: 'input_audio_buffer.append', audio: btoa(binary) });
}

const APPEND_ENVELOPE_CHARACTERS = appendMessage(new Uint8Array()).length;

function queuedMessageBytes(bytes: number): number {
  const frames = Math.floor(bytes / TRANSCRIPTION_MAX_APPEND_BYTES);
  const remainder = bytes % TRANSCRIPTION_MAX_APPEND_BYTES;
  return frames * (Math.ceil(TRANSCRIPTION_MAX_APPEND_BYTES / 3) * 4 + APPEND_ENVELOPE_CHARACTERS)
    + (remainder ? Math.ceil(remainder / 3) * 4 + APPEND_ENVELOPE_CHARACTERS : 0);
}

/** One ordered PCM queue for startup, live capture, and the final worklet flush. */
export class RealtimeAudioSender {
  private readonly buffers: Uint8Array[] = [];
  private bytes = 0;
  private active = false;
  private failure?: Error;
  private timer?: number;
  private nextSendAt = 0;
  private readonly drains = new Set<{ resolve: () => void; reject: (error: Error) => void }>();

  constructor(private readonly transport: {
    bufferedAmount: () => number;
    send: (message: string) => void;
    onError: (error: Error) => void;
  }) {}

  append(buffer: ArrayBuffer): void {
    if (this.failure || buffer.byteLength === 0) return;
    if (queuedMessageBytes(this.bytes + buffer.byteLength) + this.transport.bufferedAmount() > MAX_BUFFERED_AUDIO_BYTES) {
      this.fail(new Error('The network could not keep up with the recording audio.'));
      return;
    }
    this.buffers.push(new Uint8Array(buffer));
    this.bytes += buffer.byteLength;
    this.schedule();
  }

  start(): void {
    if (this.failure) return;
    this.active = true;
    this.schedule();
  }

  flush(): Promise<void> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.bytes === 0) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      this.drains.add({ resolve, reject });
      this.schedule();
    });
  }

  stop(error = new Error('Recording ended before its queued audio was sent.')): void {
    this.failure = error;
    if (this.timer !== undefined) window.clearTimeout(this.timer);
    this.timer = undefined;
    this.buffers.length = 0;
    this.bytes = 0;
    for (const drain of this.drains) drain.reject(error);
    this.drains.clear();
  }

  private fail(error: Error): void {
    this.stop(error);
    this.transport.onError(error);
  }

  private schedule(): void {
    if (!this.active || this.failure || this.timer !== undefined || this.bytes === 0) return;
    const delay = Math.max(0, this.nextSendAt - Date.now());
    if (delay === 0) this.sendBatch();
    else this.timer = window.setTimeout(() => {
      this.timer = undefined;
      this.sendBatch();
    }, delay);
  }

  private sendBatch(): void {
    const length = Math.min(this.bytes, TRANSCRIPTION_MAX_APPEND_BYTES);
    // Socket congestion delays delivery; it does not discard the queued PCM.
    if (this.transport.bufferedAmount() + Math.ceil(length / 3) * 4 + APPEND_ENVELOPE_CHARACTERS > MAX_BUFFERED_AUDIO_BYTES) {
      this.nextSendAt = Date.now() + TRANSCRIPTION_AUDIO_SEND_INTERVAL_MS;
      this.schedule();
      return;
    }
    const batch = new Uint8Array(length);
    let offset = 0;
    while (offset < length) {
      const buffer = this.buffers[0]!;
      const taken = Math.min(buffer.length, length - offset);
      batch.set(buffer.subarray(0, taken), offset);
      offset += taken;
      if (taken === buffer.length) this.buffers.shift();
      else this.buffers[0] = buffer.subarray(taken);
    }
    this.bytes -= length;
    try {
      this.transport.send(appendMessage(batch));
    } catch (caught) {
      this.fail(caught instanceof Error ? caught : new Error('Dictation audio could not be sent.'));
      return;
    }
    this.nextSendAt = Date.now() + TRANSCRIPTION_AUDIO_SEND_INTERVAL_MS;
    if (this.bytes === 0) {
      for (const drain of this.drains) drain.resolve();
      this.drains.clear();
    }
    this.schedule();
  }
}
