import { describe, expect, it, vi } from 'vitest';

import { PcmSpeechPlayer } from './pcm-speech-player';

describe('PcmSpeechPlayer', () => {
  it('decodes split little-endian samples, schedules without a gap, and rejects reuse after stop', async () => {
    const scheduled: number[] = [];
    const decoded: Float32Array[] = [];
    const context = {
      currentTime: 1,
      destination: {},
      resume: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      createBuffer: vi.fn((_channels: number, samples: number) => {
        const values = new Float32Array(samples);
        decoded.push(values);
        return { duration: samples / 24_000, getChannelData: () => values };
      }),
      createBufferSource: vi.fn(() => {
        const listeners = new Set<() => void>();
        return {
          buffer: null,
          connect: vi.fn(),
          addEventListener: (_name: string, listener: () => void) => listeners.add(listener),
          start: (at: number) => {
            scheduled.push(at);
            queueMicrotask(() => listeners.forEach((listener) => listener()));
          },
          stop: vi.fn(),
        };
      }),
    };
    const player = new PcmSpeechPlayer(context as unknown as AudioContext);
    const stream = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(Uint8Array.of(0x00));
      controller.enqueue(Uint8Array.of(0x40, 0x00, 0xc0));
      controller.close();
    } });

    await player.prepare();
    await player.play(stream);

    expect(decoded).toHaveLength(1);
    expect(Array.from(decoded[0]!)).toEqual([0.5, -0.5]);
    expect(scheduled).toEqual([1]);

    player.stop();
    await expect(player.play(new ReadableStream<Uint8Array>()))
      .rejects.toThrow('A stopped speech player cannot be reused. Create a new player.');
  });
});
