import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { STRICT_UUID_PATTERN } from '@rally/contracts/uuid-validation';
import { z } from 'zod/v3';
import { uuidV7 } from './telemetry-identity';

const VersionValue = z.string().min(1).max(64).regex(/^[a-zA-Z0-9._+-]+$/u);
const EventId = z.string().regex(STRICT_UUID_PATTERN, 'Invalid UUID').refine((value) => value[14] === '7', 'must be UUIDv7');
const ApplicationVersionTransitionSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('installed') }).strict(),
  z.object({
    state: z.literal('updated'),
    previousVersion: VersionValue,
    previousBuild: VersionValue,
  }).strict(),
]);
const StoredApplicationVersionSchema = z.object({
  version: z.literal(1),
  appVersion: VersionValue,
  appBuild: VersionValue,
  pending: z.object({
    eventId: EventId,
    transition: ApplicationVersionTransitionSchema,
  }).strict().nullable().default(null),
}).strict();

export type ApplicationVersionTransition = z.infer<typeof ApplicationVersionTransitionSchema>;
export interface PendingApplicationVersionTransition {
  eventId: string;
  transition: ApplicationVersionTransition;
}

export async function applicationVersionTransition(input: {
  userDataDirectory: string;
  version: string;
  build: string;
  newInstallation: boolean;
  eventId?: () => string;
}): Promise<PendingApplicationVersionTransition | null> {
  const current = {
    version: 1 as const,
    appVersion: VersionValue.parse(input.version),
    appBuild: VersionValue.parse(input.build),
    pending: null,
  };
  const path = join(input.userDataDirectory, 'telemetry', 'application-version.json');
  const stored = await readVersion(path);
  const previous = stored.kind === 'valid' ? stored.value : null;
  if (previous?.pending) return previous.pending;
  if (previous?.appVersion === current.appVersion && previous.appBuild === current.appBuild) return null;

  if (!previous && (!input.newInstallation || stored.kind !== 'missing')) {
    await writeVersion(path, current);
    return null;
  }
  const pending: PendingApplicationVersionTransition = {
    eventId: EventId.parse((input.eventId ?? uuidV7)()),
    transition: previous
      ? {
          state: 'updated',
          previousVersion: previous.appVersion,
          previousBuild: previous.appBuild,
        }
      : { state: 'installed' },
  };
  await writeVersion(path, { ...current, pending });
  return pending;
}

export async function acknowledgeApplicationVersionTransition(input: {
  userDataDirectory: string;
  eventId: string;
}): Promise<void> {
  const path = join(input.userDataDirectory, 'telemetry', 'application-version.json');
  const stored = await readVersion(path);
  if (stored.kind !== 'valid'
    || !stored.value.pending
    || stored.value.pending.eventId !== EventId.parse(input.eventId)) return;
  await writeVersion(path, { ...stored.value, pending: null });
}

type ReadVersionResult =
  | { kind: 'valid'; value: z.infer<typeof StoredApplicationVersionSchema> }
  | { kind: 'missing' }
  | { kind: 'invalid' };

async function readVersion(path: string): Promise<ReadVersionResult> {
  try {
    const parsed = StoredApplicationVersionSchema.safeParse(JSON.parse(await readFile(path, 'utf8')) as unknown);
    return parsed.success ? { kind: 'valid', value: parsed.data } : { kind: 'invalid' };
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return { kind: 'missing' };
    if (error instanceof SyntaxError) return { kind: 'invalid' };
    throw error;
  }
}

async function writeVersion(
  path: string,
  value: z.infer<typeof StoredApplicationVersionSchema>,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, path);
    const directory = await open(dirname(path), 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}
