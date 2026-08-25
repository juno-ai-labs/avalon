import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

interface WorkerConfig {
  r2_buckets?: Array<{ binding?: string; bucket_name?: string; jurisdiction?: string }>;
  containers?: Array<{
    name?: string;
    class_name?: string;
    image?: string;
    max_instances?: number;
    instance_type?: string;
    constraints?: { jurisdiction?: string; regions?: string[] };
    ssh?: { enabled?: boolean };
  }>;
  durable_objects?: { bindings?: Array<{ name?: string; class_name?: string }> };
  migrations?: Array<{ tag?: string; new_sqlite_classes?: string[] }>;
}

function config(fileName: string): WorkerConfig {
  const raw = readFileSync(new URL(`../${fileName}`, import.meta.url), 'utf8');
  return JSON.parse(raw.replace(/^\s*\/\/.*$/gmu, '')) as WorkerConfig;
}

function symbolicator(configValue: WorkerConfig) {
  return configValue.containers?.find((entry) => entry.class_name === 'CrashSymbolicatorContainer');
}

describe('crash symbolicator deployment', () => {
  it('isolates telemetry bytes in distinct region-owned R2 buckets', () => {
    const globalBuckets = config('wrangler.global.jsonc').r2_buckets ?? [];
    const euBuckets = config('wrangler.eu.jsonc').r2_buckets ?? [];

    expect(globalBuckets).toContainEqual({
      binding: 'TELEMETRY_PAYLOADS',
      bucket_name: 'avalon-global-telemetry',
    });
    expect(euBuckets).toContainEqual({
      binding: 'TELEMETRY_PAYLOADS',
      bucket_name: 'avalon-eu-telemetry',
      jurisdiction: 'eu',
    });
    expect(globalBuckets.find(({ binding }) => binding === 'PAYLOADS')?.bucket_name)
      .not.toBe(globalBuckets.find(({ binding }) => binding === 'TELEMETRY_PAYLOADS')?.bucket_name);
    expect(euBuckets.find(({ binding }) => binding === 'PAYLOADS')?.bucket_name)
      .not.toBe(euBuckets.find(({ binding }) => binding === 'TELEMETRY_PAYLOADS')?.bucket_name);
  });

  it('deploys distinct non-SSH processor applications with their regional Workers', () => {
    const global = config('wrangler.global.jsonc');
    const eu = config('wrangler.eu.jsonc');
    const globalProcessor = symbolicator(global);
    const euProcessor = symbolicator(eu);

    expect(globalProcessor).toMatchObject({
      name: 'avalon-global-crash-symbolicator',
      image: './crash-symbolicator/Dockerfile',
      max_instances: 5,
      instance_type: 'basic',
      constraints: { regions: ['ENAM', 'WNAM'] },
      ssh: { enabled: false },
    });
    expect(euProcessor).toMatchObject({
      name: 'avalon-eu-crash-symbolicator',
      image: './crash-symbolicator/Dockerfile',
      max_instances: 5,
      instance_type: 'basic',
      constraints: { jurisdiction: 'eu', regions: ['EEUR', 'WEUR'] },
      ssh: { enabled: false },
    });
    expect(globalProcessor?.name).not.toBe(euProcessor?.name);
  });

  it.each(['wrangler.global.jsonc', 'wrangler.eu.jsonc'])(
    '%s binds and migrates the processor Durable Object',
    (fileName) => {
      const value = config(fileName);
      expect(value.durable_objects?.bindings).toContainEqual({
        name: 'CRASH_SYMBOLICATOR',
        class_name: 'CrashSymbolicatorContainer',
      });
      expect(value.migrations?.some((migration) => (
        migration.new_sqlite_classes?.includes('CrashSymbolicatorContainer')
      ))).toBe(true);
    },
  );

  it('keeps the processor class offline and short-lived', () => {
    const source = readFileSync(new URL('../src/crash-symbolicator-container.ts', import.meta.url), 'utf8');
    expect(source).toContain('override enableInternet = false');
    expect(source).toContain('override sleepAfter = "30s"');
  });

  it('pins the native parser and runs it as an unprivileged image user', () => {
    const dockerfile = readFileSync(new URL('../crash-symbolicator/Dockerfile', import.meta.url), 'utf8');
    expect(dockerfile).toContain('minidump-stackwalk --version 0.26.1 --locked');
    expect(dockerfile).toContain('USER processor');
    expect(dockerfile).toContain('COPY --chmod=0555 processor.py /usr/local/bin/rally-symbolicate');
    expect(dockerfile).toContain('EXPOSE 8080');
    expect(dockerfile).not.toMatch(/curl|wget|apt-get install.*(?:curl|wget)/u);
  });
});
