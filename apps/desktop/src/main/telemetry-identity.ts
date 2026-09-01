import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod/v3';

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const IdentitySchema = z.object({
  version: z.literal(1),
  installationId: z.string().regex(UUID_V7),
  anonymousEpochId: z.string().regex(UUID_V7),
  accountEpochId: z.string().regex(UUID_V7),
}).strict();

export type TelemetryIdentity = z.infer<typeof IdentitySchema>;
export interface TelemetryIdentityState {
  identity: TelemetryIdentity;
  created: boolean;
}

export function uuidV7(now = new Date()): string {
  const milliseconds = now.getTime();
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0 || milliseconds > 0xffffffffffff) {
    throw new Error('Invalid UUIDv7 timestamp');
  }
  const bytes = randomBytes(16);
  let remaining = milliseconds;
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = remaining % 256;
    remaining = Math.floor(remaining / 256);
  }
  bytes[6] = 0x70 | (bytes[6]! & 0x0f);
  bytes[8] = 0x80 | (bytes[8]! & 0x3f);
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function readTelemetryIdentity(userDataDirectory: string, now = new Date()): Promise<TelemetryIdentity> {
  return (await readTelemetryIdentityState(userDataDirectory, now)).identity;
}

export async function readTelemetryIdentityState(
  userDataDirectory: string,
  now = new Date(),
): Promise<TelemetryIdentityState> {
  const path = identityPath(userDataDirectory);
  let missing = false;
  try {
    const parsed = IdentitySchema.safeParse(JSON.parse(await readFile(path, 'utf8')) as unknown);
    if (parsed.success) return { identity: parsed.data, created: false };
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') missing = true;
    else if (!(error instanceof SyntaxError)) throw error;
  }
  const identity: TelemetryIdentity = {
    version: 1,
    installationId: uuidV7(now),
    anonymousEpochId: uuidV7(now),
    accountEpochId: uuidV7(now),
  };
  await writeIdentity(path, identity);
  return { identity, created: missing };
}

export async function rotateTelemetryEpochs(userDataDirectory: string, now = new Date()): Promise<TelemetryIdentity> {
  const current = await readTelemetryIdentity(userDataDirectory, now);
  const next: TelemetryIdentity = {
    ...current,
    anonymousEpochId: uuidV7(now),
    accountEpochId: uuidV7(now),
  };
  await writeIdentity(identityPath(userDataDirectory), next);
  return next;
}

function identityPath(userDataDirectory: string): string {
  return join(userDataDirectory, 'telemetry', 'identity.json');
}

async function writeIdentity(path: string, identity: TelemetryIdentity): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(identity)}\n`, 'utf8');
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
