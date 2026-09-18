import "../../../../tests/isolated-region";
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TELEMETRY_ENVELOPE_SCHEMA, type TelemetryEnvelope } from '@rally/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { TelemetrySpool } from './telemetry-spool';

const roots: string[] = [];
function uuid7(suffix: string): string {
  return `018f0000-0000-7000-8000-${suffix.padStart(12, '0')}`;
}

function envelope(
  eventId: string,
  category: 'essential' | 'product' = 'product',
): TelemetryEnvelope {
  const now = '2026-08-12T20:00:00.000Z';
  if (category === 'essential') {
    return {
      schema: TELEMETRY_ENVELOPE_SCHEMA, schemaVersion: 1, eventId,
      name: 'application_lifecycle', source: 'desktop-main', category,
      identityScope: 'installation', originalTimestamp: now, sentAt: now,
      context: { environment: 'development', release: '1.0.0', buildId: 'test' },
      properties: { state: 'ready', crashReportingEligible: true },
    };
  }
  return {
    schema: TELEMETRY_ENVELOPE_SCHEMA, schemaVersion: 1, eventId,
    name: 'screen_viewed', source: 'desktop-renderer', category,
    identityScope: 'anonymous-epoch', originalTimestamp: now, sentAt: now,
    context: { environment: 'development', release: '1.0.0', buildId: 'test' },
    properties: { screen: 'onboarding_welcome' },
  };
}

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'rally-telemetry-spool-'));
  roots.push(value);
  return value;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('TelemetrySpool', () => {
  it('validates before an atomic durable write and stores no credential or platform identity', async () => {
    const directory = await root();
    const spool = new TelemetrySpool({ rootDirectory: directory, maxRows: 10, maxBytes: 100_000 });
    const acceptedAt = new Date('2026-08-12T20:00:00.000Z');

    await spool.enqueue({
      route: 'global', accountEpochId: uuid7('10'), installationId: uuid7('11'),
      event: envelope(uuid7('12')), acceptedAt,
    });
    await expect(spool.enqueue({
      route: 'global', accountEpochId: uuid7('10'), installationId: uuid7('11'),
      event: { ...envelope(uuid7('13')), properties: { screen: 'secret-dynamic-route' } },
      acceptedAt,
    })).rejects.toThrow('Invalid telemetry envelope');

    const encoded = await readFile(join(directory, 'rows', `${uuid7('12')}.json`), 'utf8');
    expect(encoded).not.toContain('accessToken');
    expect(encoded).not.toContain('user-');
    expect(JSON.parse(encoded)).toMatchObject({
      version: 1,
      route: 'global',
      accountEpochId: uuid7('10'),
      event: { eventId: uuid7('12'), name: 'screen_viewed' },
      deleteAfter: '2026-08-26T20:00:00.000Z',
    });
    expect(await readdir(join(directory, 'rows'))).toContain(`${uuid7('12')}.deadline`);
  });

  it('expires rows at their fixed 14-day deadline and quarantines corrupt rows without extending it', async () => {
    const directory = await root();
    const spool = new TelemetrySpool({ rootDirectory: directory, maxRows: 10, maxBytes: 100_000 });
    await spool.enqueue({
      route: 'enterprise', accountEpochId: uuid7('20'), event: envelope(uuid7('21')),
      acceptedAt: new Date('2026-08-01T00:00:00.000Z'),
    });
    await spool.enqueue({
      route: 'enterprise', accountEpochId: uuid7('20'), event: envelope(uuid7('22')),
      acceptedAt: new Date('2026-08-10T00:00:00.000Z'),
    });
    await writeFile(join(directory, 'rows', `${uuid7('22')}.json`), '{broken', 'utf8');

    const result = await spool.maintain(new Date('2026-08-16T00:00:00.000Z'));
    expect(result).toEqual({ expired: 1, quarantined: 1, evicted: 0 });
    expect(await spool.ready(new Date('2026-08-16T00:00:00.000Z'))).toEqual([]);
    const quarantine = await readdir(join(directory, 'quarantine'));
    expect(quarantine.some((name) => name.endsWith('.deadline'))).toBe(true);

    await spool.maintain(new Date('2026-08-25T00:00:00.001Z'));
    expect(await readdir(join(directory, 'quarantine'))).toEqual([]);
  });

  it('evicts oldest product rows before essential rows under count pressure', async () => {
    const directory = await root();
    const spool = new TelemetrySpool({ rootDirectory: directory, maxRows: 2, maxBytes: 100_000 });
    await spool.enqueue({ route: 'global', accountEpochId: uuid7('30'), event: envelope(uuid7('31'), 'essential'), acceptedAt: new Date('2026-08-12T00:00:00.000Z') });
    await spool.enqueue({ route: 'global', accountEpochId: uuid7('30'), event: envelope(uuid7('32')), acceptedAt: new Date('2026-08-12T00:00:01.000Z') });
    await spool.enqueue({ route: 'global', accountEpochId: uuid7('30'), event: envelope(uuid7('33')), acceptedAt: new Date('2026-08-12T00:00:02.000Z') });

    const ready = await spool.ready(new Date('2026-08-12T00:00:03.000Z'));
    expect(ready.map((row) => row.event.eventId)).toEqual([uuid7('31'), uuid7('33')]);
  });

  it('acknowledges, schedules bounded retry, and purges every nonessential row on opt-out', async () => {
    const directory = await root();
    const spool = new TelemetrySpool({ rootDirectory: directory, maxRows: 10, maxBytes: 100_000 });
    await spool.enqueue({ route: 'global', accountEpochId: uuid7('40'), event: envelope(uuid7('41')), acceptedAt: new Date('2026-08-12T00:00:00.000Z') });
    await spool.enqueue({ route: 'global', accountEpochId: uuid7('40'), event: envelope(uuid7('42'), 'essential'), acceptedAt: new Date('2026-08-12T00:00:01.000Z') });
    await spool.retry(uuid7('41'), new Date('2026-08-12T00:05:00.000Z'));
    expect((await spool.ready(new Date('2026-08-12T00:01:00.000Z'))).map((row) => row.event.eventId)).toEqual([uuid7('42')]);
    await spool.acknowledge(uuid7('42'));
    expect(await spool.purgeNonessential()).toBe(1);
    expect(await spool.ready(new Date('2026-08-12T00:10:00.000Z'))).toEqual([]);
  });

  it('reports whether an anonymous identity epoch still has locally queued rows', async () => {
    const directory = await root();
    const spool = new TelemetrySpool({ rootDirectory: directory });
    const acceptedAt = new Date('2026-08-12T00:00:00.000Z');
    await spool.enqueue({
      route: 'global',
      accountEpochId: uuid7('02'),
      event: envelope(uuid7('52')),
      acceptedAt,
    });

    await expect(spool.hasPendingAccountEpoch(uuid7('02'), acceptedAt)).resolves.toBe(true);
    await spool.acknowledge(uuid7('52'));
    await expect(spool.hasPendingAccountEpoch(uuid7('02'), acceptedAt)).resolves.toBe(false);
  });

  it('serializes concurrent writes without losing rows', async () => {
    const directory = await root();
    const spool = new TelemetrySpool({ rootDirectory: directory, maxRows: 20, maxBytes: 100_000 });
    await Promise.all(Array.from({ length: 10 }, (_, index) => spool.enqueue({
      route: 'global', accountEpochId: uuid7('50'), event: envelope(uuid7(String(51 + index))),
      acceptedAt: new Date(`2026-08-12T00:00:${String(index).padStart(2, '0')}.000Z`),
    })));
    expect(await spool.ready(new Date('2026-08-12T00:01:00.000Z'))).toHaveLength(10);
  });
});


it('purges retired telemetry and its deadline without reporting corruption or deleting unrelated events', async () => {
  const directory = await root();
  const spool = new TelemetrySpool({ rootDirectory: directory });
  const acceptedAt = new Date('2026-08-12T20:00:00.000Z');
  for (const id of [uuid7('71'), uuid7('72')]) {
    await spool.enqueue({ route: 'global', accountEpochId: uuid7('70'), event: envelope(id), acceptedAt });
  }
  // Model a row already persisted by an older installed client.
  const path = join(directory, 'rows', `${uuid7('71')}.json`);
  const row = JSON.parse(await readFile(path, 'utf8'));
  row.event.name = 'note_created';
  row.event.identityScope = 'workspace-user';
  row.event.properties = { noteId: uuid7('73'), visibility: 'private', noteType: 'meeting_or_voice', entrypoint: 'sidebar' };
  await writeFile(path, JSON.stringify(row));
  expect(await spool.maintain(acceptedAt)).toEqual({ expired: 0, quarantined: 0, evicted: 0 });
  expect(await readdir(join(directory, 'rows'))).toEqual([`${uuid7('72')}.deadline`, `${uuid7('72')}.json`]);
  expect(await readdir(join(directory, 'quarantine'))).toEqual([]);
  expect((await spool.ready(acceptedAt)).map(row => row.event.eventId)).toEqual([uuid7('72')]);
  await expect(spool.prepareSend(uuid7('71'), acceptedAt)).rejects.toThrow('Telemetry row is unavailable');
});
