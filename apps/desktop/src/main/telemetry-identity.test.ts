import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readTelemetryIdentity, readTelemetryIdentityState, rotateTelemetryEpochs, uuidV7 } from './telemetry-identity';

const roots: string[] = [];

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'rally-telemetry-identity-'));
  roots.push(value);
  return value;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('desktop telemetry identity', () => {
  it('creates stable random UUIDv7 installation and epoch identifiers without platform identity', async () => {
    const directory = await root();
    const first = await readTelemetryIdentity(directory, new Date('2026-08-12T00:00:00.000Z'));
    const second = await readTelemetryIdentity(directory, new Date('2026-08-13T00:00:00.000Z'));
    expect(second).toEqual(first);
    expect(first.installationId[14]).toBe('7');
    expect(first.anonymousEpochId[14]).toBe('7');
    expect(first.accountEpochId[14]).toBe('7');
    const encoded = await readFile(join(directory, 'telemetry', 'identity.json'), 'utf8');
    expect(encoded).not.toMatch(/email|userId|workspaceId|token/iu);
  });

  it('reports whether the installation identity was created by this read', async () => {
    const directory = await root();
    const first = await readTelemetryIdentityState(directory, new Date('2026-08-12T00:00:00.000Z'));
    const second = await readTelemetryIdentityState(directory, new Date('2026-08-13T00:00:00.000Z'));

    expect(first.created).toBe(true);
    expect(second).toEqual({ identity: first.identity, created: false });
  });

  it('rotates anonymous and account epochs without changing installation identity', async () => {
    const directory = await root();
    const first = await readTelemetryIdentity(directory, new Date('2026-08-12T00:00:00.000Z'));
    const rotated = await rotateTelemetryEpochs(directory, new Date('2026-08-12T00:01:00.000Z'));
    expect(rotated.installationId).toBe(first.installationId);
    expect(rotated.anonymousEpochId).not.toBe(first.anonymousEpochId);
    expect(rotated.accountEpochId).not.toBe(first.accountEpochId);
  });

  it('replaces a corrupt identity document atomically', async () => {
    const directory = await root();
    const path = join(directory, 'telemetry', 'identity.json');
    await readTelemetryIdentity(directory, new Date('2026-08-12T00:00:00.000Z'));
    await writeFile(path, '{bad', 'utf8');
    await expect(readTelemetryIdentity(directory, new Date('2026-08-12T00:01:00.000Z')))
      .resolves.toMatchObject({ version: 1 });
  });

  it('encodes the requested millisecond timestamp in UUIDv7 ordering', () => {
    const earlier = uuidV7(new Date('2026-08-12T00:00:00.000Z'));
    const later = uuidV7(new Date('2026-08-12T00:00:00.001Z'));
    expect(earlier < later).toBe(true);
  });
});
