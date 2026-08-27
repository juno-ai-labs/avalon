import { describe, expect, it } from 'vitest';
import { parseRealtimeSocketEvent } from './realtime-socket-validation';

const socketId = '00000000-0000-4000-8000-000000000002';

describe('parseRealtimeSocketEvent', () => {
  it('accepts every closed broker event shape', () => {
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

  it('rejects invalid IDs, missing fields, wrong field types, and extra authority', () => {
    for (const event of [
      { type: 'error', socketId: 'not-a-socket-id' },
      { type: 'open', socketId, protocol: 'rally.ticket.v1' },
      { type: 'message', socketId, data: 1 },
      { type: 'close', socketId, code: 1_000, reason: '', wasClean: 'yes' },
      { type: 'error', socketId, url: 'wss://attacker.example' },
    ]) {
      expect(parseRealtimeSocketEvent(event)).toBeNull();
    }
  });
});
