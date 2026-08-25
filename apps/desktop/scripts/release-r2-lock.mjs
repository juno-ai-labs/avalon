import { createHash, randomUUID } from 'node:crypto';

import { DeleteObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

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
      && /^[0-9a-f]{32}$/u.test(body.result?.id)
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

export async function withR2ReleaseLock({
  bucket,
  client,
  key,
  operation,
  owner = randomUUID(),
  reportCleanupFailure = console.error,
}) {
  try {
    await client.send(new PutObjectCommand({
      Body: owner,
      Bucket: bucket,
      CacheControl: 'no-store',
      ContentType: 'text/plain; charset=utf-8',
      IfNoneMatch: '*',
      Key: key,
    }));
  } catch (error) {
    if (isConditionalConflict(error)) {
      const status = error?.$metadata?.httpStatusCode ?? 'unknown';
      throw new Error(
        `Another desktop release publisher holds r2://${bucket}/${key} (${error?.name ?? 'unknown'}, HTTP ${status})`,
        { cause: error },
      );
    }
    throw new Error(`Could not acquire the desktop release lock at r2://${bucket}/${key}`, { cause: error });
  }

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
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  } catch (error) {
    releaseError = new Error(
      `Desktop release publication completed, but its remote lock could not be released at r2://${bucket}/${key}; confirm no publisher is active and remove only that lock before the next release`,
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
    try {
      reportCleanupFailure(releaseError.message);
    } catch {
      // Reporting must not strand an already-published release before its tag
      // and checked-in release record are written by the workflow.
    }
  }
  return result;
}
