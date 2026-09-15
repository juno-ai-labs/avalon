import { createHash, randomUUID } from 'node:crypto';

import { HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

import { cloudflareErrorCodes } from './release-cloudflare.mjs';

export async function createR2ReleaseLockClient({
  accountId,
  apiToken,
  fetchImplementation = fetch,
}) {
  const verificationUrls = [
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/tokens/verify`,
    'https://api.cloudflare.com/client/v4/user/tokens/verify',
  ];
  const failures = [];
  let tokenId;
  for (const url of verificationUrls) {
    let response;
    try {
      response = await fetchImplementation(url, {
        headers: { authorization: `Bearer ${apiToken}` },
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      failures.push('transport failure');
      continue;
    }
    const body = await response.json().catch(() => undefined);
    if (
      response.ok
      && body?.success === true
      && body.result?.status === 'active'
      && /^[0-9a-f]{32}$/iu.test(body.result?.id)
    ) {
      tokenId = body.result.id;
      break;
    }
    failures.push(`HTTP ${response.status}; codes: ${cloudflareErrorCodes(body)}`);
  }
  if (!tokenId) {
    throw new Error(
      `Could not resolve the R2 release-lock credential (${failures.join(' / ')})`,
    );
  }
  return new S3Client({
    credentials: {
      accessKeyId: tokenId,
      secretAccessKey: createHash('sha256').update(apiToken).digest('hex'),
    },
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    forcePathStyle: true,
    region: 'auto',
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
}

function isConditionalConflict(error) {
  return error?.name === 'PreconditionFailed'
    || error?.name === 'ConditionalRequestConflict'
    || error?.$metadata?.httpStatusCode === 409
    || error?.$metadata?.httpStatusCode === 412;
}

function activeLockInput({ bucket, key, owner, condition }) {
  return {
    Body: owner,
    Bucket: bucket,
    CacheControl: 'no-store',
    ContentType: 'text/plain; charset=utf-8',
    Key: key,
    Metadata: { owner, state: 'active' },
    ...condition,
  };
}

export class R2ReleaseLockHeldError extends Error {}

function lockHeldError({ bucket, error, key, owner }) {
  const status = error?.$metadata?.httpStatusCode ?? 'unknown';
  const ownerContext = typeof owner === 'string' ? `, owner=${JSON.stringify(owner)}` : '';
  return new R2ReleaseLockHeldError(
    `Another desktop release publisher holds r2://${bucket}/${key} (${error?.name ?? 'unknown'}, HTTP ${status}${ownerContext})`,
    { cause: error },
  );
}

async function acquireR2ReleaseLock({ bucket, client, key, owner }) {
  try {
    return await client.send(new PutObjectCommand(activeLockInput({
      bucket,
      key,
      owner,
      condition: { IfNoneMatch: '*' },
    })));
  } catch (error) {
    if (!isConditionalConflict(error)) {
      throw new Error(`Could not acquire the desktop release lock at r2://${bucket}/${key}`, { cause: error });
    }

    let current;
    try {
      current = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    } catch (headError) {
      throw new Error(`Could not inspect the desktop release lock at r2://${bucket}/${key}`, { cause: headError });
    }
    if (
      current.Metadata?.state !== 'released'
      || typeof current.ETag !== 'string'
      || current.ETag.length === 0
    ) {
      throw lockHeldError({ bucket, error, key, owner: current.Metadata?.owner });
    }
    try {
      return await client.send(new PutObjectCommand(activeLockInput({
        bucket,
        key,
        owner,
        condition: { IfMatch: current.ETag },
      })));
    } catch (replacementError) {
      if (isConditionalConflict(replacementError)) {
        throw lockHeldError({ bucket, error: replacementError, key });
      }
      throw new Error(`Could not acquire the desktop release lock at r2://${bucket}/${key}`, {
        cause: replacementError,
      });
    }
  }
}

export async function withR2ReleaseLock({
  bucket,
  client,
  key,
  operation,
  owner = randomUUID(),
  reportCleanupFailure = console.error,
  strictCleanup = false,
}) {
  const acquired = await acquireR2ReleaseLock({ bucket, client, key, owner });
  if (typeof acquired.ETag !== 'string' || acquired.ETag.length === 0) {
    throw new Error(
      `Could not acquire the desktop release lock at r2://${bucket}/${key}: R2 returned no ETag`,
    );
  }
  const lockEtag = acquired.ETag;

  let operationError;
  let operationFailed = false;
  let result;
  try {
    result = await operation();
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }

  let releaseError;
  try {
    // R2 does not support conditional DeleteObject, so the key always remains.
    // Every active/released transition is an ETag-conditional PutObject; an old
    // process therefore has no unconditional cleanup capable of changing a
    // newer publisher's generation.
    await client.send(new PutObjectCommand({
      Body: `released:${owner}`,
      Bucket: bucket,
      CacheControl: 'no-store',
      ContentType: 'text/plain; charset=utf-8',
      IfMatch: lockEtag,
      Key: key,
      Metadata: { owner, state: 'released' },
    }));
  } catch (error) {
    releaseError = new Error(
      `Desktop release publication completed, but its remote lock could not be marked released at r2://${bucket}/${key}; confirm no publisher is active and recover only that lock before the next release`,
      { cause: error },
    );
  }
  if (operationFailed && releaseError) {
    throw new AggregateError(
      [operationError, releaseError],
      `Desktop release publication failed and its remote lock could not be released at r2://${bucket}/${key}`,
    );
  }
  if (operationFailed) throw operationError;
  if (releaseError) {
    if (strictCleanup) throw releaseError;
    try {
      reportCleanupFailure(releaseError.message);
    } catch {
      // Reporting must not strand an already-published release before its tag
      // and checked-in release record are written by the workflow.
    }
  }
  return result;
}
