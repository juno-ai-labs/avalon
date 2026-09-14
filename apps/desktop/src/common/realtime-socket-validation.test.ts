import { describe, expect, it } from 'vitest';
import { DesktopRealtimeSocketHandshakePhaseSchema } from './realtime-socket';
import { parseRealtimeSocketEvent } from './realtime-socket-validation';

const socketId = '00000000-0000-4000-8000-000000000002';

describe('parseRealtimeSocketEvent', () => {
  it('accepts every closed broker event shape', () => {
    for (const phase of DesktopRealtimeSocketHandshakePhaseSchema.options) {
      expect(parseRealtimeSocketEvent({
        type: 'handshake_phase', socketId, phase,
        durationMs: 6.4, routeIndex: 0, proxied: false,
      })).toEqual({
        type: 'handshake_phase', socketId, phase,
        durationMs: 6.4, routeIndex: 0, proxied: false,
      });
    }
    expect(parseRealtimeSocketEvent({
      type: 'open', socketId, protocol: 'rally.ticket.v1', extensions: '',
    })).toEqual({ type: 'open', socketId, protocol: 'rally.ticket.v1', extensions: '' });
    expect(parseRealtimeSocketEvent({ type: 'message', socketId, data: 'ping' }))
      .toEqual({ type: 'message', socketId, data: 'ping' });
    expect(parseRealtimeSocketEvent({ type: 'error', socketId }))
      .toEqual({ type: 'error', socketId });
    expect(parseRealtimeSocketEvent({
      type: 'close', socketId, code: 1_000, reason: 'done', wasClean: true,
    })).toEqual({ type: 'close', socketId, code: 1_000, reason: 'done', wasClean: true });
  });

  it('rejects malformed broker events', () => {
    for (const event of [
      { type: 'error', socketId: 'not-a-socket-id' },
      { type: 'open', socketId, protocol: 'rally.ticket.v1' },
      { type: 'message', socketId, data: 1 },
      {
        type: 'handshake_phase', socketId, phase: 'not-a-phase',
        durationMs: 1, routeIndex: 0, proxied: false,
      },
      {
        type: 'handshake_phase', socketId, phase: 'dns',
        durationMs: -1, routeIndex: 0, proxied: false,
      },
      {
        type: 'handshake_phase', socketId, phase: 'dns',
        durationMs: Number.NaN, routeIndex: 0, proxied: false,
      },
      {
        type: 'handshake_phase', socketId, phase: 'dns',
        durationMs: Number.POSITIVE_INFINITY, routeIndex: 0, proxied: false,
      },
      {
        type: 'handshake_phase', socketId, phase: 'dns',
        durationMs: 1, routeIndex: -1, proxied: false,
      },
      {
        type: 'handshake_phase', socketId, phase: 'dns',
        durationMs: 1, routeIndex: 0.5, proxied: false,
      },
      {
        type: 'handshake_phase', socketId, phase: 'dns',
        durationMs: 1, routeIndex: 0, proxied: 'no',
      },
      {
        type: 'handshake_phase', socketId, phase: 'dns',
        durationMs: 1, routeIndex: 0, proxied: false, url: 'wss://attacker.example',
      },
      { type: 'close', socketId, code: 1_000, reason: '', wasClean: 'yes' },
      { type: 'error', socketId, url: 'wss://attacker.example' },
    ]) {
      expect(parseRealtimeSocketEvent(event)).toBeNull();
    }
  });
});
