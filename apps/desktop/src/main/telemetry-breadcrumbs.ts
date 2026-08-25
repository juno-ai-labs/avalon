import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  TelemetryBreadcrumbSchema,
  TelemetryBreadcrumbSidecarSchema,
  type TelemetryBreadcrumb,
} from '@rally/contracts';

export type NewTelemetryBreadcrumb =
  | { kind: 'screen_changed'; screen: Extract<TelemetryBreadcrumb, { kind: 'screen_changed' }>['screen'] }
  | { kind: 'lifecycle'; phase: Extract<TelemetryBreadcrumb, { kind: 'lifecycle' }>['phase'] }
  | {
      kind: 'operation';
      operation: Extract<TelemetryBreadcrumb, { kind: 'operation' }>['operation'];
      state: Extract<TelemetryBreadcrumb, { kind: 'operation' }>['state'];
    };

export class TelemetryBreadcrumbRing {
  private entries: TelemetryBreadcrumb[] = [];
  private nextSequence = 1;
  private writes: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: {
    launchId: string;
    sidecarPath: string | null;
    now: () => Date;
  }) {
    TelemetryBreadcrumbSidecarSchema.parse({
      version: 1,
      launchId: options.launchId,
      updatedAt: options.now().toISOString(),
      entries: [],
    });
  }

  add(input: NewTelemetryBreadcrumb): Promise<void> {
    const operation = async (): Promise<void> => {
      const now = this.options.now();
      const entry = TelemetryBreadcrumbSchema.parse({
        ...input,
        sequence: this.nextSequence,
        at: now.toISOString(),
      });
      this.nextSequence += 1;
      this.entries = [...this.entries, entry].slice(-32);
      if (this.options.sidecarPath) {
        await writeSidecar(this.options.sidecarPath, TelemetryBreadcrumbSidecarSchema.parse({
          version: 1,
          launchId: this.options.launchId,
          updatedAt: now.toISOString(),
          entries: this.entries,
        }));
      }
    };
    const result = this.writes.then(operation, operation);
    this.writes = result.catch(() => undefined);
    return result;
  }

  status(now = this.options.now()): 'available' | 'stale' | 'unavailable' {
    const latest = this.entries.at(-1);
    if (!latest) return 'unavailable';
    return now.getTime() - Date.parse(latest.at) <= 5 * 60_000 ? 'available' : 'stale';
  }
}

async function writeSidecar(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, path);
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}
