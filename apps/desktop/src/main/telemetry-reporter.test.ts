import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TelemetryReporter } from './telemetry-reporter';
import { TelemetrySpool } from './telemetry-spool';

const roots: string[] = [];
const identity = {
  version: 1 as const,
  installationId: '018f0000-0000-7000-8000-000000000001',
  anonymousEpochId: '018f0000-0000-7000-8000-000000000002',
  accountEpochId: '018f0000-0000-7000-8000-000000000003',
};

async function harness(input: {
  enabled?: boolean;
  route?: 'global' | 'eu';
  auth?: { apiBaseUrl: string; accessToken: string; workspace: boolean; route: 'global' | 'eu' } | null;
  anonymous?: { capability: string; journeyId: string; expiresAt: string } | null;
  refreshAnonymous?: () => Promise<{ capability: string; journeyId: string; expiresAt: string } | null>;
  now?: () => Date;
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'avalon-reporter-'));
  roots.push(directory);
  const spool = new TelemetrySpool({ rootDirectory: directory, maxRows: 50, maxBytes: 500_000 });
  const fetch = vi.fn<typeof globalThis.fetch>();
  let eventSequence = 0x10;
  const reporter = new TelemetryReporter({
    spool,
    identity: () => identity,
    route: () => input.route ?? 'global',
    productAnalyticsEnabled: () => input.enabled ?? true,
    authenticatedSession: async () => input.auth ?? null,
    anonymousSession: () => input.anonymous ?? null,
    refreshAnonymousSession: input.refreshAnonymous,
    fetch,
    now: input.now ?? (() => new Date('2026-08-12T20:00:00.000Z')),
    runtime: {
      environment: 'development', release: '1.96.0', buildId: 'test',
      platform: 'darwin', arch: 'arm64', channel: 'development', osVersion: '15.6.1',
      locale: 'en-US', timezone: 'America/Los_Angeles', screenWidth: 2560, screenHeight: 1440,
    },
    eventId: () => `018f0000-0000-7000-8000-${(eventSequence++).toString(16).padStart(12, '0')}`,
  });
  return { reporter, spool, fetch };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('TelemetryReporter', () => {
  it('keeps essential lifecycle signals while suppressing product signals after opt-out', async () => {
    const { reporter, spool } = await harness({ enabled: false });
    await reporter.applicationLifecycle('ready');
    await reporter.screenViewed('workspace_home');
    const rows = await spool.ready(new Date('2026-08-12T20:00:01.000Z'));
    expect(rows.map((row) => row.event.name)).toEqual(['application_lifecycle']);
    expect(reporter.inspector()).toMatchObject([
      { name: 'application_lifecycle', validation: 'accepted' },
      { name: 'screen_viewed', validation: 'suppressed' },
    ]);
  });

  it('buckets update duration without retaining versions or provider errors', async () => {
    const { reporter, spool } = await harness({ enabled: false });
    await reporter.updateOutcome('download', 'failed', 6_250);
    const [row] = await spool.ready(new Date('2026-08-12T20:00:01.000Z'));
    expect(row?.event).toMatchObject({
      name: 'update_outcome',
      category: 'essential',
      identityScope: 'installation',
      properties: { phase: 'download', result: 'failed', duration: '5s_30s' },
    });
  });

  it('reports bounded crash, spool, and crash-free session states as content-free essentials', async () => {
    const { reporter, spool } = await harness({ enabled: false });
    await reporter.desktopSession('started', false);
    await reporter.crashUploadState('retrying');
    await reporter.telemetrySpoolState('evicted', 12);
    const rows = await spool.ready(new Date('2026-08-12T20:00:01.000Z'));
    expect(rows.map((row) => ({ name: row.event.name, properties: row.event.properties }))).toEqual([
      { name: 'desktop_session', properties: { state: 'started', continuouslyEligible: false } },
      { name: 'crash_upload_state', properties: { state: 'retrying' } },
      { name: 'telemetry_spool_state', properties: { state: 'evicted', count: 'eleven_to_one_hundred' } },
    ]);
  });

  it('builds registered envelopes and never lets an invalid renderer value reach disk', async () => {
    const anonymous = {
      capability: 'c'.repeat(64),
      journeyId: '018f0000-0000-7000-8000-000000000004',
      expiresAt: '2026-08-12T21:00:00.000Z',
    };
    const { reporter, spool } = await harness({ anonymous });
    await reporter.screenViewed('onboarding_welcome', {
      windowId: '018f0000-0000-7000-8000-000000000099',
      viewportWidth: 1480,
      viewportHeight: 940,
      screenWidth: 3024,
      screenHeight: 1964,
    });
    await reporter.screenViewed('private/workspace/42' as never);
    const [row] = await spool.ready(new Date('2026-08-12T20:00:01.000Z'));
    expect(row?.event).toMatchObject({
      name: 'screen_viewed', source: 'desktop-renderer', category: 'product',
      identityScope: 'anonymous-epoch',
      context: {
        onboardingJourneyId: anonymous.journeyId,
        region: 'global',
        deviceId: identity.installationId,
        osVersion: '15.6.1',
        locale: 'en-US',
        timezone: 'America/Los_Angeles',
        windowId: '018f0000-0000-7000-8000-000000000099',
        viewportWidth: 1480,
        viewportHeight: 940,
        screenWidth: 3024,
        screenHeight: 1964,
      },
      properties: { screen: 'onboarding_welcome' },
    });
    expect(reporter.inspector().at(-1)).toMatchObject({ validation: 'rejected' });
  });

  it('records native application install and update transitions as installation lifecycle events', async () => {
    const { reporter, spool } = await harness({ enabled: false });
    await reporter.applicationVersionChanged({ state: 'installed' });
    await reporter.applicationVersionChanged({
      state: 'updated',
      previousVersion: '1.95.0',
      previousBuild: '19500',
    });

    const rows = await spool.ready(new Date('2026-08-12T20:00:01.000Z'));
    expect(rows.map((row) => ({ name: row.event.name, properties: row.event.properties }))).toEqual([
      { name: 'application_version_changed', properties: { state: 'installed' } },
      {
        name: 'application_version_changed',
        properties: { state: 'updated', previousVersion: '1.95.0', previousBuild: '19500' },
      },
    ]);
  });

  it('uploads authenticated rows to only their regional API and acknowledges durable results', async () => {
    const { reporter, spool, fetch } = await harness({
      auth: { apiBaseUrl: 'https://api.with-avalon.com', accessToken: 'secret', workspace: true, route: 'global' },
    });
    fetch.mockResolvedValue(new Response(JSON.stringify({
      results: [{ result: 'accepted', eventId: '018f0000-0000-7000-8000-000000000010' }],
    }), { status: 202, headers: { 'content-type': 'application/json' } }));
    await reporter.screenViewed('workspace_home');
    await reporter.flush();

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, request] = fetch.mock.calls[0]!;
    expect(url).toBe('https://api.with-avalon.com/telemetry/events');
    expect(new Headers(request?.headers).get('authorization')).toBe('Bearer secret');
    const body = JSON.parse(String(request?.body));
    expect(body.installationId).toBe(identity.installationId);
    expect(body.events[0]).toMatchObject({ name: 'screen_viewed', identityScope: 'workspace-user' });
    expect(await spool.ready(new Date('2026-08-12T20:01:00.000Z'))).toEqual([]);
  });

  it('uses the Global capability endpoint for a route-fixed anonymous EU event', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'avalon-reporter-eu-'));
    roots.push(directory);
    const spool = new TelemetrySpool({ rootDirectory: directory });
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({
      results: [{ result: 'accepted', eventId: '018f0000-0000-7000-8000-000000000010' }],
    }), { status: 202 }));
    const reporter = new TelemetryReporter({
      spool, identity: () => identity, route: () => 'eu', productAnalyticsEnabled: () => true,
      authenticatedSession: async () => null,
      anonymousSession: () => ({
        capability: 'c'.repeat(64), journeyId: '018f0000-0000-7000-8000-000000000004',
        expiresAt: '2026-08-12T21:00:00.000Z',
      }),
      fetch, now: () => new Date('2026-08-12T20:00:00.000Z'),
      runtime: { environment: 'development', release: '1.96.0', buildId: 'test' },
      globalApiBaseUrl: 'https://api.with-avalon.com',
      eventId: () => '018f0000-0000-7000-8000-000000000010',
    });
    await reporter.screenViewed('onboarding_region');
    await reporter.flush();
    expect(fetch.mock.calls[0]?.[0]).toBe('https://api.with-avalon.com/telemetry/anonymous');
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toMatchObject({ capability: 'c'.repeat(64) });
  });

  it('routes pre-workspace EU onboarding intent immediately through its anonymous epoch', async () => {
    const anonymous = {
      capability: 'c'.repeat(64),
      journeyId: '018f0000-0000-7000-8000-000000000004',
      expiresAt: '2026-08-12T21:00:00.000Z',
    };
    const { reporter, spool, fetch } = await harness({
      route: 'eu',
      anonymous,
      auth: {
        apiBaseUrl: 'https://api.with-avalon.com',
        accessToken: 'global-login-token',
        workspace: false,
        route: 'global',
      },
    });
    fetch.mockResolvedValue(new Response(JSON.stringify({
      results: [{ result: 'accepted', eventId: '018f0000-0000-7000-8000-000000000010' }],
    }), { status: 202 }));

    await reporter.workspaceCreateRequested(
      'eu',
      'first_run',
      '018f0000-0000-7000-8000-000000000099',
    );
    const [queued] = await spool.ready(new Date('2026-08-12T20:00:01.000Z'));
    expect(queued).toMatchObject({
      route: 'eu',
      event: { identityScope: 'anonymous-epoch', context: { onboardingJourneyId: anonymous.journeyId } },
    });
    await reporter.flush();
    expect(fetch.mock.calls[0]?.[0]).toBe('https://api.with-avalon.com/telemetry/anonymous');
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).has('authorization')).toBe(false);
  });

  it('uses the route-fixed capability for logged-out content-free installation health', async () => {
    const anonymous = {
      capability: 'c'.repeat(64),
      journeyId: '018f0000-0000-7000-8000-000000000004',
      expiresAt: '2026-08-12T21:00:00.000Z',
    };
    const { reporter, fetch } = await harness({ anonymous, auth: null });
    fetch.mockResolvedValue(new Response(JSON.stringify({
      results: [{ result: 'accepted', eventId: '018f0000-0000-7000-8000-000000000010' }],
    }), { status: 202 }));
    await reporter.applicationLifecycle('launch_started');
    await reporter.flush();
    expect(fetch.mock.calls[0]?.[0]).toBe('https://api.with-avalon.com/telemetry/anonymous');
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toMatchObject({
      capability: anonymous.capability,
      installationId: identity.installationId,
      events: [{ name: 'application_lifecycle', identityScope: 'installation' }],
    });
  });

  it('refreshes an expired fixed-route capability before delivery', async () => {
    const expired = {
      capability: 'c'.repeat(64), journeyId: '018f0000-0000-7000-8000-000000000004',
      expiresAt: '2026-08-12T19:59:00.000Z',
    };
    const refreshed = { ...expired, capability: 'd'.repeat(64), expiresAt: '2026-08-12T21:00:00.000Z' };
    const refreshAnonymous = vi.fn(async () => refreshed);
    const { reporter, fetch } = await harness({ anonymous: expired, refreshAnonymous });
    fetch.mockResolvedValue(new Response(JSON.stringify({
      results: [{ result: 'accepted', eventId: '018f0000-0000-7000-8000-000000000010' }],
    }), { status: 202 }));

    await reporter.screenViewed('onboarding_welcome');
    await reporter.flush();
    expect(refreshAnonymous).toHaveBeenCalledOnce();
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toMatchObject({
      capability: refreshed.capability,
    });
  });

  it('retains a row with bounded backoff when delivery fails and does not throw into the product path', async () => {
    const { reporter, spool, fetch } = await harness({
      auth: { apiBaseUrl: 'https://api.with-avalon.com', accessToken: 'secret', workspace: true, route: 'global' },
    });
    fetch.mockRejectedValue(new Error('offline'));
    await reporter.screenViewed('workspace_home');
    await expect(reporter.flush()).resolves.toBeUndefined();
    expect(await spool.ready(new Date('2026-08-12T20:00:59.000Z'))).toEqual([]);
    expect(await spool.ready(new Date('2026-08-12T20:02:00.000Z'))).toHaveLength(1);
  });

  it('records the first actual send time and preserves it across delivery retries', async () => {
    let now = new Date('2026-08-01T20:00:00.000Z');
    const { reporter, spool, fetch } = await harness({
      auth: { apiBaseUrl: 'https://api.with-avalon.com', accessToken: 'secret', workspace: true, route: 'global' },
      now: () => now,
    });
    fetch
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        results: [{ result: 'accepted', eventId: '018f0000-0000-7000-8000-000000000010' }],
      }), { status: 202 }));

    await reporter.screenViewed('workspace_home');
    now = new Date('2026-08-05T20:00:00.000Z');
    await reporter.flush();
    const [retry] = await spool.ready(new Date('2026-08-05T20:02:00.000Z'));
    expect(retry?.event).toMatchObject({
      originalTimestamp: '2026-08-01T20:00:00.000Z',
      sentAt: '2026-08-05T20:00:00.000Z',
    });

    now = new Date('2026-08-05T20:02:00.000Z');
    await reporter.flush();
    const secondRequest = JSON.parse(String(fetch.mock.calls[1]?.[1]?.body));
    expect(secondRequest.events[0]).toMatchObject({
      originalTimestamp: '2026-08-01T20:00:00.000Z',
      sentAt: '2026-08-05T20:00:00.000Z',
    });
  });
});
