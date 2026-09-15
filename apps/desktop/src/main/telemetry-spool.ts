import type { Region } from "@rally/contracts/regions";
import { RegionSchema } from "@rally/contracts/regions";
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isRetiredMeetingTelemetry, TelemetryEnvelopeSchema, type TelemetryEnvelope } from '@rally/contracts';
import { z } from 'zod';

const LOCAL_RETENTION_MS = 14 * 24 * 60 * 60 * 1_000;
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

const StoredRowSchema = z.object({
  version: z.literal(1),
  route: RegionSchema,
  accountEpochId: z.string().regex(UUID_V7),
  installationId: z.string().regex(UUID_V7).optional(),
  event: TelemetryEnvelopeSchema,
  acceptedAt: z.string().datetime({ offset: true }),
  deleteAfter: z.string().datetime({ offset: true }),
  firstSentAt: z.string().datetime({ offset: true }).nullable().default(null),
  attempts: z.number().int().nonnegative(),
  nextAttemptAt: z.string().datetime({ offset: true }),
}).strict().superRefine((row, context) => {
  if (Date.parse(row.deleteAfter) !== Date.parse(row.acceptedAt) + LOCAL_RETENTION_MS) {
    context.addIssue({ code: 'custom', message: 'telemetry_deadline_invalid', path: ['deleteAfter'] });
  }
  if (row.firstSentAt !== null && row.event.sentAt !== row.firstSentAt) {
    context.addIssue({ code: 'custom', message: 'telemetry_send_time_invalid', path: ['firstSentAt'] });
  }
});

export type TelemetrySpoolRow = z.infer<typeof StoredRowSchema>;

export interface TelemetrySpoolOptions {
  rootDirectory: string;
  maxRows?: number;
  maxBytes?: number;
}

export interface EnqueueTelemetryInput {
  route: Region;
  accountEpochId: string;
  installationId?: string;
  event: TelemetryEnvelope;
  acceptedAt: Date;
}

export interface TelemetryMaintenanceResult {
  expired: number;
  quarantined: number;
  evicted: number;
}

/**
 * A main-process-only, provider-neutral spool. Every file is one immutable
 * contract row plus bounded delivery metadata, so a torn write cannot damage
 * neighboring events and inspection never has to load a large shared index.
 */
export class TelemetrySpool {
  private readonly rowsDirectory: string;
  private readonly quarantineDirectory: string;
  private readonly maxRows: number;
  private readonly maxBytes: number;
  private writes: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: TelemetrySpoolOptions) {
    this.rowsDirectory = join(options.rootDirectory, 'rows');
    this.quarantineDirectory = join(options.rootDirectory, 'quarantine');
    this.maxRows = options.maxRows ?? 2_000;
    this.maxBytes = options.maxBytes ?? 8 * 1024 * 1024;
    if (!Number.isSafeInteger(this.maxRows) || this.maxRows <= 0) throw new Error('Invalid telemetry row limit');
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes <= 0) throw new Error('Invalid telemetry byte limit');
  }

  enqueue(input: EnqueueTelemetryInput): Promise<void> {
    return this.serialize(async () => {
      const parsedEvent = TelemetryEnvelopeSchema.safeParse(input.event);
      if (!parsedEvent.success) throw new Error('Invalid telemetry envelope');
      if (!UUID_V7.test(input.accountEpochId)
        || (input.installationId !== undefined && !UUID_V7.test(input.installationId))) {
        throw new Error('Invalid telemetry identity epoch');
      }
      if (!Number.isFinite(input.acceptedAt.getTime())) throw new Error('Invalid telemetry acceptance time');
      const acceptedAt = input.acceptedAt.toISOString();
      const row = StoredRowSchema.parse({
        version: 1,
        route: input.route,
        accountEpochId: input.accountEpochId,
        ...(input.installationId ? { installationId: input.installationId } : {}),
        event: parsedEvent.data,
        acceptedAt,
        deleteAfter: new Date(input.acceptedAt.getTime() + LOCAL_RETENTION_MS).toISOString(),
        firstSentAt: null,
        attempts: 0,
        nextAttemptAt: acceptedAt,
      });
      await this.initializeDirectories();
      // The deadline is a separate tiny file so even invalid JSON retains an
      // enforceable deletion ceiling after quarantine.
      await writeAtomically(this.deadlinePath(row.event.eventId), `${row.deleteAfter}\n`);
      try {
        await writeAtomically(this.rowPath(row.event.eventId), `${JSON.stringify(row)}\n`);
      } catch (error) {
        await rm(this.deadlinePath(row.event.eventId), { force: true });
        throw error;
      }
      await this.maintainUnlocked(input.acceptedAt);
    });
  }

  ready(now: Date, limit = 50): Promise<TelemetrySpoolRow[]> {
    return this.serialize(async () => {
      await this.maintainUnlocked(now);
      const rows = await this.readRows(now);
      return rows
        .filter((row) => Date.parse(row.nextAttemptAt) <= now.getTime())
        .sort((left, right) => Date.parse(left.acceptedAt) - Date.parse(right.acceptedAt))
        .slice(0, Math.max(0, Math.min(50, limit)));
    });
  }

  acknowledge(eventId: string): Promise<void> {
    return this.serialize(async () => {
      assertEventId(eventId);
      await Promise.all([
        rm(this.rowPath(eventId), { force: true }),
        rm(this.deadlinePath(eventId), { force: true }),
      ]);
    });
  }

  prepareSend(eventId: string, sentAt: Date): Promise<TelemetrySpoolRow> {
    return this.serialize(async () => {
      assertEventId(eventId);
      if (!Number.isFinite(sentAt.getTime())) throw new Error('Invalid telemetry send time');
      const row = await this.readRow(this.rowPath(eventId));
      if (!row) throw new Error('Telemetry row is unavailable');
      if (row.firstSentAt !== null) return row;
      const firstSentAt = sentAt.toISOString();
      const updated = StoredRowSchema.parse({
        ...row,
        firstSentAt,
        event: { ...row.event, sentAt: firstSentAt },
      });
      await writeAtomically(this.rowPath(eventId), `${JSON.stringify(updated)}\n`);
      return updated;
    });
  }

  hasPendingAccountEpoch(accountEpochId: string, now: Date): Promise<boolean> {
    return this.serialize(async () => {
      if (!UUID_V7.test(accountEpochId)) throw new Error('Invalid telemetry identity epoch');
      await this.maintainUnlocked(now);
      return (await this.readRows(now)).some((row) => row.accountEpochId === accountEpochId);
    });
  }

  retry(eventId: string, nextAttemptAt: Date): Promise<void> {
    return this.serialize(async () => {
      assertEventId(eventId);
      if (!Number.isFinite(nextAttemptAt.getTime())) throw new Error('Invalid telemetry retry time');
      const row = await this.readRow(this.rowPath(eventId));
      if (!row) throw new Error('Telemetry row is unavailable');
      if (nextAttemptAt.getTime() >= Date.parse(row.deleteAfter)) {
        await Promise.all([rm(this.rowPath(eventId), { force: true }), rm(this.deadlinePath(eventId), { force: true })]);
        return;
      }
      await writeAtomically(this.rowPath(eventId), `${JSON.stringify({
        ...row,
        attempts: row.attempts + 1,
        nextAttemptAt: nextAttemptAt.toISOString(),
      })}\n`);
    });
  }

  purgeNonessential(): Promise<number> {
    return this.serialize(async () => {
      let purged = 0;
      for (const row of await this.readRows(new Date(0), false)) {
        if (row.event.category === 'essential') continue;
        await Promise.all([
          rm(this.rowPath(row.event.eventId), { force: true }),
          rm(this.deadlinePath(row.event.eventId), { force: true }),
        ]);
        purged += 1;
      }
      return purged;
    });
  }

  maintain(now: Date): Promise<TelemetryMaintenanceResult> {
    return this.serialize(() => this.maintainUnlocked(now));
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writes.then(operation, operation);
    this.writes = result.catch(() => undefined);
    return result;
  }

  private async maintainUnlocked(now: Date): Promise<TelemetryMaintenanceResult> {
    if (!Number.isFinite(now.getTime())) throw new Error('Invalid telemetry maintenance time');
    await this.initializeDirectories();
    const result: TelemetryMaintenanceResult = { expired: 0, quarantined: 0, evicted: 0 };
    await this.purgeQuarantine(now);

    const rows: TelemetrySpoolRow[] = [];
    const names = await readdir(this.rowsDirectory);
    for (const name of names.filter((candidate) => candidate.endsWith('.json')).sort()) {
      const path = join(this.rowsDirectory, name);
      const eventId = name.slice(0, -'.json'.length);
      const row = await this.readRow(path);
      if (!row || row.event.eventId !== eventId) {
        await this.quarantine(eventId, now);
        result.quarantined += 1;
        continue;
      }
      if (Date.parse(row.deleteAfter) <= now.getTime()) {
        await Promise.all([rm(path, { force: true }), rm(this.deadlinePath(eventId), { force: true })]);
        result.expired += 1;
        continue;
      }
      rows.push(row);
    }

    const survivors = [...rows];
    while (survivors.length > this.maxRows || await this.totalBytes() > this.maxBytes) {
      const victim = [...survivors].sort(compareEviction)[0];
      if (!victim) break;
      await Promise.all([
        rm(this.rowPath(victim.event.eventId), { force: true }),
        rm(this.deadlinePath(victim.event.eventId), { force: true }),
      ]);
      survivors.splice(survivors.indexOf(victim), 1);
      result.evicted += 1;
    }
    return result;
  }

  private async readRows(now: Date, enforceTime = true): Promise<TelemetrySpoolRow[]> {
    const rows: TelemetrySpoolRow[] = [];
    for (const name of (await readdir(this.rowsDirectory)).filter((candidate) => candidate.endsWith('.json')).sort()) {
      const row = await this.readRow(join(this.rowsDirectory, name));
      if (row && (!enforceTime || Date.parse(row.deleteAfter) > now.getTime())) rows.push(row);
    }
    return rows;
  }

  private async readRow(path: string): Promise<TelemetrySpoolRow | null> {
    try {
      const parsed = StoredRowSchema.safeParse(JSON.parse(await readFile(path, 'utf8')) as unknown);
      if (parsed.success && isRetiredMeetingTelemetry(parsed.data.event)) {
        await rm(path, { force: true });
        return null;
      }
      return parsed.success ? parsed.data : null;
    } catch (error) {
      if (error instanceof SyntaxError) return null;
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
      throw error;
    }
  }

  private async quarantine(eventId: string, now: Date): Promise<void> {
    const deadline = await readDeadline(this.deadlinePath(eventId));
    if (!deadline || deadline.getTime() <= now.getTime()) {
      await Promise.all([rm(this.rowPath(eventId), { force: true }), rm(this.deadlinePath(eventId), { force: true })]);
      return;
    }
    const stem = `${eventId}.${randomUUID()}`;
    await rename(this.rowPath(eventId), join(this.quarantineDirectory, `${stem}.json`)).catch(() => undefined);
    await rename(this.deadlinePath(eventId), join(this.quarantineDirectory, `${stem}.deadline`)).catch(() => undefined);
  }

  private async purgeQuarantine(now: Date): Promise<void> {
    const names = await readdir(this.quarantineDirectory);
    for (const name of names.filter((candidate) => candidate.endsWith('.deadline'))) {
      const deadlinePath = join(this.quarantineDirectory, name);
      const deadline = await readDeadline(deadlinePath);
      if (deadline && deadline.getTime() > now.getTime()) continue;
      const stem = name.slice(0, -'.deadline'.length);
      await Promise.all([
        rm(deadlinePath, { force: true }),
        rm(join(this.quarantineDirectory, `${stem}.json`), { force: true }),
      ]);
    }
  }

  private async totalBytes(): Promise<number> {
    let bytes = 0;
    for (const directory of [this.rowsDirectory, this.quarantineDirectory]) {
      for (const name of await readdir(directory)) {
        bytes += (await stat(join(directory, name))).size;
      }
    }
    return bytes;
  }

  private async initializeDirectories(): Promise<void> {
    await mkdir(this.rowsDirectory, { recursive: true, mode: 0o700 });
    await mkdir(this.quarantineDirectory, { recursive: true, mode: 0o700 });
  }

  private rowPath(eventId: string): string {
    return join(this.rowsDirectory, `${eventId}.json`);
  }

  private deadlinePath(eventId: string): string {
    return join(this.rowsDirectory, `${eventId}.deadline`);
  }
}

function compareEviction(left: TelemetrySpoolRow, right: TelemetrySpoolRow): number {
  const leftEssential = left.event.category === 'essential' ? 1 : 0;
  const rightEssential = right.event.category === 'essential' ? 1 : 0;
  if (leftEssential !== rightEssential) return leftEssential - rightEssential;
  return Date.parse(left.acceptedAt) - Date.parse(right.acceptedAt);
}

function assertEventId(eventId: string): void {
  if (!UUID_V7.test(eventId)) throw new Error('Invalid telemetry event ID');
}

async function readDeadline(path: string): Promise<Date | null> {
  try {
    const encoded = (await readFile(path, 'utf8')).trim();
    const timestamp = Date.parse(encoded);
    return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === encoded ? new Date(timestamp) : null;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
}

async function writeAtomically(path: string, contents: string): Promise<void> {
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, path);
    const directory = await open(dirname(path), 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}
