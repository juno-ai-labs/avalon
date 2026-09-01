import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  deleteStranded,
  formatCount,
  strandedDrafts,
} from './retire-standalone-automation-drafts.mjs';

const rows = [
  { automationId: 'a1', lifecycle: 'draft', authorUserId: 'u1', authoredInWorkstreamId: null },
  { automationId: 'a2', lifecycle: 'draft', authorUserId: 'u1', authoredInWorkstreamId: null },
  { automationId: 'a3', lifecycle: 'draft', authorUserId: 'u2', authoredInWorkstreamId: 'w1' },
  { automationId: 'a4', lifecycle: 'active', authorUserId: 'u2', authoredInWorkstreamId: null },
];

describe('retiring stranded automation drafts', () => {
  it('leaves a draft whose conversation somebody can still open', () => {
    // A draft authored in a work stream is not stranded: its room is still
    // there and its proposal card is still in that feed with its accept.
    // Deleting it would delete live work.
    assert.deepEqual(strandedDrafts(rows).map((row) => row.automationId), ['a1', 'a2']);
  });

  it('never touches an automation somebody already accepted', () => {
    // The screen's retirement strands drafts. An active automation has a
    // surface, a schedule, and possibly a run in flight.
    assert.equal(strandedDrafts(rows).some((row) => row.lifecycle !== 'draft'), false);
  });

  it('names who to tell before anything is deleted', () => {
    const text = formatCount(rows);

    // Counting is not a gate — it is so the decision is taken with the number
    // in view, and so the people losing work hear it from a person.
    assert.match(text, /2 drafts would be deleted/u);
    assert.match(text, /1 person/u);
    assert.match(text, /Tell them before this runs/u);
    assert.match(text, /u1: 2/u);
  });

  it('says plainly when the retirement costs nobody anything', () => {
    assert.match(formatCount([rows[2], rows[3]]), /No stranded drafts/u);
  });

  it('keeps going when one object refuses', async () => {
    const attempted = [];
    const report = await deleteStranded(rows, async (draft) => {
      attempted.push(draft.automationId);
      if (draft.automationId === 'a1') throw new Error('object unavailable');
    });

    // Every draft left behind is still a definition with no surface, so one
    // refusal must not strand the rest.
    assert.deepEqual(attempted, ['a1', 'a2']);
    assert.equal(report.deleted, 1);
    assert.equal(report.failures.length, 1);
    assert.equal(report.failures[0].automationId, 'a1');
  });
});
