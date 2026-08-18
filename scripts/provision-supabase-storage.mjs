import { isEntryPoint } from './entry-point.mjs';

const buckets = Object.freeze([
  { id: 'workspace-content', public: false, file_size_limit: 536_870_912 },
  { id: 'connector-ingress', public: false, file_size_limit: 536_870_912 },
  { id: 'exports', public: false, file_size_limit: 536_870_912 },
]);

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name.toLowerCase()}_required`);
  return value;
}

function authorizationHeaders(serviceRoleKey) {
  return {
    apikey: serviceRoleKey,
    authorization: `Bearer ${serviceRoleKey}`,
    'content-type': 'application/json',
  };
}

async function request(url, init, { allowNotFound = false } = {}) {
  const response = await fetch(url, init);
  if (response.ok || (allowNotFound && response.status === 404)) return response;
  const body = (await response.text()).slice(0, 500);
  throw new Error(`supabase_storage_request_failed:${response.status}:${body}`);
}

async function readBucket(bucketUrl, headers) {
  const response = await request(bucketUrl, { method: 'GET', headers }, { allowNotFound: true });
  if (response.status === 404) return null;
  const bucket = await response.json();
  return bucket && typeof bucket === 'object' ? bucket : null;
}

function assertBucketConfiguration(actual, expected) {
  if (actual?.id !== expected.id || actual?.name !== expected.id
      || actual?.public !== false
      || Number(actual?.file_size_limit) !== expected.file_size_limit) {
    throw new Error(`supabase_storage_bucket_configuration_mismatch:${expected.id}`);
  }
}

export async function provisionSupabaseStorage({ projectUrl, serviceRoleKey }) {
  const root = new URL('/storage/v1/', projectUrl);
  const headers = authorizationHeaders(serviceRoleKey);
  for (const bucket of buckets) {
    const bucketUrl = new URL(`bucket/${encodeURIComponent(bucket.id)}`, root);
    const existing = await readBucket(bucketUrl, headers);
    const body = JSON.stringify({
      id: bucket.id,
      name: bucket.id,
      public: bucket.public,
      file_size_limit: bucket.file_size_limit,
    });
    if (existing === null) {
      await request(new URL('bucket', root), { method: 'POST', headers, body });
    } else {
      await request(bucketUrl, { method: 'PUT', headers, body });
    }
    const verified = await readBucket(bucketUrl, headers);
    if (verified === null) throw new Error(`supabase_storage_bucket_missing_after_write:${bucket.id}`);
    assertBucketConfiguration(verified, bucket);
  }
  return buckets.map(({ id }) => id);
}

if (isEntryPoint(import.meta.url)) {
  const provisioned = await provisionSupabaseStorage({
    projectUrl: requiredEnvironment('SUPABASE_URL'),
    serviceRoleKey: requiredEnvironment('SUPABASE_SERVICE_ROLE_KEY'),
  });
  process.stdout.write(`Provisioned private Supabase Storage buckets: ${provisioned.join(', ')}\n`);
}
