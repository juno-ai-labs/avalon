import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  invalidateActiveNativeCrashGeneration,
  prepareNativeCrashGeneration,
} from './native-crash-generation';

const scratchDirectories: string[] = [];
const runtime = {
  release: '1.96.0', buildId: 'build-1', platform: 'darwin' as const, architecture: 'arm64' as const,
  launchId: '00000000-0000-7000-8000-000000000004', channel: 'stable' as const,
};
async function scratchDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'rally-native-crash-generation-'));
  scratchDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(scratchDirectories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })));
});

describe('native crash generation lifecycle', () => {
  it('creates a route-final active database with an externally readable absolute deadline', async () => {
    const rootDirectory = await scratchDirectory();
    const result = await prepareNativeCrashGeneration({
      rootDirectory,
      route: 'global',
      now: new Date('2026-08-12T12:00:00.000Z'),
      generationId: '00000000-0000-7000-8000-000000000001',
      runtime,
    });

    expect(result).toEqual({
      activeCrashpadDirectory: join(
        rootDirectory,
        'active',
        '00000000-0000-7000-8000-000000000001',
        'crashpad',
      ),
      activeGenerationId: '00000000-0000-7000-8000-000000000001',
      rotatedGenerationIds: [],
      purgedGenerationIds: [],
    });

    const manifestPath = join(dirname(result.activeCrashpadDirectory!), 'manifest.json');
    expect(JSON.parse(await readFile(manifestPath, 'utf8'))).toEqual({
      version: 1,
      generationId: '00000000-0000-7000-8000-000000000001',
      route: 'global',
      createdAt: '2026-08-12T12:00:00.000Z',
      deleteAfter: '2026-08-26T12:00:00.000Z',
      invalidatedAt: null,
      runtime,
    });

    await writeFile(join(result.activeCrashpadDirectory!, 'crashpad-owned'), 'opaque');
  });

  it('rotates the whole inactive database by its original route before creating the next generation', async () => {
    const rootDirectory = await scratchDirectory();
    const first = await prepareNativeCrashGeneration({
      rootDirectory,
      route: 'global',
      now: new Date('2026-08-12T12:00:00.000Z'),
      generationId: '00000000-0000-7000-8000-000000000001',
      runtime,
    });
    await writeFile(join(first.activeCrashpadDirectory!, 'opaque-crashpad-state'), 'untouched');

    const second = await prepareNativeCrashGeneration({
      rootDirectory,
      route: 'eu',
      now: new Date('2026-08-12T13:00:00.000Z'),
      generationId: '00000000-0000-7000-8000-000000000002',
      runtime,
    });

    expect(second.rotatedGenerationIds).toEqual(['00000000-0000-7000-8000-000000000001']);
    expect(second.activeGenerationId).toBe('00000000-0000-7000-8000-000000000002');
    await expect(readFile(join(
      rootDirectory,
      'upload',
      'global',
      '00000000-0000-7000-8000-000000000001',
      'crashpad',
      'opaque-crashpad-state',
    ), 'utf8')).resolves.toBe('untouched');
    await expect(access(join(
      rootDirectory,
      'active',
      '00000000-0000-7000-8000-000000000001',
    ))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('purges an invalidated active generation instead of rotating it', async () => {
    const rootDirectory = await scratchDirectory();
    const first = await prepareNativeCrashGeneration({
      rootDirectory,
      route: 'global',
      now: new Date('2026-08-12T12:00:00.000Z'),
      generationId: '00000000-0000-7000-8000-000000000001',
      runtime,
    });
    await writeFile(join(first.activeCrashpadDirectory!, 'completed-dump'), 'opaque');
    await invalidateActiveNativeCrashGeneration({
      rootDirectory,
      invalidatedAt: new Date('2026-08-12T12:30:00.000Z'),
    });

    const next = await prepareNativeCrashGeneration({
      rootDirectory,
      route: null,
      now: new Date('2026-08-12T13:00:00.000Z'),
      generationId: '00000000-0000-7000-8000-000000000002',
      runtime,
    });

    expect(next).toEqual({
      activeCrashpadDirectory: null,
      activeGenerationId: null,
      rotatedGenerationIds: [],
      purgedGenerationIds: ['00000000-0000-7000-8000-000000000001'],
    });
    await expect(access(join(
      rootDirectory,
      'upload',
      'global',
      '00000000-0000-7000-8000-000000000001',
    ))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('physically purges expired and corrupt generations before rotation or restart', async () => {
    const rootDirectory = await scratchDirectory();
    await prepareNativeCrashGeneration({
      rootDirectory,
      route: 'global',
      now: new Date('2026-08-01T00:00:00.000Z'),
      generationId: '00000000-0000-7000-8000-000000000001',
      runtime,
    });
    const corruptId = '00000000-0000-7000-8000-000000000003';
    await mkdir(join(rootDirectory, 'active', corruptId, 'crashpad'), { recursive: true });
    await writeFile(join(rootDirectory, 'active', corruptId, 'manifest.json'), '{"version":1}\n');

    const next = await prepareNativeCrashGeneration({
      rootDirectory,
      route: 'global',
      now: new Date('2026-08-16T00:00:00.001Z'),
      generationId: '00000000-0000-7000-8000-000000000002',
      runtime,
    });

    expect(next.rotatedGenerationIds).toEqual([]);
    expect(next.purgedGenerationIds).toEqual([
      '00000000-0000-7000-8000-000000000001',
      corruptId,
    ]);
  });
});
