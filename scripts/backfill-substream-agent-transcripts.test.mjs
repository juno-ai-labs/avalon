import assert from 'node:assert/strict';
import { readFile, unlink } from 'node:fs/promises';
import test from 'node:test';

import { backfillSubstreamAgentTranscripts } from './backfill-substream-agent-transcripts.mjs';

const globalIds = Array.from({ length: 389 }, (_, index) => index.toString(16).padStart(64, '0'));
const euIds = Array.from(
  { length: 3 },
  (_, index) => (index + 10_000).toString(16).padStart(64, '0'),
);

function response(result) {
  return Response.json({ success: true, result, result_info: {} });
}

function fetcher(options = {}) {
  return async (url, request = {}) => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith('/workers/durable_objects/namespaces')) {
      return response([
        { id: 'global-namespace', class: 'SubstreamAgent', script: 'avalon-api-global' },
        { id: 'eu-namespace', class: 'SubstreamAgent', script: 'avalon-api-eu' },
      ]);
    }
    if (parsed.pathname.includes('/namespaces/global-namespace/objects')) {
      return response(globalIds.map((id) => ({ id, hasStoredData: true })));
    }
    if (parsed.pathname.includes('/namespaces/eu-namespace/objects')) {
      return response(euIds.map((id) => ({ id, hasStoredData: true })));
    }
    const body = JSON.parse(request.body);
    if ((body.operation ?? 'classify') === 'classify') {
      return Response.json({
        objects: body.objectIds.map((objectId) => ({
          objectId,
          jurisdiction: body.region === 'eu' ? 'eu' : 'us',
        })),
      });
    }
    options.onBackfill?.(body);
    return Response.json({
      objects: body.objectIds.map((objectId) => ({
        objectId,
        ...(objectId === options.failedObjectId ? { error: 'object_not_quiescent' } : { outcome: {
          applied: true,
          verified: true,
          operatorRunId: body.operatorRunId,
          preBackfillBookmark: `bookmark:${objectId}`,
          sourceSha256: 'a'.repeat(64),
          sourcePartCount: 1,
          participantTurnCount: 1,
          sourceCheckpointCount: 0,
          checkpointProjectionCount: 0,
          bindHistoryStatus: 'not_reconstructable_from_legacy_aggregate_rows',
        } }),
      })),
    });
  };
}

test('backfills exactly 389 Global and 3 EU objects and persists every recovery receipt', async () => {
  const receiptPath = `/tmp/rally-backfill-script-${crypto.randomUUID()}.json`;
  const batches = [];
  try {
    const result = await backfillSubstreamAgentTranscripts({
      argv: [
        '--apply',
        '--jurisdiction-probe-url=https://probe.test',
        '--expected-global=389',
        '--expected-eu=3',
        `--receipt=${receiptPath}`,
      ],
      environment: { CLOUDFLARE_ACCOUNT_ID: 'account', CLOUDFLARE_API_TOKEN: 'token' },
      fetcher: fetcher({ onBackfill: (body) => batches.push(body) }),
      logger: { log() {} },
    });
    assert.deepEqual(result.regions, {
      eu: {
        objects: 3,
        appliedObjects: 3,
        replayedObjects: 0,
        sourceParts: 3,
        participantTurns: 3,
        sourceCheckpoints: 0,
        checkpointProjections: 0,
      },
      global: {
        objects: 389,
        appliedObjects: 389,
        replayedObjects: 0,
        sourceParts: 389,
        participantTurns: 389,
        sourceCheckpoints: 0,
        checkpointProjections: 0,
      },
    });
    assert.equal(batches.length, 5);
    assert.ok(batches.every((batch) => batch.objectIds.length <= 100));
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
    assert.equal(receipt.regions.global.length, 389);
    assert.equal(receipt.regions.eu.length, 3);
    assert.ok(receipt.completedAt);
    assert.ok(Object.values(receipt.regions).flat().every((row) =>
      row.outcome.verified === true && row.outcome.preBackfillBookmark.startsWith('bookmark:')));
  } finally {
    await unlink(receiptPath).catch(() => undefined);
  }
});

test('persists every completed object outcome before a partial fleet failure exits nonzero', async () => {
  const receiptPath = `/tmp/rally-backfill-script-failure-${crypto.randomUUID()}.json`;
  try {
    await assert.rejects(backfillSubstreamAgentTranscripts({
      argv: [
        '--apply',
        '--jurisdiction-probe-url=https://probe.test',
        '--expected-global=389',
        '--expected-eu=3',
        `--receipt=${receiptPath}`,
      ],
      environment: { CLOUDFLARE_ACCOUNT_ID: 'account', CLOUDFLARE_API_TOKEN: 'token' },
      fetcher: fetcher({ failedObjectId: globalIds[20] }),
      logger: { log() {} },
    }), /legacy_transcript_backfill_failures_1/);
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
    assert.equal(receipt.regions.global.length, 389);
    assert.equal(receipt.regions.eu.length, 3);
    assert.equal(receipt.regions.global.filter((row) => row.error).length, 1);
    assert.ok(receipt.completedAt);
  } finally {
    await unlink(receiptPath).catch(() => undefined);
  }
});
