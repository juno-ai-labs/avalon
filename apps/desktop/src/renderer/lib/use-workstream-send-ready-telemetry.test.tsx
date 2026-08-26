import { StrictMode } from 'react';
import { act, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  abandonPendingWorkstreamFeedOpen,
  markWorkstreamFeedOpenStarted,
} from './telemetry';
import { useWorkstreamSendReadyTelemetry } from './use-workstream-send-ready-telemetry';

const reportTelemetryProductIntent = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('./platform', () => ({
  desktopBridge: () => ({ reportTelemetryProductIntent }),
}));

function Probe({
  workspaceSocketState = 'reconnecting',
  workstreamId,
}: {
  workspaceSocketState?: 'connected' | 'reconnecting' | 'unavailable';
  workstreamId: string;
}): null {
  useWorkstreamSendReadyTelemetry({
    isReady: true,
    workspaceSocketState,
    workstreamId,
  });
  return null;
}

afterEach(() => {
  abandonPendingWorkstreamFeedOpen();
  reportTelemetryProductIntent.mockReset();
  vi.unstubAllGlobals();
});

describe('useWorkstreamSendReadyTelemetry', () => {
  it('replaces StrictMode-cancelled frames and reports one painted send-ready milestone', async () => {
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
    const workstreamId = '00000000-0000-4000-8000-000000000215';
    const operationId = markWorkstreamFeedOpenStarted(
      workstreamId,
      'recent',
      'retained_pair',
      performance.now(),
    );
    reportTelemetryProductIntent.mockClear();

    render(<StrictMode><Probe workstreamId={workstreamId} /></StrictMode>);

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

    expect(reportTelemetryProductIntent).toHaveBeenCalledTimes(1);
    expect(reportTelemetryProductIntent).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'workstream_send_ready',
      operationId,
      workstreamId,
      workspaceSocketState: 'reconnecting',
    }));
  });

  it('does not call an unavailable transport send-ready', () => {
    const requestAnimationFrame = vi.fn();
    vi.stubGlobal('requestAnimationFrame', requestAnimationFrame);
    const workstreamId = '00000000-0000-4000-8000-000000000218';
    markWorkstreamFeedOpenStarted(workstreamId, 'recent', 'cold');
    reportTelemetryProductIntent.mockClear();

    render(<Probe workspaceSocketState="unavailable" workstreamId={workstreamId} />);

    expect(requestAnimationFrame).not.toHaveBeenCalled();
    expect(reportTelemetryProductIntent).not.toHaveBeenCalled();
  });

  it('cancels pending paint frames and reports the latest socket state', async () => {
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrameId = 0;
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
      nextFrameId += 1;
      frames.set(nextFrameId, callback);
      return nextFrameId;
    }));
    const cancelAnimationFrame = vi.fn((frameId: number) => {
      frames.delete(frameId);
    });
    vi.stubGlobal('cancelAnimationFrame', cancelAnimationFrame);
    const workstreamId = '00000000-0000-4000-8000-000000000219';
    const operationId = markWorkstreamFeedOpenStarted(workstreamId, 'recent', 'cold');
    reportTelemetryProductIntent.mockClear();

    const view = render(
      <Probe workspaceSocketState="reconnecting" workstreamId={workstreamId} />,
    );
    expect(frames).toHaveLength(1);
    const reconnectingFrameId = frames.keys().next().value as number;

    view.rerender(<Probe workspaceSocketState="connected" workstreamId={workstreamId} />);

    expect(cancelAnimationFrame).toHaveBeenCalledWith(reconnectingFrameId);
    expect(frames.has(reconnectingFrameId)).toBe(false);
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

    expect(reportTelemetryProductIntent).toHaveBeenCalledTimes(1);
    expect(reportTelemetryProductIntent).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'workstream_send_ready',
      operationId,
      workstreamId,
      workspaceSocketState: 'connected',
    }));
  });
});
