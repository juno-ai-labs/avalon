// @vitest-environment jsdom

import { act } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueuesView } from '../src/client/queues';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

interface Deferred<Value> {
  promise: Promise<Value>;
  resolve(value: Value): void;
}

function deferred<Value>(): Deferred<Value> {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((complete) => { resolve = complete; });
  return { promise, resolve };
}

function queue(id: string, name: string, backlogCount: number | null): object {
  return {
    id,
    name,
    sourceQueues: [`${name}-source`],
    metrics: backlogCount === null ? null : {
      backlogBytes: backlogCount * 100,
      backlogCount,
      oldestMessageTimestampMs: 1_723_000_000_000,
    },
  };
}

function peekResponse(queueName: string): Response {
  return Response.json({
    messages: [{
      id: `${queueName}-message`,
      attempts: 1,
      body: JSON.stringify({ queue: queueName }),
      metadata: null,
      timestampMs: 1_723_000_000_000,
    }],
  });
}

describe('Ace Queue client', () => {
  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('keeps a late peek response from a previously selected queue out of the current queue', async () => {
    const queueA = deferred<Response>();
    const queueB = deferred<Response>();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/api/queues/dead-letters') {
        return Response.json({ queues: [queue('a', 'queue-a', 2), queue('b', 'queue-b', 1)] });
      }
      if (url.endsWith('/a/peek')) return await queueA.promise;
      if (url.endsWith('/b/peek')) return await queueB.promise;
      throw new Error(`Unexpected request: ${url}`);
    });

    await act(async () => root.render(<QueuesView />));
    await vi.waitFor(() => expect(container.textContent).toContain('queue-b'));
    const queueBButton = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('queue-b'));
    expect(queueBButton).toBeDefined();
    await act(async () => queueBButton!.click());
    await act(async () => queueB.resolve(peekResponse('queue-b')));
    await vi.waitFor(() => expect(container.textContent).toContain('"queue": "queue-b"'));

    await act(async () => queueA.resolve(peekResponse('queue-a')));
    await vi.waitFor(() => expect(container.textContent).not.toContain('"queue": "queue-a"'));
    expect(container.textContent).toContain('"queue": "queue-b"');
  });

  it('hides the previous Queue messages in the render that selects another Queue', async () => {
    const queueB = deferred<Response>();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/api/queues/dead-letters') {
        return Response.json({ queues: [queue('a', 'queue-a', 2), queue('b', 'queue-b', 1)] });
      }
      if (url.endsWith('/a/peek')) return peekResponse('queue-a');
      if (url.endsWith('/b/peek')) return await queueB.promise;
      throw new Error(`Unexpected request: ${url}`);
    });

    await act(async () => root.render(<QueuesView />));
    await vi.waitFor(() => expect(container.textContent).toContain('"queue": "queue-a"'));
    const queueBButton = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('queue-b'));
    expect(queueBButton).toBeDefined();

    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
    flushSync(() => queueBButton!.click());
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

    expect(container.querySelector('.queue-detail-header')?.textContent).toContain('queue-b');
    expect(container.textContent).not.toContain('"queue": "queue-a"');
    await act(async () => queueB.resolve(peekResponse('queue-b')));
  });

  it('marks the aggregate backlog as a lower bound when any Queue metrics are unavailable', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/api/queues/dead-letters') {
        return Response.json({ queues: [queue('known', 'known-queue', 2), queue('unknown', 'unknown-queue', null)] });
      }
      return Response.json({ messages: [] });
    });

    await act(async () => root.render(<QueuesView />));
    await vi.waitFor(() => expect(container.textContent).toContain('≥ 2 messages across 2 queues'));
    expect(container.textContent).toContain('—');
  });
});
