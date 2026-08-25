/* global AudioWorkletProcessor, registerProcessor, sampleRate */

const CHUNK_SAMPLES = 2_400;
const SYSTEM_RING_CAPACITY = 384_000;

class Pcm16CaptureProcessor extends AudioWorkletProcessor {
  buffer = new Int16Array(CHUNK_SAMPLES);
  offset = 0;
  systemRing = new Float32Array(SYSTEM_RING_CAPACITY);
  systemReadPosition = 0;
  systemWritePosition = 0;
  systemSampleRate = 0;
  paused = false;

  constructor(options) {
    super();
    this.microphoneGain = options.processorOptions?.microphoneGain ?? 1;
    this.systemGain = options.processorOptions?.systemGain ?? 1;
    this.port.onmessage = (event) => {
      if (event.data === 'pause') {
        if (!this.paused) {
          this.drainSystemAudio();
          this.emit(this.offset);
          this.paused = true;
          this.systemReadPosition = this.systemWritePosition;
        }
        this.port.postMessage({ type: 'paused' });
        return;
      }
      if (event.data === 'resume') {
        this.systemReadPosition = this.systemWritePosition;
        this.paused = false;
        this.port.postMessage({ type: 'resumed' });
        return;
      }
      if (event.data === 'flush') {
        if (!this.paused) this.drainSystemAudio();
        this.emit(this.offset);
        this.port.postMessage({ type: 'flushed' });
        return;
      }
      if (event.data?.type !== 'system-audio'
        || !(event.data.buffer instanceof ArrayBuffer)
        || !Number.isFinite(event.data.sampleRate)
        || event.data.sampleRate < 8_000
        || event.data.sampleRate > 384_000) return;
      if (this.paused) return;
      if (this.systemSampleRate !== event.data.sampleRate) {
        this.systemSampleRate = event.data.sampleRate;
        this.systemReadPosition = this.systemWritePosition;
      }
      this.enqueueSystemAudio(new Float32Array(event.data.buffer));
    };
  }

  emit(length = this.buffer.length) {
    if (length === 0) return;
    const chunk = this.buffer.slice(0, length);
    this.port.postMessage({ type: 'audio', buffer: chunk.buffer }, [chunk.buffer]);
    this.offset = 0;
  }

  appendSample(sample) {
    const clamped = Math.max(-1, Math.min(1, sample));
    this.buffer[this.offset] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    this.offset += 1;
    if (this.offset === this.buffer.length) this.emit();
  }

  enqueueSystemAudio(samples) {
    const start = Math.max(0, samples.length - this.systemRing.length);
    for (let index = start; index < samples.length; index += 1) {
      this.systemRing[this.systemWritePosition % this.systemRing.length] = samples[index];
      this.systemWritePosition += 1;
    }
    if (this.systemWritePosition - this.systemReadPosition > this.systemRing.length) {
      this.systemReadPosition = this.systemWritePosition - this.systemRing.length;
    }
  }

  nextSystemSample() {
    if (this.systemSampleRate <= 0) return 0;
    const step = this.systemSampleRate / sampleRate;
    if (Math.floor(this.systemReadPosition) + 1 >= this.systemWritePosition) {
      this.systemReadPosition = this.systemWritePosition;
      return 0;
    }
    const firstPosition = Math.floor(this.systemReadPosition);
    const fraction = this.systemReadPosition - firstPosition;
    const first = this.systemRing[firstPosition % this.systemRing.length];
    const second = this.systemRing[(firstPosition + 1) % this.systemRing.length];
    this.systemReadPosition += step;
    return first + ((second - first) * fraction);
  }

  drainSystemAudio() {
    if (this.systemSampleRate <= 0) return;
    while (Math.floor(this.systemReadPosition) + 1 < this.systemWritePosition) {
      this.appendSample(this.nextSystemSample() * this.systemGain);
    }
  }

  process(inputs, outputs) {
    if (this.paused) return true;
    const input = inputs[0]?.[0];
    const blockLength = outputs[0]?.[0]?.length ?? input?.length ?? 128;
    for (let index = 0; index < blockLength; index += 1) {
      const microphone = (input?.[index] ?? 0) * this.microphoneGain;
      const system = this.nextSystemSample() * this.systemGain;
      this.appendSample(microphone + system);
    }
    return true;
  }
}

registerProcessor('rally-pcm16-capture', Pcm16CaptureProcessor);
