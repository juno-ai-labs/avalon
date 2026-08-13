import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';

const VersionValue = z.string().min(1).max(64).regex(/^[a-zA-Z0-9._+-]+$/u);
const StoredApplicationVersionSchema = z.object({
  version: z.literal(1),
  appVersion: VersionValue,
  appBuild: VersionValue,
}).strict();

export type ApplicationVersionTransition =
  | { state: 'installed' }
  | { state: 'updated'; previousVersion: string; previousBuild: string };

export async function applicationVersionTransition(input: {
  userDataDirectory: string;
  version: string;
  build: string;
  newInstallation: boolean;
}): Promise<ApplicationVersionTransition | null> {
  const current = {
    version: 1 as const,
    appVersion: VersionValue.parse(input.version),
    appBuild: VersionValue.parse(input.build),
  };
  const path = join(input.userDataDirectory, 'telemetry', 'application-version.json');
  let previous: z.infer<typeof StoredApplicationVersionSchema> | null = null;
  try {
    const parsed = StoredApplicationVersionSchema.safeParse(JSON.parse(await readFile(path, 'utf8')) as unknown);
    if (parsed.success) previous = parsed.data;
  } catch (error) {
    if (!(error instanceof SyntaxError)
      && !(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  if (previous?.appVersion === current.appVersion && previous.appBuild === current.appBuild) return null;

  await writeVersion(path, current);
  if (!previous) return input.newInstallation ? { state: 'installed' } : null;
  return {
    state: 'updated',
    previousVersion: previous.appVersion,
    previousBuild: previous.appBuild,
  };
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
