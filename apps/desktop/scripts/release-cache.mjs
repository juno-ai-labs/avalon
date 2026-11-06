import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';

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

// A release artifact is ~183 MiB, so a wall-clock deadline on the whole transfer
// aborts healthy downloads on a slow link. These transfers abort only when bytes
// stop arriving, and the deadline restarts on every chunk.
const releaseTransferIdleTimeoutMilliseconds = 30_000;

function createTransferIdleDeadline({
  clearIdleTimeoutImplementation = clearTimeout,
  idleTimeoutMilliseconds = releaseTransferIdleTimeoutMilliseconds,
  setIdleTimeoutImplementation = setTimeout,
} = {}) {
  const abortController = new AbortController();
  let idleTimeout;
  const refresh = () => {
    clearIdleTimeoutImplementation(idleTimeout);
    idleTimeout = setIdleTimeoutImplementation(() => abortController.abort(new DOMException(
      `No bytes arrived for ${idleTimeoutMilliseconds} ms`,
      'TimeoutError',
    )), idleTimeoutMilliseconds);
  };
  refresh();
  return {
    dispose: () => clearIdleTimeoutImplementation(idleTimeout),
    refresh,
    signal: abortController.signal,
  };
}

// Downloads `url` into `destination`. Returns false on 404 and throws on any
// other non-success status, naming `label` and `source` in the error.
export async function downloadReleaseObject({
  clearIdleTimeoutImplementation,
  destination,
  fetchImplementation = fetch,
  headers,
  idleTimeoutMilliseconds,
  label,
  setIdleTimeoutImplementation,
  source,
  url,
}) {
  const deadline = createTransferIdleDeadline({
    clearIdleTimeoutImplementation,
    idleTimeoutMilliseconds,
    setIdleTimeoutImplementation,
  });
  try {
    const response = await fetchImplementation(url, { headers, signal: deadline.signal });
    deadline.refresh();
    if (response.status === 404) {
      try {
        await response.body?.cancel();
      } catch {
        // The 404 is authoritative even when stream teardown fails.
      }
      return false;
    }
    if (!response.ok || !response.body) {
      let detail;
      try {
        detail = (await response.text()).slice(0, 1_000);
      } catch {
        // Preserve the provider's status when its body cannot be read.
        detail = 'unreadable response body';
      }
      throw new Error(`Could not inspect ${label}; ${source} returned HTTP ${response.status}: ${detail}`);
    }
    const { body } = response;
    await pipeline(
      async function* refreshOnEachChunk() {
        for await (const chunk of body) {
          deadline.refresh();
          yield chunk;
        }
      },
      createWriteStream(destination, { mode: 0o600 }),
    );
    return true;
  } finally {
    deadline.dispose();
  }
}

export async function verifyPublicReleaseArtifactHash({
  clearIdleTimeoutImplementation = clearTimeout,
  expectedHash,
  fetchImplementation = fetch,
  idleTimeoutMilliseconds = releaseTransferIdleTimeoutMilliseconds,
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
    const deadline = createTransferIdleDeadline({
      clearIdleTimeoutImplementation,
      idleTimeoutMilliseconds,
      setIdleTimeoutImplementation,
    });
    try {
      const response = await fetchImplementation(publicUrl, {
        signal: deadline.signal,
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
          deadline.refresh();
        }
        if (hash.digest('base64') === expectedHash) return;
        failure = 'SHA-512 mismatch';
      }
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    } finally {
      deadline.dispose();
    }
    if (attempt < 6) await sleepImplementation(500 * 2 ** attempt);
  }
  throw new Error(`Public artifact hash verification failed for ${publicUrl}: ${failure}`);
}
