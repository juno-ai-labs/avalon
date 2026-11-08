import "../../../../tests/isolated-region";
import { describe, expect, it } from 'vitest';

import { parseTelemetryProductIntent } from './telemetry-intent';

/**
 * The renderer cannot name an event or hand main a property bag, and this is
 * where that is enforced. A test that matched the allowlist's source text would
 * pass on a build whose dispatch was broken and fail on one that was merely
 * reformatted, so every case here runs the parser.
 */
describe('parseTelemetryProductIntent', () => {
  const socketIntent = {
    kind: 'realtime_socket_state',
    socket: 'substream_feed',
    state: 'retrying',
    cause: 'heartbeat_timeout',
    attempts: 'one',
  };

  it('admits a realtime socket transition and returns it as its registered shape', () => {
    expect(parseTelemetryProductIntent({ ...socketIntent })).toEqual(socketIntent);
  });

  it("admits a copied assistant reply, which a turn id names rather than a UUID", () => {
    const intent = {
      kind: 'content_copied', contentType: 'message_response', resourceType: 'message',
      resourceId: 'workstream:018f22f2-4c22-7abc-8def-0123456789ab:substream:0:loop:turn:3',
      workstreamId: '018f22f2-4c22-7abc-8def-0123456789ab',
    };
    expect(parseTelemetryProductIntent(intent)).toEqual(intent);
  });

  it('admits desktop action phases with only correlation and timing fields', () => {
    const intent = {
      kind: 'desktop_action_phase', actionId: '018f22f2-4c22-7abc-8def-0123456789ab',
      phase: 'browser_command_requested', elapsedMs: 42, windowVisible: false,
    };
    expect(parseTelemetryProductIntent(intent)).toEqual(intent);
    expect(() => parseTelemetryProductIntent({ ...intent, script: 'secret' })).toThrow('Invalid telemetry intent');
    expect(() => parseTelemetryProductIntent({ ...intent, phase: 'unknown' })).toThrow('Invalid telemetry intent');
  });

  it('accepts only content-free workspace handshake phases with a UUIDv7 attempt', () => {
    const intent = {
      kind: 'workspace_socket_handshake',
      attemptId: '018f22f2-4c22-7abc-8def-0123456789ab',
      phase: 'subscribe_sent',
    };
    expect(parseTelemetryProductIntent(intent)).toEqual(intent);
    expect(() => parseTelemetryProductIntent({ ...intent, phase: 'waiting' }))
      .toThrow('Invalid telemetry intent');
    expect(() => parseTelemetryProductIntent({ ...intent, attemptId: 'not-a-uuid' }))
      .toThrow('Invalid telemetry intent');
    expect(() => parseTelemetryProductIntent({ ...intent, url: 'wss://secret' }))
      .toThrow('Invalid telemetry intent');
  });

  it('admits correlated feed paint and socket start intents with only registered fields', () => {
    const operationId = '018f22f2-4c22-7abc-8def-0123456789ab';
    const socketLeaseId = '018f22f2-4c22-7abc-8def-0123456789ac';
    const workstreamId = '00000000-0000-4000-8000-000000000201';
    const feedIntent = {
      kind: 'workstream_feed_visible',
      operationId,
      workstreamId,
      socketLeaseId,
      durationMs: 240,
      dataReadyDurationMs: 220,
      sidebarSection: 'recent',
      cacheState: 'feed_cached',
      socketPoolState: 'retained_pair',
      feedSource: 'feed_cache',
      messageCount: 'two_to_five',
    };
    expect(parseTelemetryProductIntent(feedIntent)).toEqual(feedIntent);
    expect(() => parseTelemetryProductIntent({ ...feedIntent, dataReadyDurationMs: 241 }))
      .toThrow('Invalid telemetry intent');

    const sendReadyIntent = {
      kind: 'workstream_send_ready',
      operationId,
      workstreamId,
      durationMs: 252,
      workspaceSocketState: 'reconnecting',
    };
    expect(parseTelemetryProductIntent(sendReadyIntent)).toEqual(sendReadyIntent);
    expect(() => parseTelemetryProductIntent({ ...sendReadyIntent, workspaceSocketState: 'queued' }))
      .toThrow('Invalid telemetry intent');
    expect(() => parseTelemetryProductIntent({ ...sendReadyIntent, workspaceSocketState: 'unavailable' }))
      .toThrow('Invalid telemetry intent');
    expect(() => parseTelemetryProductIntent({ ...sendReadyIntent, composerText: 'secret' }))
      .toThrow('Invalid telemetry intent');

    const socketIntent = {
      kind: 'workstream_socket_started',
      operationId,
      workstreamId,
      socketLeaseId,
      openAttemptId: operationId,
      socket: 'substream_feed',
      reason: 'reconnect',
      attempts: 'one',
    };
    expect(parseTelemetryProductIntent(socketIntent)).toEqual(socketIntent);
    expect(() => parseTelemetryProductIntent({ ...socketIntent, reason: 'maybe' }))
      .toThrow('Invalid telemetry intent');

    const startedIntent = {
      kind: 'workstream_open_started',
      operationId,
      workstreamId,
      sidebarSection: 'recent',
      socketPoolState: 'retained_pair',
      socketLeaseId,
    };
    expect(parseTelemetryProductIntent(startedIntent)).toEqual(startedIntent);
    const supersededIntent = {
      kind: 'workstream_open_outcome',
      operationId,
      workstreamId,
      outcome: 'superseded',
      durationMs: 24,
      socketLeaseId,
      supersedingWorkstreamId: '00000000-0000-4000-8000-000000000202',
    };
    expect(parseTelemetryProductIntent(supersededIntent)).toEqual(supersededIntent);
    expect(() => parseTelemetryProductIntent({ ...supersededIntent, supersedingWorkstreamId: undefined }))
      .toThrow('Invalid telemetry intent');
    expect(parseTelemetryProductIntent({
      ...supersededIntent,
      outcome: 'abandoned',
      supersedingWorkstreamId: undefined,
    })).toEqual({
      ...supersededIntent,
      outcome: 'abandoned',
      supersedingWorkstreamId: undefined,
    });
  });

  it('admits a correlated renderer timing projection and rejects console-only fields', () => {
    const intent = {
      kind: 'renderer_perf_flow',
      operationId: '018f22f2-4c22-7abc-8def-0123456789ab',
      flow: 'workstream_open',
      workstreamId: '00000000-0000-4000-8000-000000000201',
      outcome: 'snapshot',
      durationMs: 814.2,
      blockedMs: 10.1,
      longTaskCount: 'one',
      socketTicketMs: 212.4,
      dialMs: 2.1,
      handshakeMs: 480.2,
      firstFrameMs: 119.5,
      attempts: 'zero',
      sinceEffectMs: 8.4,
      ticketId: '018f22f2-4c22-7abc-8def-0123456789ac',
      clientMessageId: '00000000-0000-4000-8000-000000000202',
      messageCount: 'six_to_twenty',
    };
    expect(parseTelemetryProductIntent(intent)).toEqual(intent);
    expect(() => parseTelemetryProductIntent({ ...intent, afterSequence: 42 }))
      .toThrow('Invalid telemetry intent');
    expect(() => parseTelemetryProductIntent({ ...intent, operationId: 'not-v7' }))
      .toThrow('Invalid telemetry intent');
  });

  it('refuses a socket transition the registry would not accept', () => {
    // A property the contract does not declare. The registry parse is strict,
    // so this is refused rather than quietly stripped and sent.
    expect(() => parseTelemetryProductIntent({ ...socketIntent, closeCode: 1006 }))
      .toThrow('Invalid telemetry intent');
    // A cause outside the closed vocabulary.
    expect(() => parseTelemetryProductIntent({ ...socketIntent, cause: 'because' }))
      .toThrow('Invalid telemetry intent');
    // A state and cause that describe different transitions, which the
    // contract's own refinement rejects.
    expect(() => parseTelemetryProductIntent({ ...socketIntent, state: 'connected' }))
      .toThrow('Invalid telemetry intent');
    // A socket kind that is not one of the four this contract covers.
    expect(() => parseTelemetryProductIntent({ ...socketIntent, socket: 'dictation' }))
      .toThrow('Invalid telemetry intent');
  });

  it('refuses an event name the renderer invented', () => {
    expect(() => parseTelemetryProductIntent({ kind: 'password_entered', value: 'hunter2' }))
      .toThrow('Invalid telemetry intent');
    expect(() => parseTelemetryProductIntent({ kind: 'screen_viewed', screen: 'workspace_home' }))
      .toThrow('Invalid telemetry intent');
  });

  it('refuses anything that is not an intent at all', () => {
    for (const value of [null, undefined, 'realtime_socket_state', 42, [socketIntent]]) {
      expect(() => parseTelemetryProductIntent(value)).toThrow('Invalid telemetry intent');
    }
  });

  it('still admits the hand-validated intents that predate the registry path', () => {
    // The allowlist is shared, so the socket event must not be the only kind
    // this file proves reaches the reporter.
    expect(parseTelemetryProductIntent({
      kind: 'onboarding_region_selected', selectedRegion: 'enterprise', entrypoint: 'first_run',
    })).toEqual({ kind: 'onboarding_region_selected', selectedRegion: 'enterprise', entrypoint: 'first_run' });
    expect(() => parseTelemetryProductIntent({
      kind: 'onboarding_region_selected', selectedRegion: 'mars', entrypoint: 'first_run',
    })).toThrow('Invalid telemetry intent');
    expect(() => parseTelemetryProductIntent({
      kind: 'workspace_create_requested',
      selectedRegion: 'global',
      entrypoint: 'first_run',
      operationId: 'not-a-uuid-v7',
    })).toThrow('Invalid telemetry intent');
  });
});
