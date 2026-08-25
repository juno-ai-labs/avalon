import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  acknowledgeApplicationVersionTransition,
  applicationVersionTransition,
} from './application-version-telemetry';

const roots: string[] = [];

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'rally-application-version-'));
  roots.push(value);
  return value;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('application version telemetry', () => {
  it('retains one stable installation event until its durable enqueue is acknowledged', async () => {
    const newInstall = await root();
    const eventId = '018f0000-0000-7000-8000-000000000010';
    const input = {
      userDataDirectory: newInstall,
      version: '1.101.0',
      build: '10100',
      newInstallation: true,
      eventId: () => eventId,
    };
    await expect(applicationVersionTransition(input)).resolves.toEqual({
      eventId,
      transition: { state: 'installed' },
    });
    await expect(applicationVersionTransition({
      ...input,
      newInstallation: false,
    })).resolves.toEqual({ eventId, transition: { state: 'installed' } });
    await acknowledgeApplicationVersionTransition({ userDataDirectory: newInstall, eventId });
    await expect(applicationVersionTransition({ ...input, newInstallation: false })).resolves.toBeNull();

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

    const eventId = '018f0000-0000-7000-8000-000000000011';
    const update = {
      userDataDirectory: directory,
      version: '1.102.0',
      build: '10200',
      newInstallation: false,
      eventId: () => eventId,
    };
    await expect(applicationVersionTransition(update)).resolves.toEqual({
      eventId,
      transition: {
        state: 'updated',
        previousVersion: '1.101.0',
        previousBuild: '10100',
      },
    });
    await expect(applicationVersionTransition(update)).resolves.toEqual({
      eventId,
      transition: {
        state: 'updated',
        previousVersion: '1.101.0',
        previousBuild: '10100',
      },
    });
    await acknowledgeApplicationVersionTransition({ userDataDirectory: directory, eventId });
    await expect(applicationVersionTransition(update)).resolves.toBeNull();
  });

  it('baselines a corrupt existing marker instead of reporting a false installation', async () => {
    const directory = await root();
    await mkdir(join(directory, 'telemetry'));
    await writeFile(join(directory, 'telemetry', 'application-version.json'), '{not-json', 'utf8');
    const input = {
      userDataDirectory: directory,
      version: '1.102.0',
      build: '10200',
      newInstallation: true,
      eventId: () => '018f0000-0000-7000-8000-000000000012',
    };

    await expect(applicationVersionTransition(input)).resolves.toBeNull();
    await expect(applicationVersionTransition(input)).resolves.toBeNull();
  });
});
