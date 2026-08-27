import { access, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prepareNativeCrashGeneration } from './native-crash-generation';
import { NativeCrashUploader } from './native-crash-uploader';

const roots: string[] = [];
const runtime = {
  release: '1.96.0', buildId: 'build-1', platform: 'darwin' as const, architecture: 'arm64' as const,
  launchId: '018f0000-0000-7000-8000-000000000004', channel: 'stable' as const,
};
const generationEpoch = Date.now() - 60 * 60_000;
const generationTime = (minute: number): Date => new Date(generationEpoch + minute * 60_000);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-08-12T20:05:00.000Z'));
});

async function fixture(): Promise<{ root: string; dump: string }> {
  const root = await mkdtemp(join(tmpdir(), 'rally-native-upload-'));
  roots.push(root);
  const first = await prepareNativeCrashGeneration({
    rootDirectory: root, route: 'global', now: generationTime(0),
    generationId: '018f0000-0000-7000-8000-000000000001',
    runtime,
  });
  const dump = join(first.activeCrashpadDirectory!, 'completed', 'renderer.dmp');
  await mkdir(join(first.activeCrashpadDirectory!, 'completed'), { recursive: true });
  const bytes = new Uint8Array(32);
  bytes.set(new TextEncoder().encode('MDMP'));
  await writeFile(dump, bytes);
  await prepareNativeCrashGeneration({
    rootDirectory: root, route: 'global', now: generationTime(1),
    generationId: '018f0000-0000-7000-8000-000000000002',
    runtime,
  });
  return {
    root,
    dump: join(root, 'upload', 'global', '018f0000-0000-7000-8000-000000000001', 'crashpad', 'completed', 'renderer.dmp'),
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  vi.useRealTimers();
});

describe('NativeCrashUploader', () => {
  it('uploads an explicit EU generation only to an authenticated EU API', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rally-native-upload-eu-'));
    roots.push(root);
    const first = await prepareNativeCrashGeneration({
      rootDirectory: root, route: 'eu', now: generationTime(0),
      generationId: '018f0000-0000-7000-8000-000000000021',
      runtime,
    });
    await mkdir(join(first.activeCrashpadDirectory!, 'completed'), { recursive: true });
    const bytes = new Uint8Array(32);
    bytes.set(new TextEncoder().encode('MDMP'));
    await writeFile(join(first.activeCrashpadDirectory!, 'completed', 'renderer.dmp'), bytes);
    await prepareNativeCrashGeneration({
      rootDirectory: root, route: 'eu', now: generationTime(1),
      generationId: '018f0000-0000-7000-8000-000000000022',
      runtime,
    });
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({
      result: 'accepted', uploadId: '018f0000-0000-7000-8000-000000000023',
    }), { status: 202 }));
    const uploader = new NativeCrashUploader({
      rootDirectory: root, enabled: () => true,
      identity: () => ({ installationId: '018f0000-0000-7000-8000-000000000003' }),
      authenticatedSession: async () => ({
        apiBaseUrl: 'https://eu.api.rallywith.ai', accessToken: 'eu-secret', route: 'eu',
      }),
      anonymousSession: () => null, globalApiBaseUrl: 'https://api.rallywith.ai', fetch,
      eventId: () => '018f0000-0000-7000-8000-000000000023',
    });
    await uploader.flush();
    expect(fetch.mock.calls[0]?.[0]).toBe('https://eu.api.rallywith.ai/telemetry/crashes');
    expect(JSON.parse(String((fetch.mock.calls[0]?.[1]?.body as FormData).get('metadata')))).toMatchObject({ route: 'eu' });
  });

  it('uploads an inactive dump with normal regional auth and removes it only after acknowledgement', async () => {
    const { root, dump } = await fixture();
    await writeFile(join(
      root, 'upload', 'global', '018f0000-0000-7000-8000-000000000001', 'breadcrumbs.json',
    ), JSON.stringify({
      version: 1,
      launchId: '018f0000-0000-7000-8000-000000000001',
      updatedAt: '2026-08-12T20:00:30.000Z',
      entries: [{
        sequence: 1, at: '2026-08-12T20:00:30.000Z', kind: 'screen_changed', screen: 'workstream',
      }],
    }));
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({
      result: 'accepted', uploadId: '018f0000-0000-7000-8000-000000000010',
    }), { status: 202 }));
    const onState = vi.fn();
    const uploader = new NativeCrashUploader({
      rootDirectory: root, enabled: () => true,
      identity: () => ({ installationId: '018f0000-0000-7000-8000-000000000003' }),
      authenticatedSession: async () => ({
        apiBaseUrl: 'https://api.rallywith.ai', accessToken: 'secret', route: 'global',
      }),
      anonymousSession: () => null, globalApiBaseUrl: 'https://api.rallywith.ai', fetch,
      eventId: () => '018f0000-0000-7000-8000-000000000010',
      onState,
    });
    await uploader.flush();

    expect(fetch.mock.calls[0]?.[0]).toBe('https://api.rallywith.ai/telemetry/crashes');
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get('authorization')).toBe('Bearer secret');
    const form = fetch.mock.calls[0]?.[1]?.body as FormData;
    expect(JSON.parse(String(form.get('metadata')))).toMatchObject({
      route: 'global', processRole: 'unknown', installationId: '018f0000-0000-7000-8000-000000000003',
      launchId: runtime.launchId, channel: 'stable',
    });
    expect(JSON.parse(String(form.get('breadcrumbs')))).toMatchObject({
      entries: [{ kind: 'screen_changed', screen: 'workstream' }],
    });
    await expect(access(dump)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(onState.mock.calls.map(([state]) => state)).toEqual(['queued', 'uploading', 'accepted']);
  });

  it('uses a Global onboarding capability and leaves a valid EU-designated generation untouched', async () => {
    const { root, dump } = await fixture();
    const euFirst = await prepareNativeCrashGeneration({
      rootDirectory: root, route: 'eu', now: generationTime(2),
      generationId: '018f0000-0000-7000-8000-000000000098', runtime,
    });
    const euActiveDump = join(euFirst.activeCrashpadDirectory!, 'completed', 'eu.dmp');
    await mkdir(join(euFirst.activeCrashpadDirectory!, 'completed'), { recursive: true });
    const euBytes = new Uint8Array(32);
    euBytes.set(new TextEncoder().encode('MDMP'));
    await writeFile(euActiveDump, euBytes);
    await prepareNativeCrashGeneration({
      rootDirectory: root, route: 'global', now: generationTime(3),
      generationId: '018f0000-0000-7000-8000-000000000099', runtime,
    });
    const euDirectory = join(root, 'upload', 'eu', '018f0000-0000-7000-8000-000000000098');
    const euDump = join(euDirectory, 'crashpad', 'completed', 'eu.dmp');
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({
      result: 'accepted', uploadId: '018f0000-0000-7000-8000-000000000010',
    }), { status: 202 }));
    const uploader = new NativeCrashUploader({
      rootDirectory: root, enabled: () => true,
      identity: () => ({ installationId: '018f0000-0000-7000-8000-000000000003' }),
      authenticatedSession: async () => null,
      anonymousSession: () => ({
        capability: 'c'.repeat(64), route: 'global', expiresAt: '2099-01-01T00:00:00.000Z',
      }),
      globalApiBaseUrl: 'https://api.rallywith.ai', fetch,
      eventId: () => '018f0000-0000-7000-8000-000000000010',
    });
    await uploader.flush();
    expect(fetch.mock.calls[0]?.[0]).toBe('https://api.rallywith.ai/telemetry/crashes/anonymous');
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get('x-rally-telemetry-capability')).toBe('c'.repeat(64));
    await expect(access(dump)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(euDump)).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('retains the exact inactive dump on retryable failure and purges it immediately on opt-out', async () => {
    const { root, dump } = await fixture();
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error('offline'));
    const onState = vi.fn();
    const uploader = new NativeCrashUploader({
      rootDirectory: root, enabled: () => true,
      identity: () => ({ installationId: '018f0000-0000-7000-8000-000000000003' }),
      authenticatedSession: async () => ({ apiBaseUrl: 'https://api.rallywith.ai', accessToken: 'secret', route: 'global' }),
      anonymousSession: () => null, globalApiBaseUrl: 'https://api.rallywith.ai', fetch,
      onState,
    });
    await expect(uploader.flush()).resolves.toBeUndefined();
    await expect(access(dump)).resolves.toBeUndefined();
    expect(onState.mock.calls.map(([state]) => state)).toEqual(['queued', 'uploading', 'retrying']);
    await uploader.purgeInactive();
    await expect(access(dump)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('retains an anonymous dump and refreshes its fixed-route capability after credential rejection', async () => {
    const { root, dump } = await fixture();
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(null, { status: 401 }));
    const refreshAnonymousSession = vi.fn(async () => ({
      capability: 'd'.repeat(64), route: 'global' as const, expiresAt: '2099-01-01T00:00:00.000Z',
    }));
    const onState = vi.fn();
    const uploader = new NativeCrashUploader({
      rootDirectory: root, enabled: () => true,
      identity: () => ({ installationId: '018f0000-0000-7000-8000-000000000003' }),
      authenticatedSession: async () => null,
      anonymousSession: () => ({
        capability: 'c'.repeat(64), route: 'global', expiresAt: '2099-01-01T00:00:00.000Z',
      }),
      refreshAnonymousSession,
      globalApiBaseUrl: 'https://api.rallywith.ai', fetch, onState,
    });

    await uploader.flush();
    expect(refreshAnonymousSession).toHaveBeenCalledOnce();
    await expect(access(dump)).resolves.toBeUndefined();
    expect(onState.mock.calls.map(([state]) => state)).toEqual(['queued', 'uploading', 'retrying']);
  });

  it('evicts the oldest inactive reports before upload when the native spool reaches its count bound', async () => {
    const { root, dump } = await fixture();
    const completed = join(dump, '..');
    const extraDump = join(completed, 'zz-extra.dmp');
    const bytes = new Uint8Array(32);
    bytes.set(new TextEncoder().encode('MDMP'));
    await writeFile(extraDump, bytes);
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error('offline'));
    const onState = vi.fn();
    const uploader = new NativeCrashUploader({
      rootDirectory: root, enabled: () => true,
      identity: () => ({ installationId: '018f0000-0000-7000-8000-000000000003' }),
      authenticatedSession: async () => ({ apiBaseUrl: 'https://api.rallywith.ai', accessToken: 'secret', route: 'global' }),
      anonymousSession: () => null, globalApiBaseUrl: 'https://api.rallywith.ai', fetch,
      maxReports: 1,
      onState,
    });

    await uploader.flush();
    expect((await readdir(completed)).filter((name) => name.endsWith('.dmp'))).toHaveLength(1);
    expect(fetch).toHaveBeenCalledOnce();
    expect(onState.mock.calls.map(([state]) => state)).toContain('evicted');
  });

  it('reuses the upload id from a sidecar written before the rename', async () => {
    // A dump queued by the previous build carries `<dump>.avalon.json`. Minting
    // a fresh id for it files the same crash a second time.
    const { root, dump } = await fixture();
    await writeFile(`${dump}.avalon.json`, `${JSON.stringify({
      version: 1, uploadId: '018f0000-0000-7000-8000-0000000000ab',
    })}\n`);
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({
      result: 'accepted', uploadId: '018f0000-0000-7000-8000-0000000000ab',
    }), { status: 202 }));
    const uploader = new NativeCrashUploader({
      rootDirectory: root, enabled: () => true,
      identity: () => ({ installationId: '018f0000-0000-7000-8000-000000000003' }),
      authenticatedSession: async () => ({
        apiBaseUrl: 'https://api.rallywith.ai', accessToken: 'secret', route: 'global',
      }),
      anonymousSession: () => null, globalApiBaseUrl: 'https://api.rallywith.ai', fetch,
      eventId: () => '018f0000-0000-7000-8000-00000000ffff',
    });

    await uploader.flush();

    const form = fetch.mock.calls[0]?.[1]?.body as FormData;
    expect(JSON.parse(String(form.get('metadata')))).toMatchObject({
      uploadId: '018f0000-0000-7000-8000-0000000000ab',
    });
    // Both sidecar names are cleaned up, so the dump cannot be re-queued.
    await expect(access(`${dump}.avalon.json`)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
