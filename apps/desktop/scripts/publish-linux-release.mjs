import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { resolve } from 'node:path';
import { createR2ReleaseLockClient, withR2ReleaseLock } from './release-r2-lock.mjs';
import { purgeCloudflareUrls, verifyPublicReleaseArtifactHash } from './release-cache.mjs';
import { LINUX_RELEASE_PREFIX, loadLinuxRelease, publishLinuxRelease } from './linux-release.mjs';

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Set ${name} before publishing Linux`);
  return value;
}
const release = await loadLinuxRelease(resolve(process.argv[2] ?? 'release/linux-release'));
const commit = required('RALLY_RELEASE_COMMIT');
if (required('RALLY_RELEASE_PUBLISH_CONFIRM') !== release.feed.version) throw new Error('Confirm the exact Linux version');
const bucket = required('RALLY_RELEASE_R2_BUCKET');
const apiToken = required('CLOUDFLARE_API_TOKEN');
const zoneId = required('CLOUDFLARE_ZONE_ID');
const client = await createR2ReleaseLockClient({ accountId: required('CLOUDFLARE_ACCOUNT_ID'), apiToken });
const key = (name) => `${LINUX_RELEASE_PREFIX}/${name}`;
const url = (name) => `https://downloads.rallywith.ai/${key(name)}`;
async function read(name) {
  try {
    const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key(name) }));
    return Buffer.from(await response.Body.transformToByteArray());
  } catch (error) {
    if (error?.$metadata?.httpStatusCode === 404) return undefined;
    throw error;
  }
}
try {
  await withR2ReleaseLock({ bucket, client, key: key('release-publish.lock'), strictCleanup: true,
    operation: () => publishLinuxRelease({ release, commit, read,
      write: async (name, bytes, immutable) => {
        await client.send(new PutObjectCommand({ Bucket: bucket, Key: key(name), Body: bytes,
          ...(immutable ? { IfNoneMatch: '*' } : {}),
          CacheControl: immutable ? 'public, max-age=31536000, immutable' : 'public, max-age=0, must-revalidate',
          ContentType: name.endsWith('.yml') ? 'application/yaml' : 'application/octet-stream' }));
        if (!(await read(name))?.equals(bytes)) throw new Error(`Linux R2 verification failed: ${name}`);
      },
      verifyPublic: async (name, expectedHash) => {
        await purgeCloudflareUrls({ apiToken, zoneId, urls: [url(name)] });
        await verifyPublicReleaseArtifactHash({ url: url(name), expectedHash });
      },
    }),
  });
} finally { client.destroy(); }
