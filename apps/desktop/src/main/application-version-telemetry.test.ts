import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applicationVersionTransition } from './application-version-telemetry';

const roots: string[] = [];

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'avalon-application-version-'));
  roots.push(value);
  return value;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('application version telemetry', () => {
  it('reports installation only when the telemetry identity was also newly created', async () => {
    const newInstall = await root();
    await expect(applicationVersionTransition({
      userDataDirectory: newInstall,
      version: '1.101.0',
      build: '10100',
      newInstallation: true,
    })).resolves.toEqual({ state: 'installed' });
    await expect(applicationVersionTransition({
      userDataDirectory: newInstall,
      version: '1.101.0',
      build: '10100',
      newInstallation: false,
    })).resolves.toBeNull();

    const migratedInstall = await root();
    await expect(applicationVersionTransition({
      userDataDirectory: migratedInstall,
      version: '1.101.0',
      build: '10100',
      newInstallation: false,
    })).resolves.toBeNull();
  });

  it('reports one update with the previous version and build', async () => {
    const directory = await root();
    await applicationVersionTransition({
      userDataDirectory: directory,
      version: '1.101.0',
      build: '10100',
      newInstallation: false,
    });

    await expect(applicationVersionTransition({
      userDataDirectory: directory,
      version: '1.102.0',
      build: '10200',
      newInstallation: false,
    })).resolves.toEqual({
      state: 'updated',
      previousVersion: '1.101.0',
      previousBuild: '10100',
    });
    await expect(applicationVersionTransition({
      userDataDirectory: directory,
      version: '1.102.0',
      build: '10200',
      newInstallation: false,
    })).resolves.toBeNull();
  });
});
