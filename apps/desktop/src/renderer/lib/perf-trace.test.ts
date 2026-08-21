import { describe, expect, it, vi } from 'vitest';
import { newRequestId, startPerfTrace } from './perf-trace';

type ConsoleSpy = { mock: { calls: unknown[][] } };

function traceLines(spy: ConsoleSpy): Array<Record<string, unknown>> {
  return spy.mock.calls
    .filter((call) => String(call[0]).startsWith('[perf]'))
    .map((call) => call[1] as Record<string, unknown>);
}

describe('renderer performance tracing', () => {
  it('prints one line naming every phase in order', async () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    const trace = startPerfTrace('workstream_open', { traceId: 'trace-1', workstreamId: 'workstream-1' });

    await trace.step('socket_ticket', () => Promise.resolve());
    trace.mark('handshake');
    trace.end({ outcome: 'snapshot' });

    expect(debug).toHaveBeenCalledTimes(1);
    const [line] = traceLines(debug);
    expect(line).toMatchObject({
      flow: 'workstream_open',
      traceId: 'trace-1',
      workstreamId: 'workstream-1',
      outcome: 'snapshot',
    });
    expect(Object.keys(line!.phases as Record<string, number>)).toEqual(['socket_ticket', 'handshake']);
  });

  it('reports how long the main thread was busy inside the flow', async () => {
    // The whole point of the number: a phase that reads three seconds is the
    // same three seconds whether a socket was connecting or the transcript was
    // rendering, and only this separates them.
    //
    // Imported fresh because the observer is attached once per module load, so
    // any earlier test in this file would already have consumed the attempt.
    const entries: Array<(list: { getEntries: () => PerformanceEntryList }) => void> = [];
    vi.stubGlobal('PerformanceObserver', class {
      constructor(callback: (list: { getEntries: () => PerformanceEntryList }) => void) {
        entries.push(callback);
      }
      observe(): void { /* the double does not filter entry types */ }
      disconnect(): void { /* the tracer never detaches */ }
    });
    vi.resetModules();
    const { startPerfTrace: freshTrace } = await import('./perf-trace');
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    const clock = vi.spyOn(performance, 'now');

    clock.mockReturnValue(1_000);
    const trace = freshTrace('workstream_open', { traceId: 'trace-blocked' });
    // One task wholly inside the flow, and one straddling its end. The second
    // counts for its overlap only: charging a flow for work that outlives it
    // would make every trace ending mid-task look worse than it was.
    entries[0]!({ getEntries: () => [
      { startTime: 1_200, duration: 300 },
      { startTime: 1_900, duration: 400 },
    ] as unknown as PerformanceEntryList });
    clock.mockReturnValue(2_000);
    trace.end({ outcome: 'snapshot' });

    expect(traceLines(debug)[0]).toMatchObject({ blockedMs: 400, longTasks: 2 });
  });

  it('still prints a flow where the runtime reports no long tasks', async () => {
    // jsdom has no `longtask` entry type, and neither does every Chromium the
    // desktop ships on. Missing blocking data is a gap in the diagnosis, not a
    // broken open.
    vi.stubGlobal('PerformanceObserver', undefined);
    vi.resetModules();
    const { startPerfTrace: freshTrace } = await import('./perf-trace');
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined);

    freshTrace('workstream_open').end({ outcome: 'snapshot' });

    expect(traceLines(debug)[0]).toMatchObject({ blockedMs: 0, longTasks: 0, outcome: 'snapshot' });
  });

  it('records the phase that threw and lets the rejection through', async () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    const trace = startPerfTrace('workstream_message_send', { traceId: 'client-message-1' });

    await expect(trace.step('command_round_trip', () => Promise.reject(new Error('offline'))))
      .rejects.toThrow('offline');
    trace.end({ outcome: 'failed' });

    expect(Object.keys(traceLines(debug)[0]!.phases as Record<string, number>))
      .toEqual(['command_round_trip']);
  });

  it('prints once however many times the flow ends', () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    // Every socket path calls `end` defensively — the close handler, the catch,
    // and the effect teardown can all reach the same trace.
    const trace = startPerfTrace('workstream_open');

    trace.end({ outcome: 'snapshot' });
    trace.end({ outcome: 'closed' });
    trace.end({ outcome: 'unmounted' });

    expect(debug).toHaveBeenCalledTimes(1);
    expect(traceLines(debug)[0]).toMatchObject({ outcome: 'snapshot' });
  });

  it('gives an untagged flow an id of its own so its line is still findable', () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined);

    startPerfTrace('workstream_create').end();
    startPerfTrace('workstream_create').end();

    const [first, second] = traceLines(debug);
    expect(first!.traceId).toEqual(expect.any(String));
    expect(first!.traceId).not.toEqual(second!.traceId);
  });

  it('mints a request id the regional Worker accepts as x-request-id', () => {
    // The Worker rejects anything outside this alphabet and mints its own
    // instead, which would leave the client's printed id matching nothing.
    expect(newRequestId()).toMatch(/^[A-Za-z0-9._:-]{1,100}$/u);
  });
});
