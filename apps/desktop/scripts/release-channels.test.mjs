import assert from 'node:assert/strict';
import test from 'node:test';

import {
  STABLE_PROMOTION_INTERVAL_MS,
  decideStableChannelPromotion,
  encodeStableChannelReceipt,
  parseStableChannelReceipt,
} from './release-channels.mjs';

const now = Date.parse('2026-09-15T18:00:00.000Z');

test('bootstraps Stable and records the exact promotion time', () => {
  assert.deepEqual(decideStableChannelPromotion({
    candidateVersion: '1.2.0', stableVersion: undefined, receipt: undefined, now,
  }), {
    promote: true,
    receipt: { version: '1.2.0', promotedAt: '2026-09-15T18:00:00.000Z' },
    reason: 'bootstrap',
  });
});

test('promotes Stable no more than once in a rolling 24-hour window', () => {
  const receipt = { version: '1.1.0', promotedAt: new Date(now - STABLE_PROMOTION_INTERVAL_MS + 1).toISOString() };
  assert.equal(decideStableChannelPromotion({
    candidateVersion: '1.2.0', stableVersion: '1.1.0', receipt, now,
  }).promote, false);

  assert.deepEqual(decideStableChannelPromotion({
    candidateVersion: '1.2.0', stableVersion: '1.1.0',
    receipt: { ...receipt, promotedAt: new Date(now - STABLE_PROMOTION_INTERVAL_MS).toISOString() },
    now,
  }), {
    promote: true,
    receipt: { version: '1.2.0', promotedAt: '2026-09-15T18:00:00.000Z' },
    reason: 'cooldown_elapsed',
  });
});

test('repairs a missing receipt conservatively instead of promoting again', () => {
  assert.deepEqual(decideStableChannelPromotion({
    candidateVersion: '1.3.0', stableVersion: '1.2.0', receipt: undefined, now,
  }), {
    promote: false,
    receipt: { version: '1.2.0', promotedAt: '2026-09-15T18:00:00.000Z' },
    reason: 'receipt_repaired',
  });
});

test('parses the durable receipt and rejects manifest rollback state', () => {
  const receipt = parseStableChannelReceipt(JSON.parse(encodeStableChannelReceipt({
    version: '1.2.0', promotedAt: '2026-09-15T18:00:00.000Z',
  })));
  assert.deepEqual(receipt, { version: '1.2.0', promotedAt: '2026-09-15T18:00:00.000Z' });
  assert.throws(() => decideStableChannelPromotion({
    candidateVersion: '1.3.0', stableVersion: '1.1.0', receipt, now,
  }), /receipt 1\.2\.0 is ahead/u);
});
