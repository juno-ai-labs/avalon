import { beforeEach, describe, expect, it, vi } from 'vitest';

interface ProcessorPort {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  postMessage: ReturnType<typeof vi.fn>;
}

interface TestProcessor {
  port: ProcessorPort;
  process: (inputs: Float32Array[][], outputs: Float32Array[][]) => boolean;
}

let Processor: new (options: { processorOptions?: Record<string, number> }) => TestProcessor;

beforeEach(async () => {
  vi.resetModules();
  class AudioWorkletProcessorStub {
    port: ProcessorPort = { onmessage: null, postMessage: vi.fn() };
  }
  vi.stubGlobal('sampleRate', 24_000);
  vi.stubGlobal('AudioWorkletProcessor', AudioWorkletProcessorStub);
  vi.stubGlobal('registerProcessor', vi.fn((name: string, constructor: typeof Processor) => {
    expect(name).toBe('rally-pcm16-capture');
    Processor = constructor;
  }));
  // The production worklet is intentionally plain JavaScript because it runs
  // in AudioWorkletGlobalScope rather than the renderer's DOM environment.
  // @ts-expect-error The side-effect module has no renderer declaration file.
  await import('./pcm16-capture-worklet.js');
});

function emittedPcm(processor: TestProcessor): Int16Array {
  const message = processor.port.postMessage.mock.calls
    .map(([value]) => value as { buffer?: ArrayBuffer; type?: string })
    .find((value) => value.type === 'audio');
  expect(message?.buffer).toBeInstanceOf(ArrayBuffer);
  return new Int16Array(message!.buffer!);
}

describe('PCM16 capture worklet', () => {
  it('resamples native Float32 computer audio and mixes it with the microphone once', () => {
    const processor = new Processor({
      processorOptions: { microphoneGain: 0.5, systemGain: 0.5 },
    });
    processor.port.onmessage?.(new MessageEvent('message', {
      data: {
        buffer: new Float32Array([1, 0.5, 0, -0.5, -1, -0.5]).buffer,
        sampleRate: 48_000,
        type: 'system-audio',
      },
    }));

    expect(processor.process(
      [[new Float32Array([0.2, 0.2])]],
      [[new Float32Array(2)]],
    )).toBe(true);
    processor.port.onmessage?.(new MessageEvent('message', { data: 'flush' }));

    const pcm = emittedPcm(processor);
    expect(pcm[0]).toBeCloseTo(0.6 * 0x7fff, -1);
    expect(pcm[1]).toBeCloseTo(0.1 * 0x7fff, -1);
  });

  it('flushes resampled computer-audio samples that have not reached a full chunk', () => {
    const processor = new Processor({ processorOptions: { systemGain: 1 } });
    processor.port.onmessage?.(new MessageEvent('message', {
      data: {
        buffer: new Float32Array([0.5, 0.25, -0.5, -0.25]).buffer,
        sampleRate: 48_000,
        type: 'system-audio',
      },
    }));

    processor.port.onmessage?.(new MessageEvent('message', { data: 'flush' }));

    expect(emittedPcm(processor)).toHaveLength(2);
    expect(processor.port.postMessage).toHaveBeenCalledWith({ type: 'flushed' });
  });

  it('discards microphone and computer audio while paused, then captures new audio after resume', () => {
    const processor = new Processor({ processorOptions: { microphoneGain: 1, systemGain: 1 } });
    processor.process([[new Float32Array([0.2])]], [[new Float32Array(1)]]);
    processor.port.onmessage?.(new MessageEvent('message', { data: 'pause' }));
    expect(processor.port.postMessage).toHaveBeenCalledWith({ type: 'paused' });
    processor.port.postMessage.mockClear();

    processor.port.onmessage?.(new MessageEvent('message', {
      data: {
        buffer: new Float32Array([1, 1, 1, 1]).buffer,
        sampleRate: 48_000,
        type: 'system-audio',
      },
    }));
    processor.process([[new Float32Array([0.9])]], [[new Float32Array(1)]]);
    processor.port.onmessage?.(new MessageEvent('message', { data: 'resume' }));
    processor.process([[new Float32Array([0.25])]], [[new Float32Array(1)]]);
    processor.port.onmessage?.(new MessageEvent('message', { data: 'flush' }));

    expect(processor.port.postMessage).toHaveBeenCalledWith({ type: 'resumed' });
    const pcm = emittedPcm(processor);
    expect(pcm).toHaveLength(1);
    expect(pcm[0]).toBeCloseTo(0.25 * 0x7fff, -1);
  });
});
