import { afterEach, describe, expect, it, vi } from 'vitest';
import { AzureOpenAIClient, OpenRouterClient } from './index';
import { createInferenceDelayObserver } from './inference-delay';

afterEach(() => vi.useRealTimers());

for (const provider of ['azure', 'openrouter'] as const) {
  describe(`${provider} first-output delay`, () => {
    function stream(headDelay = 0, streamIdleTimeoutMs = 15_000, rejectNotice = false) {
      vi.useFakeTimers();
      const abort = new AbortController();
      const changes: boolean[] = [];
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      const body = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
      const fetcher: typeof fetch = async (_url, init) => {
        if (headDelay) await new Promise((resolve) => setTimeout(resolve, headDelay));
        init?.signal?.addEventListener('abort', () => controller.error(init.signal?.reason), { once: true });
        return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
      };
      const input = { model: 'test/model', messages: [], signal: abort.signal, onInferenceDelay: (active: boolean) => { changes.push(active); if (rejectNotice) throw new Error("socket unavailable"); } };
      const client = provider === 'azure'
        ? new AzureOpenAIClient({ endpoint: 'https://test.openai.azure.com', apiKey: 'key', streamIdleTimeoutMs, fetch: fetcher })
        : new OpenRouterClient({ apiKey: 'key', primaryModel: 'test/model', sameModelRetries: 0, streamIdleTimeoutMs, fetch: fetcher });
      const result = client.stream(input, () => undefined);
      void result.catch(() => undefined);
      const send = (delta: Record<string, unknown>) => controller.enqueue(new TextEncoder().encode(
        `data: ${JSON.stringify({ id: 'test', object: 'chat.completion.chunk', created: 1, model: 'test/model', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
      ));
      return { changes, controller, result, send, abort };
    }

    it.each(['text', 'tool'] as const)('clears on first %s output and never warns during later work', async (kind) => {
      const s = stream();
      await vi.advanceTimersByTimeAsync(29_999);
      expect(s.changes).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(s.changes).toEqual([true]);
      s.send(kind === 'text' ? { content: 'Hello' } : { tool_calls: [{ index: 0, id: 'call1', type: 'function', function: { name: 'test', arguments: '{}' } }] });
      await vi.advanceTimersByTimeAsync(0);
      expect(s.changes).toEqual([true, false]);
      s.controller.close();
      await s.result;
      await vi.advanceTimersByTimeAsync(180_000);
      expect(s.changes).toEqual([true, false]);
    });

    it('starts the wait at stream opening and preserves the full allowance after slow headers', async () => {
      const s = stream(20_000);
      await vi.advanceTimersByTimeAsync(49_999);
      expect(s.changes).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(s.changes).toEqual([true]);
      let settled = false;
      void s.result.catch(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(149_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(s.result).rejects.toThrow('time_to_first_token');
      expect(s.changes).toEqual([true, false]);
    });

    it('never warns during a pause after output while the stream is still open', async () => {
      const s = stream(0, 120_000);
      await vi.advanceTimersByTimeAsync(100);
      s.send({ content: 'Started' });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(s.changes).toEqual([]);
      s.controller.close();
      await s.result;
    });

    it('cancels the pending notice when an attempt ends before the threshold', async () => {
      const s = stream();
      await vi.advanceTimersByTimeAsync(10_000);
      s.abort.abort();
      await s.result.catch(() => undefined);
      await vi.advanceTimersByTimeAsync(180_000);
      expect(s.changes).toEqual([]);
    });

    it('allows continued output after a slow first token beyond the former total cap', async () => {
      const s = stream();
      await vi.advanceTimersByTimeAsync(170_000);
      for (let index = 0; index < 10; index += 1) {
        s.send({ content: 'Still producing output' });
        await vi.advanceTimersByTimeAsync(10_000);
      }
      s.controller.close();
      await expect(s.result).resolves.toMatchObject({ content: expect.stringContaining('Still producing output') });
      expect(s.changes).toEqual([true, false]);
    });

    it.each(['text', 'error'] as const)('preserves provider %s when status publishing throws', async (kind) => {
      const s = stream(0, 15_000, true);
      await vi.advanceTimersByTimeAsync(30_000);
      if (kind === 'text') {
        s.send({ content: 'Provider result' });
        s.controller.close();
        await expect(s.result).resolves.toMatchObject({ content: 'Provider result' });
      } else {
        s.controller.error(new Error('provider disconnected'));
        await expect(s.result).rejects.toThrow('provider disconnected');
      }
    });

    it('does not warn after a fast response', async () => {
      const s = stream();
      await vi.advanceTimersByTimeAsync(100);
      s.send({ content: 'Fast' });
      s.controller.close();
      await s.result;
      await vi.advanceTimersByTimeAsync(180_000);
      expect(s.changes).toEqual([]);
    });

    it('ignores empty chunks and waits three minutes before timing out', async () => {
      const s = stream();
      await vi.advanceTimersByTimeAsync(20_000);
      s.send({});
      await vi.advanceTimersByTimeAsync(10_000);
      expect(s.changes).toEqual([true]);
      let settled = false;
      void s.result.catch(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(149_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(s.result).rejects.toThrow('time_to_first_token');
      expect(s.changes).toEqual([true, false]);
    });

    it.each(['abort', 'error', 'empty'] as const)('clears on %s settlement', async (kind) => {
      const s = stream();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(s.changes).toEqual([true]);
      if (kind === 'abort') s.abort.abort();
      else if (kind === 'error') s.controller.error(new Error('provider disconnected'));
      else s.controller.close();
      await s.result.catch(() => undefined);
      expect(s.changes).toEqual([true, false]);
      await vi.advanceTimersByTimeAsync(180_000);
      expect(s.changes).toEqual([true, false]);
    });
  });
}

it('serializes a late notification with its clear and isolates concurrent attempts', async () => {
  vi.useFakeTimers();
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const changes: boolean[] = [];
  const first = createInferenceDelayObserver(async (active) => { if (active) await barrier; changes.push(active); });
  const secondChanges: boolean[] = [];
  const second = createInferenceDelayObserver((active) => { secondChanges.push(active); });
  first.open(); second.open();
  await vi.advanceTimersByTimeAsync(30_000);
  first.observedOutput();
  release();
  await first.finish();
  expect(changes).toEqual([true, false]);
  expect(secondChanges).toEqual([true]);
  await second.finish();
  expect(secondChanges).toEqual([true, false]);
});

it('gives a replacement attempt a fresh thirty-second window', async () => {
  vi.useFakeTimers();
  const changes: string[] = [];
  const first = createInferenceDelayObserver((active) => { changes.push(`first:${active}`); });
  first.open();
  await vi.advanceTimersByTimeAsync(30_000);
  await first.finish();
  const retry = createInferenceDelayObserver((active) => { changes.push(`retry:${active}`); });
  retry.open();
  await vi.advanceTimersByTimeAsync(29_999);
  expect(changes).toEqual(['first:true', 'first:false']);
  await vi.advanceTimersByTimeAsync(1);
  expect(changes).toEqual(['first:true', 'first:false', 'retry:true']);
  await retry.finish();
});

it('keeps rejected notifications from replacing output or provider errors', async () => {
  vi.useFakeTimers();
  const observer = createInferenceDelayObserver(async () => { throw new Error('socket unavailable'); });
  observer.open();
  await vi.advanceTimersByTimeAsync(30_000);
  await expect(observer.flush()).resolves.toBeUndefined();
  observer.observedOutput();
  await expect(observer.finish()).resolves.toBeUndefined();
});
