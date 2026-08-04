function cloudflareErrorCodes(body) {
  if (!Array.isArray(body?.errors)) return 'none';
  const codes = body.errors
    .map((error) => error?.code)
    .filter((code) => Number.isSafeInteger(code));
  return codes.length > 0 ? codes.join(',') : 'none';
}

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
        body: JSON.stringify({ files: urls }),
        signal: AbortSignal.timeout(30_000),
      },
    );
  } catch {
    throw new Error('Cloudflare URL purge request failed');
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
      `Cloudflare URL purge could not be confirmed (HTTP ${response.status}; codes: ${cloudflareErrorCodes(body)})`,
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
