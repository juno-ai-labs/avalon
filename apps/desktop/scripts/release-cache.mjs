import { createHash } from 'node:crypto';

import { cloudflareErrorCodes } from './release-cloudflare.mjs';

export async function purgeCloudflareUrls({
  apiToken,
  fetchImplementation = fetch,
  urls,
  zoneId,
}) {
  if (!Array.isArray(urls) || urls.length === 0) {
    throw new Error('Cloudflare URL purge requires at least one URL');
  }
  for (const value of urls) {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
      throw new Error('Cloudflare URL purge requires exact HTTPS URLs without credentials, queries, or fragments');
    }
  }

  await confirmedCloudflarePurge({
    apiToken, fetchImplementation, label: 'Cloudflare URL purge', payload: { files: urls }, zoneId,
  });
}

export async function purgeCloudflarePrefix({
  apiToken,
  fetchImplementation = fetch,
  prefixUrl,
  zoneId,
}) {
  const url = new URL(prefixUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
    || !url.pathname.endsWith('/') || url.pathname === '/') {
    throw new Error('Cloudflare prefix purge requires a non-root HTTPS directory URL');
  }
  await confirmedCloudflarePurge({
    apiToken,
    fetchImplementation,
    label: 'Cloudflare prefix purge',
    payload: { prefixes: [`${url.host}${url.pathname}`] },
    zoneId,
  });
}

async function confirmedCloudflarePurge({ apiToken, fetchImplementation, label, payload, zoneId }) {
  let response;
  try {
    response = await fetchImplementation(
      `https://api.cloudflare.com/client/v4/zones/${encodeURIComponent(zoneId)}/purge_cache`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(30_000),
      },
    );
  } catch {
    throw new Error(`${label} request failed`);
  }

  const body = await response.json().catch(() => undefined);
  if (
    !response.ok
    || !body
    || body.success !== true
    || typeof body.result?.id !== 'string'
    || body.result.id.length === 0
  ) {
    throw new Error(
      `${label} could not be confirmed (HTTP ${response.status}; codes: ${cloudflareErrorCodes(body)})`,
    );
  }
}

export async function purgeAndVerifyImmutableReleaseUrls({
  artifacts,
  purgeUrls,
  verifyArtifact,
}) {
  await purgeUrls(artifacts.map(({ url }) => url));
  for (const artifact of artifacts) await verifyArtifact(artifact);
}

function sleep(milliseconds) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

export async function verifyPublicReleaseArtifactHash({
  clearIdleTimeoutImplementation = clearTimeout,
  expectedHash,
  fetchImplementation = fetch,
  idleTimeoutMilliseconds = 30_000,
  setIdleTimeoutImplementation = setTimeout,
  sleepImplementation = sleep,
  url,
}) {
  const publicUrl = new URL(url);
  if (
    publicUrl.protocol !== 'https:'
    || publicUrl.username
    || publicUrl.password
    || publicUrl.search
    || publicUrl.hash
  ) {
    throw new Error('Public release hash verification requires an exact HTTPS URL');
  }

  let failure = 'no response';
  for (let attempt = 0; attempt < 7; attempt += 1) {
    const abortController = new AbortController();
    let idleTimeout;
    const refreshIdleTimeout = () => {
      clearIdleTimeoutImplementation(idleTimeout);
      idleTimeout = setIdleTimeoutImplementation(() => abortController.abort(), idleTimeoutMilliseconds);
    };
    try {
      refreshIdleTimeout();
      const response = await fetchImplementation(publicUrl, {
        signal: abortController.signal,
      });
      if (!response.ok) {
        failure = `HTTP ${response.status}`;
        try {
          await response.body?.cancel();
        } catch {
          // Preserve the provider's status when stream teardown also fails.
        }
      } else if (!response.body) {
        failure = 'missing response body';
      } else {
        const hash = createHash('sha512');
        for await (const chunk of response.body) {
          hash.update(chunk);
          refreshIdleTimeout();
        }
        if (hash.digest('base64') === expectedHash) return;
        failure = 'SHA-512 mismatch';
      }
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    } finally {
      clearIdleTimeoutImplementation(idleTimeout);
    }
    if (attempt < 6) await sleepImplementation(500 * 2 ** attempt);
  }
  throw new Error(`Public artifact hash verification failed for ${publicUrl}: ${failure}`);
}
