import { describe, expect, it } from 'vitest';

import { conversationReadAcknowledgement } from './conversation-surface';

const VIEWER: { readThroughSequenceNumber: number; manualUnreadFromSequenceNumber: number | null; manualUnreadGeneration: number } = {
  readThroughSequenceNumber: 12, manualUnreadFromSequenceNumber: null, manualUnreadGeneration: 3,
};
const at = (highestVisibleSequence: number, reportedThisOpen: boolean, viewer = VIEWER) =>
  conversationReadAcknowledgement({ parentId: 'sidekick-1', substreamId: '0', highestVisibleSequence, viewer, reportedThisOpen });

describe('conversationReadAcknowledgement', () => {
  it('reports once on opening a conversation read to where it was, at the cursor the room holds', () => {
    // A finished run's Activity row clears on a report's time, so the open
    // has to say something even though nothing new is on screen.
    expect(at(9, false)).toEqual({
      parentId: 'sidekick-1', substreamId: '0', readThroughSequenceNumber: 12, observedManualUnreadGeneration: 3, key: 'sidekick-1:0:12:3',
    });
  });

  it('sends nothing more for the same open until the cursor moves', () => {
    expect(at(12, true)).toBeNull();
    expect(at(14, true)).toMatchObject({ readThroughSequenceNumber: 14 });
  });

  it('retires a standing manual mark at what is on screen, however often it has reported', () => {
    expect(at(9, true, { ...VIEWER, manualUnreadFromSequenceNumber: 8 })).toMatchObject({ readThroughSequenceNumber: 9 });
  });

  it('has nothing to report with no message that asks for attention on screen', () => {
    expect(at(0, false)).toBeNull();
  });
});
