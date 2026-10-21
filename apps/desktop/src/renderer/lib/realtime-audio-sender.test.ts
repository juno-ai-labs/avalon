import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RealtimeAudioSender } from './realtime-audio-sender';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function transport() {
  let buffered = 0;
  const messages: string[] = [];
  const errors: string[] = [];
  const sender = new RealtimeAudioSender({
    bufferedAmount: () => buffered,
    send: (message) => { messages.push(message); },
    onError: (error) => { errors.push(error.message); },
  });
  return { sender, messages, errors, congest: (bytes: number) => { buffered = bytes; } };
}

function audioBytes(messages: string[]): number[] {
  return messages.flatMap((raw) => {
    const event = JSON.parse(raw) as { audio: string };
    return [...atob(event.audio)].map((byte) => byte.charCodeAt(0));
  });
}

describe('realtime audio sending', () => {
  it.each(['steady', 'burst'])('preserves identical samples under %s delivery', async (delivery) => {
    const { sender, messages, errors } = transport();
    sender.start();
    for (let index = 0; index < 40; index += 1) {
      sender.append(new Uint8Array(4_800).fill(index).buffer);
      if (delivery === 'steady') await vi.advanceTimersByTimeAsync(100);
    }
    const drain = sender.flush();
    await vi.advanceTimersByTimeAsync(100);
    await drain;
    expect(audioBytes(messages)).toEqual(Array.from({ length: 192_000 }, (_, index) => Math.floor(index / 4_800)));
    expect(messages).toHaveLength(delivery === 'steady' ? 40 : 2);
    expect(errors).toEqual([]);
    sender.stop();
  });

  it('splits an oversized capture buffer into valid PCM frames before resolving its drain', async () => {
    const { sender, messages } = transport();
    sender.append(new Uint8Array(480_000).fill(17).buffer);
    sender.start();
    let drained = false;
    const drain = sender.flush().then(() => { drained = true; });
    expect(drained).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    await drain;
    expect(messages).toHaveLength(3);
    expect(messages.every((message) => message.length <= 256_000)).toBe(true);
    expect(audioBytes(messages)).toEqual(new Array(480_000).fill(17));
    sender.stop();
  });

  it('retains queued audio through socket congestion and sends it once space returns', async () => {
    const { sender, messages, errors, congest } = transport();
    sender.append(new Uint8Array([1, 2, 3, 4]).buffer);
    congest(4 * 1_024 * 1_024);
    sender.start();
    const drain = sender.flush();
    await vi.advanceTimersByTimeAsync(500);
    expect(messages).toEqual([]);
    congest(0);
    await vi.advanceTimersByTimeAsync(100);
    await drain;
    expect(audioBytes(messages)).toEqual([1, 2, 3, 4]);
    expect(errors).toEqual([]);
    sender.stop();
  });

  it('fails when pending PCM and socket bytes exhaust the existing buffer budget', async () => {
    const { sender, messages, errors, congest } = transport();
    congest(4 * 1_024 * 1_024 - 2);
    sender.append(new Uint8Array([1, 2, 3, 4]).buffer);
    expect(errors).toEqual(['The network could not keep up with the recording audio.']);
    expect(messages).toEqual([]);
    await expect(sender.flush()).rejects.toThrow('The network could not keep up with the recording audio.');
  });

  it('rejects a pending drain and cancels later sends when the attempt ends', async () => {
    const { sender, messages } = transport();
    sender.start();
    sender.append(new Uint8Array([1, 2]).buffer);
    sender.append(new Uint8Array([3, 4]).buffer);
    const drain = expect(sender.flush()).rejects.toThrow('Recording ended before its queued audio was sent.');
    sender.stop();
    await drain;
    await vi.advanceTimersByTimeAsync(500);
    expect(audioBytes(messages)).toEqual([1, 2]);
  });
});
