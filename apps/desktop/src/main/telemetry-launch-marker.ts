import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod/v3';

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const MarkerSchema = z.object({
  version: z.literal(1),
  launchId: z.string().regex(UUID_V7),
  phase: z.enum(['starting', 'ready']),
  changedAt: z.string().datetime({ offset: true }),
}).strict();

type Marker = z.infer<typeof MarkerSchema>;

export interface BeginTelemetryLaunchResult {
  priorUncleanExit: 'launch_failure' | 'unknown' | null;
}

export async function beginTelemetryLaunch(
  userDataDirectory: string,
  launchId: string,
  now: Date,
): Promise<BeginTelemetryLaunchResult> {
  const prior = await readMarker(userDataDirectory);
  await writeMarker(userDataDirectory, {
    version: 1,
    launchId,
    phase: 'starting',
    changedAt: now.toISOString(),
  });
  return {
    priorUncleanExit: prior ? prior.phase === 'starting' ? 'launch_failure' : 'unknown' : null,
  };
}

export async function markTelemetryLaunchReady(
  userDataDirectory: string,
  launchId: string,
  now: Date,
): Promise<void> {
  const current = await readMarker(userDataDirectory);
  if (!current || current.launchId !== launchId) return;
  await writeMarker(userDataDirectory, { ...current, phase: 'ready', changedAt: now.toISOString() });
}

export function clearTelemetryLaunch(userDataDirectory: string): void {
  rmSync(markerPath(userDataDirectory), { force: true });
}

function markerPath(userDataDirectory: string): string {
  return join(userDataDirectory, 'telemetry', 'launch-marker.json');
}

async function readMarker(userDataDirectory: string): Promise<Marker | null> {
  try {
    const parsed = MarkerSchema.safeParse(JSON.parse(await readFile(markerPath(userDataDirectory), 'utf8')) as unknown);
    return parsed.success ? parsed.data : null;
  } catch (error) {
    if (error instanceof SyntaxError
      || (error instanceof Error && 'code' in error && error.code === 'ENOENT')) return null;
    throw error;
  }
}

async function writeMarker(userDataDirectory: string, marker: Marker): Promise<void> {
  const path = markerPath(userDataDirectory);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(MarkerSchema.parse(marker))}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, path);
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}
