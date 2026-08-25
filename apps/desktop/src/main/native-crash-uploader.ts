import { RALLY_HEADERS } from '@rally/contracts/http-headers';
import { readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { TelemetryBreadcrumbSidecarSchema } from '@rally/contracts';
import { uuidV7 } from './telemetry-identity';

const ManifestSchema = z.object({
  version: z.literal(1),
  generationId: z.string(),
  route: z.enum(['global', 'eu']),
  createdAt: z.string().datetime({ offset: true }),
  deleteAfter: z.string().datetime({ offset: true }),
  invalidatedAt: z.string().datetime({ offset: true }).nullable(),
  runtime: z.object({
    release: z.string().min(1).max(64),
    buildId: z.string().min(1).max(64),
    platform: z.enum(['darwin', 'win32', 'linux']),
    architecture: z.enum(['arm64', 'x64']),
    launchId: z.string().uuid().refine((value) => value[14] === '7'),
    channel: z.enum(['development', 'alpha', 'beta', 'stable']),
  }).strict(),
}).strict();
const UploadSidecarSchema = z.object({
  version: z.literal(1),
  uploadId: z.string().uuid().refine((value) => value[14] === '7'),
}).strict();

export interface NativeCrashUploaderOptions {
  rootDirectory: string;
  enabled: () => boolean;
  identity: () => { installationId: string };
  authenticatedSession: () => Promise<{
    apiBaseUrl: string;
    accessToken: string;
    route: 'global' | 'eu';
  } | null>;
  anonymousSession: () => { capability: string; route: 'global' | 'eu'; expiresAt: string } | null;
  refreshAnonymousSession?: () => Promise<{
    capability: string;
    route: 'global' | 'eu';
    expiresAt: string;
  } | null>;
  globalApiBaseUrl: string;
  fetch: typeof globalThis.fetch;
  eventId?: () => string;
  onState?: (state: NativeCrashUploadState) => void | Promise<void>;
  maxReports?: number;
  maxBytes?: number;
}

export type NativeCrashUploadState =
  | 'queued'
  | 'uploading'
  | 'accepted'
  | 'rejected'
  | 'retrying'
  | 'expired'
  | 'invalidated'
  | 'evicted'
  | 'corrupt'
  | 'lost';

export class NativeCrashUploader {
  private flushing: Promise<void> | null = null;
  private readonly maxReports: number;
  private readonly maxBytes: number;

  constructor(private readonly options: NativeCrashUploaderOptions) {
    this.maxReports = options.maxReports ?? 20;
    this.maxBytes = options.maxBytes ?? 100 * 1024 * 1024;
    if (!Number.isSafeInteger(this.maxReports) || this.maxReports <= 0) {
      throw new Error('Invalid native crash report limit');
    }
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes <= 0) {
      throw new Error('Invalid native crash byte limit');
    }
  }

  flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    this.flushing = this.flushUnlocked().finally(() => { this.flushing = null; });
    return this.flushing;
  }

  async purgeInactive(): Promise<void> {
    await rm(join(this.options.rootDirectory, 'upload'), { recursive: true, force: true });
  }

  private async flushUnlocked(): Promise<void> {
    await this.enforceBounds();
    if (!this.options.enabled()) return;
    let remaining = 5;
    for (const route of ['global', 'eu'] as const) {
      const routeDirectory = join(this.options.rootDirectory, 'upload', route);
      for (const generationId of await directories(routeDirectory)) {
        if (remaining <= 0) return;
        const generationDirectory = join(routeDirectory, generationId);
        const manifest = await parseManifest(join(generationDirectory, 'manifest.json'));
        if (!manifest || manifest.route !== route) {
          this.state('corrupt');
          await rm(generationDirectory, { recursive: true, force: true });
          continue;
        }
        if (manifest.invalidatedAt) {
          this.state('invalidated');
          await rm(generationDirectory, { recursive: true, force: true });
          continue;
        }
        if (Date.parse(manifest.deleteAfter) <= Date.now()) {
          this.state('expired');
          await rm(generationDirectory, { recursive: true, force: true });
          continue;
        }
        const dumps = (await filesBelow(join(generationDirectory, 'crashpad')))
          .filter((path) => path.endsWith('.dmp'))
          .slice(0, remaining);
        for (const dump of dumps) {
          remaining -= 1;
          await this.upload(dump, manifest, generationDirectory);
        }
        if ((await filesBelow(join(generationDirectory, 'crashpad'))).every((path) => !path.endsWith('.dmp'))) {
          await rm(generationDirectory, { recursive: true, force: true });
        }
      }
    }
  }

  private async enforceBounds(): Promise<void> {
    const reports: Array<{ path: string; bytes: number; modifiedAt: number }> = [];
    for (const route of ['global', 'eu'] as const) {
      for (const path of (await filesBelow(join(this.options.rootDirectory, 'upload', route)))
        .filter((candidate) => candidate.endsWith('.dmp'))) {
        try {
          const details = await stat(path);
          if (details.isFile()) reports.push({ path, bytes: details.size, modifiedAt: details.mtimeMs });
        } catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
        }
      }
    }
    reports.sort((left, right) => left.modifiedAt - right.modifiedAt || left.path.localeCompare(right.path));
    let totalBytes = reports.reduce((total, report) => total + report.bytes, 0);
    while (reports.length > this.maxReports || totalBytes > this.maxBytes) {
      const victim = reports.shift();
      if (!victim) return;
      await this.removeDump(victim.path);
      totalBytes -= victim.bytes;
      this.state('evicted');
    }
  }

  private async upload(
    path: string,
    manifest: z.infer<typeof ManifestSchema>,
    generationDirectory: string,
  ): Promise<void> {
    const route = manifest.route;
    let bytes: Uint8Array;
    try {
      const details = await stat(path);
      if (!details.isFile() || details.size <= 0 || details.size > 20 * 1024 * 1024) {
        this.state('evicted');
        await rm(path, { force: true });
        return;
      }
      bytes = new Uint8Array(await readFile(path));
    } catch {
      return;
    }
    this.state('queued');
    const uploadId = await this.uploadId(path);
    const authenticated = await this.options.authenticatedSession().catch(() => null);
    let anonymous = authenticated ? null : this.options.anonymousSession();
    if (!authenticated && (!anonymous || Date.parse(anonymous.expiresAt) <= Date.now())) {
      anonymous = await this.options.refreshAnonymousSession?.().catch(() => null) ?? null;
    }
    if (authenticated?.route !== route && anonymous?.route !== route) return;
    if (route === 'eu' && !authenticated) return;
    const endpoint = authenticated
      ? `${authenticated.apiBaseUrl}/telemetry/crashes`
      : `${this.options.globalApiBaseUrl}/telemetry/crashes/anonymous`;
    const form = new FormData();
    form.set('metadata', JSON.stringify({
      uploadId,
      installationId: this.options.identity().installationId,
      route,
      ...manifest.runtime,
      // Crashpad report names are opaque GUIDs. The regional processor resolves
      // the trusted role from minidump annotations after parsing.
      processRole: 'unknown',
    }));
    const dumpBuffer = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    form.set('dump', new File([dumpBuffer], 'report.dmp', { type: 'application/octet-stream' }));
    const breadcrumbs = await readBreadcrumbSidecar(join(generationDirectory, 'breadcrumbs.json'));
    if (breadcrumbs) form.set('breadcrumbs', JSON.stringify(breadcrumbs));
    let response: Response;
    this.state('uploading');
    try {
      response = await this.options.fetch(endpoint, {
        method: 'POST',
        headers: authenticated
          ? { Authorization: `Bearer ${authenticated.accessToken}` }
          : { [RALLY_HEADERS.TELEMETRY_CAPABILITY]: anonymous!.capability },
        body: form,
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      this.state('retrying');
      return;
    }
    if (!response.ok) {
      if (!authenticated && response.status >= 400 && response.status < 500) {
        const refreshed = await this.options.refreshAnonymousSession?.().catch(() => null) ?? null;
        if (refreshed && refreshed.route === route && refreshed.capability !== anonymous?.capability) {
          this.state('retrying');
          return;
        }
      }
      if (response.status === 408 || response.status === 429 || response.status >= 500) {
        this.state('retrying');
      } else if (authenticated || response.status === 403) {
        this.state('rejected');
        await this.removeDump(path);
      } else {
        // A stale anonymous credential is recoverable. Retain the report until
        // the fixed-route journey can refresh or its local deadline expires.
        this.state('retrying');
      }
      return;
    }
    const result = await response.json().catch(() => null) as { result?: string; uploadId?: string } | null;
    if (result?.uploadId !== uploadId
      || !['accepted', 'duplicate', 'suppressed'].includes(result.result ?? '')) {
      this.state('retrying');
      return;
    }
    this.state(result.result === 'suppressed' ? 'rejected' : 'accepted');
    await this.removeDump(path);
  }

  private async uploadId(path: string): Promise<string> {
    const sidecarPath = `${path}.rally.json`;
    try {
      const parsed = UploadSidecarSchema.safeParse(JSON.parse(await readFile(sidecarPath, 'utf8')) as unknown);
      if (parsed.success) return parsed.data.uploadId;
    } catch (error) {
      if (!(error instanceof SyntaxError)
        && !(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    const uploadId = (this.options.eventId ?? uuidV7)();
    await writeFile(sidecarPath, `${JSON.stringify({ version: 1, uploadId })}\n`, {
      encoding: 'utf8', flag: 'wx', mode: 0o600,
    }).catch(async (error: unknown) => {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
    });
    const parsed = UploadSidecarSchema.parse(JSON.parse(await readFile(sidecarPath, 'utf8')) as unknown);
    return parsed.uploadId;
  }

  private async removeDump(path: string): Promise<void> {
    await Promise.all([rm(path, { force: true }), rm(`${path}.rally.json`, { force: true })]);
  }

  private state(state: NativeCrashUploadState): void {
    try {
      void Promise.resolve(this.options.onState?.(state)).catch(() => undefined);
    } catch {
      // Operational reporting cannot affect crash delivery control flow.
    }
  }
}

async function readBreadcrumbSidecar(path: string): Promise<z.infer<typeof TelemetryBreadcrumbSidecarSchema> | null> {
  try {
    const encoded = await readFile(path, 'utf8');
    if (encoded.length > 32 * 1024) return null;
    const parsed = TelemetryBreadcrumbSidecarSchema.safeParse(JSON.parse(encoded) as unknown);
    return parsed.success ? parsed.data : null;
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
}

async function parseManifest(path: string): Promise<z.infer<typeof ManifestSchema> | null> {
  try {
    const parsed = ManifestSchema.safeParse(JSON.parse(await readFile(path, 'utf8')) as unknown);
    return parsed.success ? parsed.data : null;
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
}

async function directories(path: string): Promise<string[]> {
  try {
    return (await readdir(path, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }
}

async function filesBelow(path: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const child = join(path, entry.name);
    if (entry.isDirectory()) files.push(...await filesBelow(child));
    else if (entry.isFile()) files.push(child);
  }
  return files.sort();
}
