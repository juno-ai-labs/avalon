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
