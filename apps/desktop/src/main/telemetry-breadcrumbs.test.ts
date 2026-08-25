import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TelemetryBreadcrumbRing } from './telemetry-breadcrumbs';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe('TelemetryBreadcrumbRing', () => {
  it('persists only the newest 32 typed checkpoints in an atomic sidecar', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rally-breadcrumbs-'));
    roots.push(root);
    const sidecarPath = join(root, 'breadcrumbs.json');
    let now = Date.parse('2026-08-12T20:00:00Z');
    const ring = new TelemetryBreadcrumbRing({
      launchId: '018f22f2-4c22-7abc-8def-0123456789ab',
      sidecarPath,
      now: () => new Date(now++),
    });
    for (let index = 0; index < 40; index += 1) {
      await ring.add({ kind: 'screen_changed', screen: 'workspace_home' });
    }
    const stored = JSON.parse(await readFile(sidecarPath, 'utf8')) as { entries: unknown[] };
    expect(stored.entries).toHaveLength(32);
    expect(stored.entries[0]).toMatchObject({ sequence: 9, kind: 'screen_changed', screen: 'workspace_home' });
    expect(JSON.stringify(stored)).not.toMatch(/path|message|objective|url|payload/u);
  });

  it('reports available, stale, and unavailable without requiring a crash sidecar', async () => {
    let now = Date.parse('2026-08-12T20:00:00Z');
    const ring = new TelemetryBreadcrumbRing({
      launchId: '018f22f2-4c22-7abc-8def-0123456789ab', sidecarPath: null,
      now: () => new Date(now),
    });
    expect(ring.status()).toBe('unavailable');
    await ring.add({ kind: 'lifecycle', phase: 'ready' });
    expect(ring.status()).toBe('available');
    now += 5 * 60_000 + 1;
    expect(ring.status()).toBe('stale');
  });
});
