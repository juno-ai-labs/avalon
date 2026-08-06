/* global AudioWorkletProcessor, registerProcessor */

const CHUNK_SAMPLES = 2_400;

class Pcm16CaptureProcessor extends AudioWorkletProcessor {
  buffer = new Int16Array(CHUNK_SAMPLES);
  offset = 0;

  constructor() {
    super();
    this.port.onmessage = (event) => {
      if (event.data !== 'flush') return;
      this.emit(this.offset);
      this.port.postMessage({ type: 'flushed' });
    };
  }

  emit(length = this.buffer.length) {
    if (length === 0) return;
    const chunk = this.buffer.slice(0, length);
    this.port.postMessage({ type: 'audio', buffer: chunk.buffer }, [chunk.buffer]);
    this.offset = 0;
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input) return true;
    for (const sample of input) {
      const clamped = Math.max(-1, Math.min(1, sample));
      this.buffer[this.offset] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
      this.offset += 1;
      if (this.offset === this.buffer.length) this.emit();
    }
    return true;
  }
}

registerProcessor('avalon-pcm16-capture', Pcm16CaptureProcessor);
