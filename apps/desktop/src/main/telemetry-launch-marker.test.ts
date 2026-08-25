import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { beginTelemetryLaunch, clearTelemetryLaunch, markTelemetryLaunchReady } from './telemetry-launch-marker';

const roots: string[] = [];

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'rally-launch-marker-'));
  roots.push(path);
  return path;
}

describe('telemetry launch marker', () => {
  it('classifies a prior crash before ready as a launch failure', async () => {
    const directory = await root();
    await beginTelemetryLaunch(directory, '018f22f2-4c22-7abc-8def-0123456789ab', new Date('2026-08-12T20:00:00Z'));
    await expect(beginTelemetryLaunch(
      directory,
      '018f22f2-4c23-7abc-8def-0123456789ab',
      new Date('2026-08-12T20:01:00Z'),
    )).resolves.toEqual({ priorUncleanExit: 'launch_failure' });
  });

  it('classifies a prior crash after ready without retaining content', async () => {
    const directory = await root();
    const launchId = '018f22f2-4c22-7abc-8def-0123456789ab';
    await beginTelemetryLaunch(directory, launchId, new Date('2026-08-12T20:00:00Z'));
    await markTelemetryLaunchReady(directory, launchId, new Date('2026-08-12T20:00:05Z'));
    await expect(beginTelemetryLaunch(
      directory,
      '018f22f2-4c23-7abc-8def-0123456789ab',
      new Date('2026-08-12T20:01:00Z'),
    )).resolves.toEqual({ priorUncleanExit: 'unknown' });
    expect(await readFile(join(directory, 'telemetry', 'launch-marker.json'), 'utf8')).not.toContain('readyAt');
  });

  it('removes the marker on a graceful exit', async () => {
    const directory = await root();
    await beginTelemetryLaunch(directory, '018f22f2-4c22-7abc-8def-0123456789ab', new Date());
    clearTelemetryLaunch(directory);
    await expect(readFile(join(directory, 'telemetry', 'launch-marker.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
