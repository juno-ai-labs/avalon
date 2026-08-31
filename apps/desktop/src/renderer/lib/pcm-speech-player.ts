const PCM_SAMPLE_RATE = 24_000;

/**
 * Schedules provider PCM as it arrives instead of waiting for a complete file.
 *
 * A player is single-use: `stop()` closes its AudioContext, so callers must
 * create a new instance for another playback attempt.
 */
export class PcmSpeechPlayer {
  private readonly context: AudioContext;
  private readonly sources = new Set<AudioBufferSourceNode>();
  private nextStartTime = 0;
  private stopped = false;

  constructor(context = new AudioContext({ latencyHint: 'interactive', sampleRate: PCM_SAMPLE_RATE })) {
    this.context = context;
  }

  /** Call synchronously from the pointer event so browsers preserve activation. */
  prepare(): Promise<void> {
    this.assertUsable();
    return this.context.resume();
  }

  async play(stream: ReadableStream<Uint8Array>): Promise<void> {
    this.assertUsable();
    const reader = stream.getReader();
    let trailingByte: number | null = null;
    let finalEnded: Promise<void> | null = null;
    try {
      while (!this.stopped) {
        const next = await reader.read();
        if (next.done) break;
        let bytes = next.value;
        if (trailingByte !== null) {
          const joined = new Uint8Array(bytes.byteLength + 1);
          joined[0] = trailingByte;
          joined.set(bytes, 1);
          bytes = joined;
          trailingByte = null;
        }
        if (bytes.byteLength % 2 === 1) {
          trailingByte = bytes[bytes.byteLength - 1]!;
          bytes = bytes.subarray(0, bytes.byteLength - 1);
        }
        if (bytes.byteLength === 0) continue;
        finalEnded = this.schedule(bytes);
      }
      if (!this.stopped && trailingByte !== null) {
        throw new Error('The speech stream ended with an incomplete PCM sample.');
      }
      if (!this.stopped && finalEnded) await finalEnded;
    } finally {
      reader.releaseLock();
    }
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const source of this.sources) {
      try { source.stop(); } catch { /* A completed source is already stopped. */ }
    }
    this.sources.clear();
    void this.context.close().catch(() => undefined);
  }

  private assertUsable(): void {
    if (this.stopped) throw new Error('A stopped speech player cannot be reused. Create a new player.');
  }

  private schedule(bytes: Uint8Array): Promise<void> {
    const sampleCount = bytes.byteLength / 2;
    const buffer = this.context.createBuffer(1, sampleCount, PCM_SAMPLE_RATE);
    const samples = buffer.getChannelData(0);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let index = 0; index < sampleCount; index += 1) {
      samples[index] = view.getInt16(index * 2, true) / 32_768;
    }
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.context.destination);
    const playbackEnded = new Promise<void>((resolve) => {
      source.addEventListener('ended', () => {
        this.sources.delete(source);
        resolve();
      }, { once: true });
    });
    this.sources.add(source);
    const startsAt = Math.max(this.context.currentTime, this.nextStartTime);
    source.start(startsAt);
    this.nextStartTime = startsAt + buffer.duration;
    return playbackEnded;
  }
}
