/**
 * One-time, jurisdiction-safe production backfill of pre-v27 work-stream rows.
 *
 * The Cloudflare inventory API supplies opaque object IDs. A local remote-dev
 * probe classifies those IDs and invokes the deployed, object-owned RPC through
 * each regional namespace binding. Every result, including the pre-write PITR
 * bookmark, is written to a mode-0600 local receipt before this command exits.
 */
import { readFile, rename, writeFile } from 'node:fs/promises';

import { isEntryPoint } from './entry-point.mjs';
import {
  classifyRegionalObjects,
  listNamespaces,
  listStoredObjects,
} from './force-substream-agent-migrations.mjs';

const CLASS_NAME = 'SubstreamAgent';
// Reuse the migration subsystem's reviewed 100-object fan-out batch; this
// one-off content operation must not introduce a second guessed fleet limit.
const BATCH_SIZE = 100;
const REGIONS = ['eu', 'global'];

function required(environment, name) {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function parseArguments(argv) {
  const args = argv.filter((argument) => argument !== '--');
  const value = (name) => args.find((argument) => argument.startsWith(`${name}=`))
    ?.slice(name.length + 1) ?? null;
  const apply = args.includes('--apply');
  const payloadTransfer = args.includes('--payload-transfer');
  const region = value('--region') ?? 'all';
  if (!['all', ...REGIONS].includes(region)) throw new Error(`unsupported_region:${region}`);
  const probeUrl = value('--jurisdiction-probe-url');
  if (!probeUrl || !URL.canParse(probeUrl)) throw new Error('jurisdiction_probe_url_required');
  const expected = {
    eu: Number(value('--expected-eu')),
    global: Number(value('--expected-global')),
  };
  const regions = region === 'all' ? REGIONS : [region];
  if (apply && regions.some((selected) => !Number.isSafeInteger(expected[selected]))) {
    throw new Error('apply_requires_explicit_expected_counts');
  }
  if (apply && regions.some((selected) =>
    expected[selected] !== (selected === 'eu' ? 3 : 389))) {
    throw new Error('apply_requires_reviewed_expected_counts');
  }
  const allowed = new Set([
    '--apply', '--payload-transfer', '--region', '--jurisdiction-probe-url', '--expected-eu',
    '--expected-global', '--receipt', '--eu-target-ids', '--global-target-ids',
  ]);
  const unknown = args.find((argument) => {
    const key = argument.includes('=') ? argument.slice(0, argument.indexOf('=')) : argument;
    return !allowed.has(key);
  });
  if (unknown) throw new Error(`unknown_argument:${unknown}`);
  return {
    apply,
    payloadTransfer,
    expected,
    probeUrl,
    receiptPath: value('--receipt'),
    regions,
    targetPaths: {
      eu: value('--eu-target-ids'),
      global: value('--global-target-ids'),
    },
  };
}

async function authoritativeTargets(path, eligibleObjectIds, region) {
  if (!path) return { targetObjectIds: eligibleObjectIds, excludedObjects: 0 };
  let parsed;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    throw new Error(`${region}_target_ids_invalid`);
  }
  if (!Array.isArray(parsed)) throw new Error(`${region}_target_ids_invalid`);
  const targetObjectIds = [];
  const seen = new Set();
  const eligible = new Set(eligibleObjectIds);
  for (const objectId of parsed) {
    if (typeof objectId !== 'string' || !/^[a-f0-9]{64}$/u.test(objectId)
      || seen.has(objectId) || !eligible.has(objectId)) {
      throw new Error(`${region}_target_ids_invalid`);
    }
    seen.add(objectId);
    targetObjectIds.push(objectId);
  }
  return {
    targetObjectIds,
    excludedObjects: eligibleObjectIds.length - targetObjectIds.length,
  };
}

function namespaceFor(namespaces, region) {
  const matches = namespaces.filter((namespace) =>
    namespace.class === CLASS_NAME && namespace.script === `avalon-api-${region}`);
  if (matches.length !== 1 || typeof matches[0]?.id !== 'string') {
    throw new Error(`${region}_substream_agent_namespace_count_${matches.length}`);
  }
  return matches[0].id;
}

async function invokeBackfill(
  probeUrl,
  region,
  objectIds,
  operatorRunId,
  fetcher,
  payloadTransfer = false,
) {
  const response = await fetcher(probeUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      operation: payloadTransfer ? 'transfer-payload-ownership' : 'backfill',
      region,
      objectIds,
      operatorRunId,
      cutoverVersion: 27,
    }),
  });
  if (!response.ok) throw new Error(`${region}_backfill_probe_${response.status}`);
  const payload = await response.json();
  if (!Array.isArray(payload.objects) || payload.objects.length !== objectIds.length) {
    throw new Error(`${region}_backfill_probe_incomplete`);
  }
  const expectedIds = new Set(objectIds);
  const seen = new Set();
  return payload.objects.map((row) => {
    if (!row || typeof row.objectId !== 'string'
      || !expectedIds.has(row.objectId) || seen.has(row.objectId)) {
      throw new Error(`${region}_backfill_probe_invalid`);
    }
    seen.add(row.objectId);
    const validCount = (count) => Number.isSafeInteger(count) && count >= 0;
    if (row.error !== undefined) {
      const cleanup = row.cleanup;
      const validCleanup = cleanup === undefined || (
        validCount(cleanup.abandonedRunCount)
        && typeof cleanup.cleanupOperatorRunId === 'string'
        && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
          .test(cleanup.cleanupOperatorRunId)
      );
      return validCleanup
        ? { objectId: row.objectId, ...(cleanup ? { cleanup } : {}), error: String(row.error) }
        : { objectId: row.objectId, error: 'invalid_cleanup_outcome' };
    }
    const outcome = row.outcome;
    if (payloadTransfer) {
      if (outcome?.verified !== true
        || typeof outcome.applied !== 'boolean'
        || typeof outcome.preTransferBookmark !== 'string'
        || outcome.preTransferBookmark.length === 0
        || typeof outcome.sourceSha256 !== 'string'
        || !/^[a-f0-9]{64}$/u.test(outcome.sourceSha256)
        || !validCount(outcome.sourcePartCount)
        || !validCount(outcome.sourceAttachmentCount)
        || !validCount(outcome.sourceMentionCount)
        || !validCount(outcome.sourceCheckpointCount)
        || !validCount(outcome.messageRecordCount)
        || !validCount(outcome.checkpointProjectionCount)
        || outcome.sourcePartCount !== outcome.messageRecordCount
        || outcome.sourceCheckpointCount !== outcome.checkpointProjectionCount) {
        return { objectId: row.objectId, error: 'unverified_payload_transfer_outcome' };
      }
      return { objectId: row.objectId, outcome };
    }
    const validCleanupOperator = outcome?.preCutoverCleanupOperatorRunId === null
      || (typeof outcome?.preCutoverCleanupOperatorRunId === 'string'
        && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
          .test(outcome.preCutoverCleanupOperatorRunId));
    if (outcome?.verified !== true
      || typeof outcome.applied !== 'boolean'
      || typeof outcome.preBackfillBookmark !== 'string'
      || outcome.preBackfillBookmark.length === 0
      || typeof outcome.sourceSha256 !== 'string'
      || !/^[a-f0-9]{64}$/u.test(outcome.sourceSha256)
      || !validCount(outcome.abandonedPreCutoverRunCount)
      || !validCleanupOperator
      || (outcome.abandonedPreCutoverRunCount > 0
        && outcome.preCutoverCleanupOperatorRunId === null)
      || !validCount(outcome.sourcePartCount)
      || !validCount(outcome.participantTurnCount)
      || outcome.sourcePartCount !== outcome.participantTurnCount
      || !validCount(outcome.sourceCheckpointCount)
      || !validCount(outcome.checkpointProjectionCount)
      || outcome.sourceCheckpointCount !== outcome.checkpointProjectionCount
      || outcome.bindHistoryStatus !== 'not_reconstructable_from_legacy_aggregate_rows') {
      return { objectId: row.objectId, error: 'unverified_backfill_outcome' };
    }
    return { objectId: row.objectId, outcome };
  });
}

async function persistReceipt(path, receipt) {
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

export async function backfillSubstreamAgentTranscripts({
  argv = process.argv.slice(2),
  environment = process.env,
  fetcher = fetch,
  logger = console,
} = {}) {
  const options = parseArguments(argv);
  const credentials = {
    accountId: required(environment, 'CLOUDFLARE_ACCOUNT_ID'),
    apiToken: required(environment, 'CLOUDFLARE_API_TOKEN'),
  };
  const namespaces = await listNamespaces(credentials, fetcher);
  const inventories = await Promise.all(options.regions.map(async (region) => {
    const namespaceId = namespaceFor(namespaces, region);
    const stored = await listStoredObjects(credentials, namespaceId, fetcher);
    const classified = await classifyRegionalObjects(
      { region }, stored, options.probeUrl, fetcher,
    );
    const targets = await authoritativeTargets(
      options.targetPaths[region],
      classified.eligibleObjectIds,
      region,
    );
    return { region, namespaceId, stored: stored.length, ...classified, ...targets };
  }));
  const counts = Object.fromEntries(inventories.map((inventory) => [inventory.region, {
    stored: inventory.stored,
    eligible: inventory.eligibleObjectIds.length,
    targeted: inventory.targetObjectIds.length,
    excluded: inventory.excludedObjects,
    skipped: inventory.skippedObjects,
  }]));
  logger.log(JSON.stringify({ mode: options.apply ? 'apply' : 'dry-run', regions: counts }, null, 2));
  if (!options.apply) return { mode: 'dry-run', regions: counts };
  for (const inventory of inventories) {
    if (inventory.targetObjectIds.length !== options.expected[inventory.region]) {
      throw new Error(
        `${inventory.region}_target_count_${inventory.targetObjectIds.length}`
        + `_expected_${options.expected[inventory.region]}`,
      );
    }
  }

  const operatorRunId = crypto.randomUUID();
  const receiptPath = options.receiptPath
    ?? `/tmp/rally-legacy-transcript-${options.payloadTransfer ? 'payload-transfer' : 'backfill'}-${operatorRunId}.json`;
  const receipt = {
    operatorRunId,
    startedAt: new Date().toISOString(),
    completedAt: null,
    regions: Object.fromEntries(inventories.map((inventory) => [inventory.region, []])),
  };
  await persistReceipt(receiptPath, receipt);
  for (const inventory of inventories) {
    for (let index = 0; index < inventory.targetObjectIds.length; index += BATCH_SIZE) {
      const objectIds = inventory.targetObjectIds.slice(index, index + BATCH_SIZE);
      const rows = await invokeBackfill(
        options.probeUrl,
        inventory.region,
        objectIds,
        operatorRunId,
        fetcher,
        options.payloadTransfer,
      );
      receipt.regions[inventory.region].push(...rows);
      await persistReceipt(receiptPath, receipt);
      logger.log(JSON.stringify({
        operatorRunId,
        region: inventory.region,
        completed: receipt.regions[inventory.region].length,
        expected: inventory.targetObjectIds.length,
      }));
    }
  }
  receipt.completedAt = new Date().toISOString();
  await persistReceipt(receiptPath, receipt);
  const failures = Object.values(receipt.regions).flat().filter((row) => row.error !== undefined);
  if (failures.length > 0) {
    throw new Error(`legacy_transcript_${options.payloadTransfer ? 'payload_transfer' : 'backfill'}_failures_${failures.length}`);
  }
  const totals = Object.fromEntries(Object.entries(receipt.regions).map(([region, rows]) => [region, {
    objects: rows.length,
    appliedObjects: rows.filter((row) => row.outcome.applied === true).length,
    replayedObjects: rows.filter((row) => row.outcome.applied === false).length,
    sourceParts: rows.reduce((sum, row) => sum + row.outcome.sourcePartCount, 0),
    ...(options.payloadTransfer ? {
      messageRecords: rows.reduce((sum, row) => sum + row.outcome.messageRecordCount, 0),
      sourceAttachments: rows.reduce((sum, row) => sum + row.outcome.sourceAttachmentCount, 0),
      sourceMentions: rows.reduce((sum, row) => sum + row.outcome.sourceMentionCount, 0),
    } : {
      participantTurns: rows.reduce((sum, row) => sum + row.outcome.participantTurnCount, 0),
    }),
    sourceCheckpoints: rows.reduce((sum, row) => sum + row.outcome.sourceCheckpointCount, 0),
    checkpointProjections: rows.reduce((sum, row) => sum + row.outcome.checkpointProjectionCount, 0),
    ...(options.payloadTransfer ? {} : {
      abandonedPreCutoverRuns: rows.reduce(
        (sum, row) => sum + row.outcome.abandonedPreCutoverRunCount,
        0,
      ),
    }),
  }]));
  logger.log(JSON.stringify({ operatorRunId, receiptPath, regions: totals }, null, 2));
  return { mode: 'apply', operatorRunId, receiptPath, regions: totals };
}

if (isEntryPoint(import.meta.url)) {
  backfillSubstreamAgentTranscripts().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
