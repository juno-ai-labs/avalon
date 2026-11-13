import { describe, expect, it } from 'vitest';
import { allocatePinSlots } from './pin-routes';

describe('native pin destinations', () => {
  it('keeps canvas identities in their destinations when display order changes', () => {
    expect(allocatePinSlots(['newsletter', 'grocery', null, null], ['grocery', 'newsletter'], 4))
      .toEqual(['newsletter', 'grocery', null, null]);
  });
  it('releases an unpinned destination without moving the remaining canvas', () => {
    expect(allocatePinSlots(['newsletter', 'grocery', null, null], ['grocery'], 4))
      .toEqual([null, 'grocery', null, null]);
  });
  it('reuses empty destinations and starts fresh for a new account scope', () => {
    expect(allocatePinSlots([null, 'grocery', null, null], ['grocery', 'podcast'], 4))
      .toEqual(['podcast', 'grocery', null, null]);
    expect(allocatePinSlots([], ['podcast'], 4)).toEqual(['podcast', null, null, null]);
  });
});
