import { StrictMode } from 'react';
import { act, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  abandonPendingWorkstreamFeedOpen,
  markWorkstreamFeedOpenStarted,
} from './telemetry';
import { useWorkstreamFeedOpenTelemetry } from './use-workstream-feed-open-telemetry';

const reportTelemetryProductIntent = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('./platform', () => ({
  desktopBridge: () => ({ reportTelemetryProductIntent }),
}));

function Probe({ workstreamId }: { workstreamId: string }): null {
  useWorkstreamFeedOpenTelemetry({
    cacheState: 'feed_cached',
    feedSource: 'feed_cache',
    isReady: true,
    messageCount: 'one',
    readSocketOpenContext: () => ({ socketLeaseId: '018f22f2-4c22-7abc-8def-012345678901' }),
    workstreamId,
  });
  return null;
}

afterEach(() => {
  abandonPendingWorkstreamFeedOpen();
  reportTelemetryProductIntent.mockReset();
  vi.unstubAllGlobals();
});

describe('useWorkstreamFeedOpenTelemetry', () => {
  it('reschedules the painted-feed report after StrictMode cancels the first frames', async () => {
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrameId = 0;
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
      nextFrameId += 1;
      frames.set(nextFrameId, callback);
      return nextFrameId;
    }));
    vi.stubGlobal('cancelAnimationFrame', vi.fn((frameId: number) => {
      frames.delete(frameId);
    }));
    const workstreamId = '00000000-0000-4000-8000-000000000212';
    markWorkstreamFeedOpenStarted(workstreamId, 'recent', 'retained_pair', performance.now());
    reportTelemetryProductIntent.mockClear();

    render(<StrictMode><Probe workstreamId={workstreamId} /></StrictMode>);

    // StrictMode removed the first setup's frame; only its replacement remains.
    expect(frames).toHaveLength(1);
    const runNextFrame = (): void => {
      const entry = frames.entries().next().value as [number, FrameRequestCallback] | undefined;
      if (!entry) throw new Error('No animation frame was scheduled.');
      frames.delete(entry[0]);
      entry[1](performance.now());
    };
    act(runNextFrame);
    expect(frames).toHaveLength(1);
    act(runNextFrame);
    await Promise.resolve();

    expect(reportTelemetryProductIntent).toHaveBeenCalledTimes(2);
    expect(reportTelemetryProductIntent).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'workstream_feed_visible',
      workstreamId,
    }));
    expect(reportTelemetryProductIntent).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'workstream_open_outcome',
      outcome: 'visible',
      workstreamId,
    }));
  });
});
