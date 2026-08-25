export interface DesktopReleaseConfig {
  published: boolean;
  version: string;
  platform: string;
  architecture: string;
  downloadBaseUrl: string;
  bucket: string;
  prefix: string;
  files: {
    dmg: string;
    canonicalDmg: string;
    zip: string;
    blockmaps: string[];
    checksums: string;
    latest: string;
  };
  objects: {
    dmg: string;
    canonicalDmg: string;
    zip: string;
    blockmaps: string[];
    checksums: string;
    latest: string;
  };
  sha256?: Record<string, string>;
  publishedAt?: string | null;
}

export interface DesktopReleasePublication {
  published: boolean;
  version: string;
  publishedAt?: string;
}

const releaseStartMarker = '<!-- rally-desktop-release:start -->';
const releaseEndMarker = '<!-- rally-desktop-release:end -->';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Desktop release configuration requires ${key}.`);
  }
  return value;
}

function safeObjectKey(value: string, label: string): string {
  if (
    value.startsWith('/')
    || value.includes('\\')
    || value.split('/').some((part) => part === '' || part === '.' || part === '..')
    || /[?#]/u.test(value)
  ) {
    throw new Error(`Desktop release ${label} is not a safe object key.`);
  }
  return value;
}

function safeFileName(value: string, label: string): string {
  if (value.includes('/') || value.includes('\\') || value === '.' || value === '..' || /[?#]/u.test(value)) {
    throw new Error(`Desktop release ${label} is not a plain file name.`);
  }
  return value;
}

function stringArray(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== 'string')) {
    throw new Error(`Desktop release configuration requires a non-empty ${key} array.`);
  }
  return value as string[];
}

export function parseDesktopReleaseConfig(value: unknown): DesktopReleaseConfig {
  if (!isRecord(value) || typeof value.published !== 'boolean') {
    throw new Error('Desktop release configuration is invalid.');
  }
  if (!isRecord(value.files) || !isRecord(value.objects)) {
    throw new Error('Desktop release files and object keys are required.');
  }
  const downloadBaseUrl = new URL(requiredString(value, 'downloadBaseUrl'));
  if (
    downloadBaseUrl.protocol !== 'https:'
    || downloadBaseUrl.username
    || downloadBaseUrl.password
    || downloadBaseUrl.search
    || downloadBaseUrl.hash
    || (downloadBaseUrl.pathname !== '/' && downloadBaseUrl.pathname !== '')
  ) {
    throw new Error('Desktop releases require an HTTPS download origin.');
  }
  const prefix = safeObjectKey(requiredString(value, 'prefix'), 'prefix');
  const version = requiredString(value, 'version');
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(version)) {
    throw new Error('Desktop release version must be semantic.');
  }
  const files = {
    dmg: safeFileName(requiredString(value.files, 'dmg'), 'DMG file'),
    canonicalDmg: safeFileName(requiredString(value.files, 'canonicalDmg'), 'canonical DMG file'),
    zip: safeFileName(requiredString(value.files, 'zip'), 'ZIP file'),
    blockmaps: stringArray(value.files, 'blockmaps').map((name) => safeFileName(name, 'blockmap file')),
    checksums: safeFileName(requiredString(value.files, 'checksums'), 'checksums file'),
    latest: safeFileName(requiredString(value.files, 'latest'), 'latest metadata file'),
  };
  if (!files.canonicalDmg.endsWith('.dmg') || files.canonicalDmg === files.dmg) {
    throw new Error('Desktop release canonical DMG must be a distinct DMG file name.');
  }
  const objects = {
    dmg: safeObjectKey(requiredString(value.objects, 'dmg'), 'DMG key'),
    canonicalDmg: safeObjectKey(requiredString(value.objects, 'canonicalDmg'), 'canonical DMG key'),
    zip: safeObjectKey(requiredString(value.objects, 'zip'), 'ZIP key'),
    blockmaps: stringArray(value.objects, 'blockmaps').map((key) => safeObjectKey(key, 'blockmap key')),
    checksums: safeObjectKey(requiredString(value.objects, 'checksums'), 'checksums key'),
    latest: safeObjectKey(requiredString(value.objects, 'latest'), 'latest metadata key'),
  };
  const expectedObjects = {
    dmg: `${prefix}/${files.dmg}`,
    canonicalDmg: `${prefix}/${files.canonicalDmg}`,
    zip: `${prefix}/${files.zip}`,
    blockmaps: files.blockmaps.map((name) => `${prefix}/${name}`),
    checksums: `${prefix}/${version}/${files.checksums}`,
    latest: `${prefix}/${files.latest}`,
  };
  if (JSON.stringify(objects) !== JSON.stringify(expectedObjects)) {
    throw new Error('Desktop release object keys do not match the configured prefix and files.');
  }
  const sha256 = isRecord(value.sha256)
    ? Object.fromEntries(Object.entries(value.sha256).filter((entry): entry is [string, string] => (
      typeof entry[1] === 'string' && /^[a-f0-9]{64}$/u.test(entry[1])
    )))
    : {};
  if (value.published && (
    !sha256[files.dmg]
    || !sha256[files.canonicalDmg]
    || sha256[files.dmg] !== sha256[files.canonicalDmg]
  )) {
    throw new Error('A published desktop release requires matching verified DMG SHA-256 digests.');
  }
  if (value.published && (
    typeof value.publishedAt !== 'string'
    || !Number.isFinite(Date.parse(value.publishedAt))
  )) {
    throw new Error('A published desktop release requires a valid publication timestamp.');
  }
  return {
    published: value.published,
    version,
    platform: requiredString(value, 'platform'),
    architecture: requiredString(value, 'architecture'),
    downloadBaseUrl: downloadBaseUrl.toString().replace(/\/$/u, ''),
    bucket: requiredString(value, 'bucket'),
    prefix,
    files,
    objects,
    sha256,
    ...(typeof value.publishedAt === 'string' || value.publishedAt === null
      ? { publishedAt: value.publishedAt }
      : {}),
  };
}

export function desktopDmgUrl(
  config: DesktopReleaseConfig,
  publication?: DesktopReleasePublication,
): string | null {
  if (!config.published && publication?.published !== true) return null;
  return new URL(config.objects.canonicalDmg, `${config.downloadBaseUrl}/`).toString();
}

export async function discoverDesktopRelease(
  config: DesktopReleaseConfig,
  fetchRelease: typeof fetch = globalThis.fetch,
): Promise<DesktopReleasePublication> {
  if (config.published) {
    return {
      published: true,
      version: config.version,
      ...(config.publishedAt ? { publishedAt: config.publishedAt } : {}),
    };
  }
  const manifestUrl = new URL(config.objects.latest, `${config.downloadBaseUrl}/`);
  const canonicalObjectUrl = new URL(config.objects.canonicalDmg, `${config.downloadBaseUrl}/`);
  const manifestResponse = await fetchRelease(manifestUrl, {
    headers: { 'cache-control': 'no-cache' },
    redirect: 'error',
  });
  if (manifestResponse.status === 404) {
    const canonicalResponse = await fetchRelease(canonicalObjectUrl, {
      method: 'HEAD',
      headers: { 'cache-control': 'no-cache' },
      redirect: 'error',
    });
    if (canonicalResponse.status === 404) return { published: false, version: config.version };
    throw new Error('Desktop release manifest is missing while a canonical installer exists.');
  }
  if (!manifestResponse.ok) {
    throw new Error(`Desktop release discovery failed with HTTP ${manifestResponse.status}.`);
  }
  const declaredLength = Number(manifestResponse.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > 65_536) {
    throw new Error('Desktop release manifest is unexpectedly large.');
  }
  const manifest = await manifestResponse.text();
  if (new TextEncoder().encode(manifest).byteLength > 65_536) {
    throw new Error('Desktop release manifest is unexpectedly large.');
  }
  const version = /^version:\s*["']?([^"'\s]+)["']?\s*$/mu.exec(manifest)?.[1];
  const updateFile = /^\s*-\s+url:\s*["']?([^"'\s]+)["']?\s*$/mu.exec(manifest)?.[1];
  if (
    !version
    || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(version)
    || !updateFile
    || updateFile.includes('/')
    || !updateFile.endsWith('.zip')
    || !updateFile.includes(version)
  ) {
    throw new Error('Desktop release manifest is invalid.');
  }

  const canonicalUrl = new URL(canonicalObjectUrl);
  canonicalUrl.searchParams.set('rally-site-release', version);
  const head = await fetchRelease(canonicalUrl, {
    method: 'HEAD',
    headers: { 'cache-control': 'no-cache' },
    redirect: 'error',
  });
  const size = Number(head.headers.get('content-length'));
  if (!head.ok || !Number.isSafeInteger(size) || size <= 0) {
    throw new Error('Canonical desktop installer is unavailable or empty.');
  }
  const range = await fetchRelease(canonicalUrl, {
    headers: {
      'cache-control': 'no-cache',
      range: 'bytes=0-0',
    },
    redirect: 'error',
  });
  if (range.status !== 206 || range.headers.get('content-range') !== `bytes 0-0/${size}`) {
    await range.body?.cancel();
    throw new Error('Canonical desktop installer does not support the verified release range.');
  }
  if ((await range.arrayBuffer()).byteLength !== 1) {
    throw new Error('Canonical desktop installer returned an invalid verification range.');
  }
  const lastModified = head.headers.get('last-modified');
  return {
    published: true,
    version,
    ...(lastModified && Number.isFinite(Date.parse(lastModified))
      ? { publishedAt: new Date(lastModified).toISOString() }
      : {}),
  };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

export function renderDesktopRelease(
  html: string,
  value: unknown,
  publication?: DesktopReleasePublication,
): string {
  const config = parseDesktopReleaseConfig(value);
  const start = html.indexOf(releaseStartMarker);
  const end = html.indexOf(releaseEndMarker);
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('Desktop release markers are missing or malformed.');
  }
  const href = desktopDmgUrl(config, publication);
  const version = publication?.published === true ? publication.version : config.version;
  const markup = href
    ? `${releaseStartMarker}\n            <a class="rally-button rally-button-dark button-primary" href="${escapeHtml(href)}"><img src="/brand/apple-logo.svg" width="14" height="17" alt="" /> Download Rally for macOS <span>↘</span></a>\n            <small class="release-note">${escapeHtml(config.platform)} · ${escapeHtml(config.architecture)} · ${escapeHtml(version)}</small>\n            ${releaseEndMarker}`
    : `${releaseStartMarker}\n            <span class="rally-button rally-button-dark button-disabled" aria-disabled="true"><img src="/brand/apple-logo.svg" width="14" height="17" alt="" /> Downloads opening soon</span>\n            <small class="release-note">${escapeHtml(config.platform)} · ${escapeHtml(config.architecture)} · Private preview</small>\n            ${releaseEndMarker}`;
  return `${html.slice(0, start)}${markup}${html.slice(end + releaseEndMarker.length)}`;
}
