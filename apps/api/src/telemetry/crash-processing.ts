import type { Region } from "@rally/contracts/regions";
import type { Env } from '../env';
import {
  durableObjectStubForRegionalSingleton,
} from '../lib/durable-object-namespace';

interface PendingCrashRow {
  crash_id: string;
  object_key: string;
  release: string;
  build_id: string;
  platform: 'darwin' | 'win32' | 'linux';
  architecture: 'arm64' | 'x64';
  route: Region;
  received_at: string;
  byte_size: number;
  process_role: 'main' | 'renderer' | 'utility' | 'gpu' | 'unknown';
  launch_id: string;
  channel: 'development' | 'alpha' | 'beta' | 'stable';
  breadcrumbs_json: string | null;
  breadcrumb_status: 'available' | 'stale' | 'unavailable';
  processing_attempt_count: number;
  delete_at: string;
}

export interface CrashProcessingSummary {
  selected: number;
  processed: number;
  failed: number;
}

const MAX_SYMBOL_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_SYMBOLICATION_RPC_BYTES = 84 * 1024 * 1024;
const PROCESS_ROLES = new Set(['main', 'renderer', 'utility', 'gpu']);

export async function processPendingCrashReports(env: Env): Promise<CrashProcessingSummary> {
  const now = new Date();
  const staleClaim = new Date(now.getTime() - 5 * 60_000).toISOString();
  const pending = await env.DB.prepare(
    `SELECT crash_id, object_key, release, build_id, platform, architecture, route, received_at,
            byte_size, process_role, launch_id, channel,
            breadcrumbs_json, breadcrumb_status, processing_attempt_count, delete_at
     FROM telemetry_crash_reports
     WHERE delete_at > ? AND (
       (parser_state IN ('pending', 'failed')
        AND (processing_next_attempt_at IS NULL OR processing_next_attempt_at <= ?))
       OR (parser_state = 'processing' AND processing_started_at <= ?)
     )
     ORDER BY received_at LIMIT 10`,
  ).bind(now.toISOString(), now.toISOString(), staleClaim).all<PendingCrashRow>();
  const summary: CrashProcessingSummary = { selected: pending.results.length, processed: 0, failed: 0 };
  for (const row of pending.results) {
    const claimed = await env.DB.prepare(
      `UPDATE telemetry_crash_reports
       SET parser_state = 'processing', processing_started_at = ?
       WHERE crash_id = ? AND delete_at > ? AND (
         (parser_state IN ('pending', 'failed')
          AND (processing_next_attempt_at IS NULL OR processing_next_attempt_at <= ?))
         OR (parser_state = 'processing' AND processing_started_at <= ?)
       )`,
    ).bind(now.toISOString(), row.crash_id, now.toISOString(), now.toISOString(), staleClaim).run();
    if (Number(claimed.meta.changes ?? 0) !== 1) continue;
    try {
      const dump = await env.TELEMETRY_PAYLOADS.get(row.object_key);
      if (!dump) {
        await saveResult(env, row, 'malformed', { status: 'malformed', reason: 'dump_missing' });
        summary.processed += 1;
        continue;
      }
      const symbolsKey = `telemetry/symbols/${row.release}/${row.build_id}/${row.platform}/${row.architecture}.tar`;
      const symbols = await env.TELEMETRY_PAYLOADS.get(symbolsKey);
      if (!symbols) {
        await saveResult(env, row, 'unsymbolicated', { status: 'unsymbolicated', reason: 'symbols_missing' });
        summary.processed += 1;
        continue;
      }
      if (symbols.size <= 0 || symbols.size > MAX_SYMBOL_ARCHIVE_BYTES
        || row.byte_size + symbols.size > MAX_SYMBOLICATION_RPC_BYTES) {
        await saveResult(env, row, 'unsymbolicated', {
          status: 'unsymbolicated',
          reason: 'symbols_too_large',
        });
        summary.processed += 1;
        continue;
      }
      const stub = durableObjectStubForRegionalSingleton(
        env,
        env.CRASH_SYMBOLICATOR,
        row.crash_id,
      );
      const result = await stub.symbolicate(await dump.arrayBuffer(), await symbols.arrayBuffer());
      await saveResult(env, row, result.parserState, JSON.parse(result.reportJson) as unknown);
      summary.processed += 1;
    } catch {
      const delay = Math.min(60 * 60 * 1_000, 60_000 * 2 ** Math.min(row.processing_attempt_count, 6));
      const nextAttempt = new Date(Math.min(Date.parse(row.delete_at), now.getTime() + delay));
      await env.DB.prepare(
        `UPDATE telemetry_crash_reports
         SET parser_state = 'failed', destination_state = ?,
             processing_attempt_count = processing_attempt_count + 1,
             processing_next_attempt_at = ?, processing_started_at = NULL
         WHERE crash_id = ? AND parser_state = 'processing'`,
      ).bind(
        'waiting_for_processing',
        nextAttempt.toISOString(),
        row.crash_id,
      ).run();
      summary.failed += 1;
    }
  }
  return summary;
}

async function saveResult(
  env: Env,
  row: PendingCrashRow,
  parserState: 'symbolicated' | 'unsymbolicated' | 'malformed',
  rawReport: unknown,
): Promise<void> {
  const normalized = normalizeCrashReport(rawReport, parserState, row.process_role);
  const report = {
    ...normalized,
    breadcrumb_status: row.breadcrumb_status,
    ...(row.breadcrumbs_json ? { breadcrumbs: JSON.parse(row.breadcrumbs_json) as unknown } : {}),
  };
  const encoded = JSON.stringify(report);
  if (encoded.length > 4 * 1024 * 1024) throw new Error('crash_structured_report_too_large');
  const fingerprint = await fingerprintFor(normalized);
  const update = env.DB.prepare(
    `UPDATE telemetry_crash_reports
     SET parser_state = ?, structured_report_json = ?, issue_fingerprint = ?, process_role = ?, destination_state = ?,
         processing_next_attempt_at = NULL, processing_started_at = NULL
     WHERE crash_id = ? AND parser_state = 'processing'`,
  ).bind(
    parserState,
    encoded,
    fingerprint,
    normalized.process_role,
    'pending',
    row.crash_id,
  );
  await update.run();
}

interface NormalizedCrashFrame {
  function: string;
  module: string;
  source_file?: string;
  line?: number;
  column?: number;
  in_app?: boolean;
}

interface NormalizedCrashThread {
  crashed: boolean;
  frames: NormalizedCrashFrame[];
}

interface NormalizedCrashReport {
  status: 'symbolicated' | 'unsymbolicated' | 'malformed';
  crash_type: string;
  mechanism: string;
  handled: false;
  process_role: 'main' | 'renderer' | 'utility' | 'gpu' | 'unknown';
  threads: NormalizedCrashThread[];
  reason?: string;
}

function normalizeCrashReport(
  value: unknown,
  parserState: 'symbolicated' | 'unsymbolicated' | 'malformed',
  fallbackProcessRole: NormalizedCrashReport['process_role'],
): NormalizedCrashReport {
  const root = record(value);
  const crashInfo = record(root?.['crash_info']);
  const crashType = safeToken(crashInfo?.['type'] ?? root?.['crash_type'], 'native_crash');
  const mechanism = safeToken(crashInfo?.['mechanism'] ?? root?.['mechanism'], 'minidump');
  const crashingThread = safeInteger(crashInfo?.['crashing_thread']);
  const processRoleCandidate = safeToken(
    root?.['process_role'] ?? crashInfo?.['process_role'] ?? root?.['process_type'],
    fallbackProcessRole,
  );
  const processRole = PROCESS_ROLES.has(processRoleCandidate)
    ? processRoleCandidate as NormalizedCrashReport['process_role']
    : fallbackProcessRole;
  const rawThreads = Array.isArray(root?.['threads']) ? root['threads'].slice(0, 64) : [];
  const threads = rawThreads.flatMap((thread, threadIndex): NormalizedCrashThread[] => {
    const source = record(thread);
    if (!source) return [];
    const rawFrames = Array.isArray(source['frames']) ? source['frames'].slice(0, 256) : [];
    const frames = rawFrames.flatMap((frame): NormalizedCrashFrame[] => {
      const candidate = record(frame);
      if (!candidate) return [];
      const normalized: NormalizedCrashFrame = {
        function: safeToken(candidate['function'] ?? candidate['function_name'], 'native_frame'),
        module: safeBasename(candidate['module'] ?? candidate['module_name'] ?? candidate['debug_file'], 'native'),
      };
      const sourceFile = safeBasename(candidate['source_file'] ?? candidate['file'], '');
      const line = safeInteger(candidate['line'] ?? candidate['line_number']);
      const column = safeInteger(candidate['column'] ?? candidate['column_number']);
      if (sourceFile) normalized.source_file = sourceFile;
      if (line !== null) normalized.line = line;
      if (column !== null) normalized.column = column;
      if (typeof candidate['in_app'] === 'boolean') normalized.in_app = candidate['in_app'];
      return [normalized];
    });
    return [{
      crashed: source['crashed'] === true || crashingThread === threadIndex,
      frames,
    }];
  });
  const reason = safeToken(root?.['reason'], '');
  return {
    status: parserState,
    crash_type: crashType,
    mechanism,
    handled: false,
    process_role: processRole,
    threads,
    ...(reason ? { reason } : {}),
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function safeBasename(value: unknown, fallback: string): string {
  if (typeof value !== 'string' || value.length === 0) return fallback;
  return safeToken(value.replaceAll('\\', '/').split('/').at(-1), fallback);
}

function safeToken(value: unknown, fallback: string): string {
  if (typeof value !== 'string' || value.length === 0) return fallback;
  const bounded = value.slice(0, 256).replace(/[^a-zA-Z0-9_.$+<>@ -]/gu, '_').trim();
  return bounded || fallback;
}

function safeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

async function fingerprintFor(report: NormalizedCrashReport): Promise<string> {
  const crashed = report.threads.find((thread) => thread.crashed) ?? report.threads[0];
  const signature = {
    crashType: report.crash_type,
    mechanism: report.mechanism,
    processRole: report.process_role,
    frames: crashed?.frames.slice(0, 20).map((frame) => ({
      function: frame.function,
      module: frame.module,
    })) ?? [],
  };
  const encoded = new TextEncoder().encode(JSON.stringify(signature));
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', encoded));
  return [...hash].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
