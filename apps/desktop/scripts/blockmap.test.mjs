import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { gunzipSync } from 'node:zlib';

import { BLOCKMAP_BUILDER_VERSION, assertBlockmapMatches, writeBlockmap } from './blockmap.mjs';

test('blockmap generator is pinned to electron-builder 26.15.3', () => {
  assert.equal(BLOCKMAP_BUILDER_VERSION, '26.15.3');
});

test('generated differential blockmaps are verifiable against final artifact bytes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rally-blockmap-test-'));
  const artifact = join(directory, 'Rally.zip');
  const blockmap = `${artifact}.blockmap`;
  try {
    await writeFile(artifact, Buffer.alloc(64 * 1024, 0x41));
    const metadata = await writeBlockmap(artifact, blockmap);
    assert.equal(metadata.size, 64 * 1024);
    const payload = JSON.parse(gunzipSync(await readFile(blockmap)).toString('utf8'));
    assert.equal(payload.version, '2');
    assert.equal(payload.files[0].sizes.reduce((sum, size) => sum + size, 0), 64 * 1024);

    await assertBlockmapMatches(artifact, blockmap, join(directory, 'verification.blockmap'));
    await writeFile(artifact, Buffer.alloc(64 * 1024, 0x42));
    await assert.rejects(
      assertBlockmapMatches(artifact, blockmap, join(directory, 'changed.blockmap')),
      /does not describe the final bytes/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
