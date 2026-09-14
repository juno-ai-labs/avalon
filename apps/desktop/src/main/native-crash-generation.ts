import { isConfiguredRegion } from "@rally/contracts/regions";
import type { Region } from "@rally/contracts/regions";
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export type NativeCrashRoute = Region;

const LOCAL_CRASH_RETENTION_MS = 14 * 24 * 60 * 60 * 1_000;
const GENERATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export interface PrepareNativeCrashGenerationInput {
  rootDirectory: string;
  route: NativeCrashRoute | null;
  now: Date;
  generationId: string;
  runtime: NativeCrashCaptureRuntime;
}

export interface NativeCrashCaptureRuntime {
  release: string;
  buildId: string;
  platform: 'darwin' | 'win32' | 'linux';
  architecture: 'arm64' | 'x64';
  launchId: string;
  channel: 'development' | 'alpha' | 'beta' | 'stable';
}

export interface PreparedNativeCrashGeneration {
  activeCrashpadDirectory: string | null;
  activeGenerationId: string | null;
  rotatedGenerationIds: string[];
  purgedGenerationIds: string[];
}

interface NativeCrashGenerationManifest {
  version: 1;
  generationId: string;
  route: NativeCrashRoute;
  createdAt: string;
  deleteAfter: string;
  invalidatedAt: string | null;
  runtime: NativeCrashCaptureRuntime;
}

export interface InvalidateActiveNativeCrashGenerationInput {
  rootDirectory: string;
  invalidatedAt: Date;
}

export async function prepareNativeCrashGeneration(
  input: PrepareNativeCrashGenerationInput,
): Promise<PreparedNativeCrashGeneration> {
  if (!GENERATION_ID_PATTERN.test(input.generationId)) {
    throw new Error('Invalid native crash generation ID');
  }
  if (!Number.isFinite(input.now.getTime())) {
    throw new Error('Invalid native crash generation time');
  }
  const rotatedGenerationIds: string[] = [];
  const purgedGenerationIds = await purgeExpiredUploadGenerations(input.rootDirectory, input.now);
  const inactive = await classifyInactiveGenerations(input.rootDirectory, input.now);
  for (const generation of inactive) {
    if (generation.action === 'purge') {
      await rm(generation.directory, { recursive: true, force: true });
      purgedGenerationIds.push(generation.generationId);
      continue;
    }
    const uploadDirectory = join(
      input.rootDirectory,
      'upload',
      generation.manifest.route,
      generation.generationId,
    );
    await mkdir(dirname(uploadDirectory), { recursive: true, mode: 0o700 });
    await rename(generation.directory, uploadDirectory);
    rotatedGenerationIds.push(generation.generationId);
  }

  if (input.route === null) {
    return {
      activeCrashpadDirectory: null,
      activeGenerationId: null,
      rotatedGenerationIds: rotatedGenerationIds.sort(),
      purgedGenerationIds: [...new Set(purgedGenerationIds)].sort(),
    };
  }

  const generationDirectory = join(input.rootDirectory, 'active', input.generationId);
  const crashpadDirectory = join(generationDirectory, 'crashpad');
  await mkdir(join(input.rootDirectory, 'active'), { recursive: true, mode: 0o700 });
  await mkdir(generationDirectory, { mode: 0o700 });
  try {
    await mkdir(crashpadDirectory, { mode: 0o700 });
    await writeManifestAtomically(join(generationDirectory, 'manifest.json'), {
      version: 1,
      generationId: input.generationId,
      route: input.route,
      createdAt: input.now.toISOString(),
      deleteAfter: new Date(input.now.getTime() + LOCAL_CRASH_RETENTION_MS).toISOString(),
      invalidatedAt: null,
      runtime: input.runtime,
    });
  } catch (error) {
    await rm(generationDirectory, { recursive: true, force: true });
    throw error;
  }

  return {
    activeCrashpadDirectory: crashpadDirectory,
    activeGenerationId: input.generationId,
    rotatedGenerationIds: rotatedGenerationIds.sort(),
    purgedGenerationIds: [...new Set(purgedGenerationIds)].sort(),
  };
}

export async function invalidateActiveNativeCrashGeneration(
  input: InvalidateActiveNativeCrashGenerationInput,
): Promise<string[]> {
  if (!Number.isFinite(input.invalidatedAt.getTime())) {
    throw new Error('Invalid native crash invalidation time');
  }
  const invalidated: string[] = [];
  for (const generationId of await listDirectories(join(input.rootDirectory, 'active'))) {
    const manifestPath = join(input.rootDirectory, 'active', generationId, 'manifest.json');
    const manifest = await readManifest(manifestPath, generationId);
    if (!manifest || manifest.invalidatedAt !== null) continue;
    await writeManifestAtomically(manifestPath, {
      ...manifest,
      invalidatedAt: input.invalidatedAt.toISOString(),
    });
    invalidated.push(generationId);
  }
  return invalidated.sort();
}

type InactiveGeneration = {
  action: 'purge';
  directory: string;
  generationId: string;
} | {
  action: 'rotate';
  directory: string;
  generationId: string;
  manifest: NativeCrashGenerationManifest;
};

async function classifyInactiveGenerations(
  rootDirectory: string,
  now: Date,
): Promise<InactiveGeneration[]> {
  const activeDirectory = join(rootDirectory, 'active');
  const generations: InactiveGeneration[] = [];
  for (const generationId of await listDirectories(activeDirectory)) {
    const directory = join(activeDirectory, generationId);
    const manifest = await readManifest(join(directory, 'manifest.json'), generationId);
    if (!manifest || manifest.invalidatedAt !== null || Date.parse(manifest.deleteAfter) <= now.getTime()) {
      generations.push({ action: 'purge', directory, generationId });
    } else {
      generations.push({ action: 'rotate', directory, generationId, manifest });
    }
  }
  return generations;
}

async function purgeExpiredUploadGenerations(rootDirectory: string, now: Date): Promise<string[]> {
  const purged: string[] = [];
  for (const route of await listDirectories(join(rootDirectory, 'upload'))) {
    const routeDirectory = join(rootDirectory, 'upload', route);
    for (const generationId of await listDirectories(routeDirectory)) {
      const directory = join(routeDirectory, generationId);
      const manifest = await readManifest(join(directory, 'manifest.json'), generationId);
      if (manifest && manifest.route === route && manifest.invalidatedAt === null
        && Date.parse(manifest.deleteAfter) > now.getTime()) continue;
      await rm(directory, { recursive: true, force: true });
      purged.push(generationId);
    }
  }
  return purged;
}

async function listDirectories(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }
}

async function readManifest(
  path: string,
  expectedGenerationId: string,
): Promise<NativeCrashGenerationManifest | null> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const candidate = value as Record<string, unknown>;
    if (candidate.version !== 1
      || candidate.generationId !== expectedGenerationId
      || !GENERATION_ID_PATTERN.test(expectedGenerationId)
      || !isConfiguredRegion(candidate.route)
      || !isIsoInstant(candidate.createdAt)
      || !isIsoInstant(candidate.deleteAfter)
      || (candidate.invalidatedAt !== null && !isIsoInstant(candidate.invalidatedAt))
      || !isCaptureRuntime(candidate.runtime)) return null;
    if (Date.parse(candidate.deleteAfter) <= Date.parse(candidate.createdAt)) return null;
    return {
      version: 1,
      generationId: expectedGenerationId,
      route: candidate.route,
      createdAt: candidate.createdAt,
      deleteAfter: candidate.deleteAfter,
      invalidatedAt: candidate.invalidatedAt,
      runtime: candidate.runtime,
    };
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
}

function isCaptureRuntime(value: unknown): value is NativeCrashCaptureRuntime {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.release === 'string' && candidate.release.length > 0
    && typeof candidate.buildId === 'string' && candidate.buildId.length > 0
    && (candidate.platform === 'darwin' || candidate.platform === 'win32' || candidate.platform === 'linux')
    && (candidate.architecture === 'arm64' || candidate.architecture === 'x64')
    && typeof candidate.launchId === 'string' && GENERATION_ID_PATTERN.test(candidate.launchId)
    && (candidate.channel === 'development' || candidate.channel === 'alpha'
      || candidate.channel === 'beta' || candidate.channel === 'stable');
}

function isIsoInstant(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

async function writeManifestAtomically(path: string, value: unknown): Promise<void> {
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  let temporaryHandle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    temporaryHandle = await open(temporaryPath, 'wx', 0o600);
    await temporaryHandle.writeFile(`${JSON.stringify(value)}\n`, 'utf8');
    await temporaryHandle.sync();
    await temporaryHandle.close();
    temporaryHandle = undefined;
    await rename(temporaryPath, path);
    await syncDirectory(dirname(path));
  } finally {
    await temporaryHandle?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

async function syncDirectory(path: string): Promise<void> {
  let directoryHandle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    directoryHandle = await open(path, 'r');
    await directoryHandle.sync();
  } catch (error) {
    // Some supported filesystems reject fsync on directory descriptors. The
    // file itself was synced before rename; surface every other failure.
    if (!(error instanceof Error && 'code' in error && (error.code === 'EINVAL' || error.code === 'ENOTSUP'))) {
      throw error;
    }
  } finally {
    await directoryHandle?.close().catch(() => undefined);
  }
}
