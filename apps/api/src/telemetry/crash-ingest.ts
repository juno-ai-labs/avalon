import { STRICT_UUID_PATTERN } from "@rally/contracts/uuid-validation";
import { newId } from '@rally/db';
import { TelemetryBreadcrumbSidecarSchema, type TelemetryBreadcrumbSidecar } from '@rally/contracts/telemetry';
import { z } from 'zod/v3';
import type { Env } from '../env';
import { sha256 } from '../lib/crypto';
import { consumeTelemetryRateLimit, recordTelemetryRejection } from './operations';

const MAX_DUMP_BYTES = 20 * 1024 * 1024;
const MAX_NEW_CRASH_UPLOADS_PER_HOUR = 10;
const CrashMetadataSchema = z.object({
  uploadId: z.string().regex(STRICT_UUID_PATTERN, "Invalid UUID").refine((value) => value[14] === '7'),
  installationId: z.string().regex(STRICT_UUID_PATTERN, "Invalid UUID").refine((value) => value[14] === '7'),
  route: z.enum(['global', 'eu']),
  release: z.string().min(1).max(64).regex(/^[a-zA-Z0-9._+-]+$/u),
  buildId: z.string().min(1).max(64).regex(/^[a-zA-Z0-9._+-]+$/u),
  platform: z.enum(['darwin', 'win32', 'linux']),
  architecture: z.enum(['arm64', 'x64']),
  processRole: z.enum(['main', 'renderer', 'utility', 'gpu', 'unknown']),
  launchId: z.string().regex(STRICT_UUID_PATTERN, "Invalid UUID").refine((value) => value[14] === '7'),
  channel: z.enum(['development', 'alpha', 'beta', 'stable']),
}).strict();

export interface CrashIngestInput extends z.infer<typeof CrashMetadataSchema> {
  dump: Uint8Array;
  subjectUserId: string | null;
  subjectWorkspaceId?: string | null;
  /** Server-derived authenticated user or capability journey. Never supplied
   * by multipart metadata. */
  rateLimitSubject: string;
  breadcrumbs?: TelemetryBreadcrumbSidecar;
}

export type CrashIngestResult = {
  result: 'accepted' | 'duplicate' | 'suppressed';
  uploadId: string;
  crashId?: string;
};

export class CrashIngestService {
  constructor(private readonly env: Env) {}

  async accept(input: CrashIngestInput): Promise<CrashIngestResult> {
    const metadata = CrashMetadataSchema.parse({
      uploadId: input.uploadId,
      installationId: input.installationId,
      route: input.route,
      release: input.release,
      buildId: input.buildId,
      platform: input.platform,
      architecture: input.architecture,
      processRole: input.processRole,
      launchId: input.launchId,
      channel: input.channel,
    });
    if (metadata.route !== this.env.AVALON_REGION) throw new Error('crash_route_mismatch');
    if (!(input.dump instanceof Uint8Array) || input.dump.byteLength > MAX_DUMP_BYTES) {
      throw new Error('crash_dump_too_large');
    }
    if (input.dump.byteLength < 4
      || input.dump[0] !== 0x4d || input.dump[1] !== 0x44
      || input.dump[2] !== 0x4d || input.dump[3] !== 0x50) {
      throw new Error('crash_dump_malformed');
    }
    if (input.subjectUserId) {
      const preference = await this.env.DB.prepare(
        'SELECT product_analytics_enabled FROM users WHERE id = ?',
      ).bind(input.subjectUserId).first<{ product_analytics_enabled: number }>();
      if (preference?.product_analytics_enabled !== 1) {
        return { result: 'suppressed', uploadId: metadata.uploadId };
      }
      await this.env.DB.prepare(
        'UPDATE users SET analytics_person_id = COALESCE(analytics_person_id, ?) WHERE id = ?',
      ).bind(newId(), input.subjectUserId).run();
      if (input.subjectWorkspaceId) {
        await this.env.DB.prepare(
          `UPDATE workspaces SET analytics_workspace_id = COALESCE(analytics_workspace_id, ?)
           WHERE id = ? AND region = ?`,
        ).bind(newId(), input.subjectWorkspaceId, this.env.AVALON_REGION).run();
      }
    }

    const contentHash = await sha256(input.dump);
    const existing = await this.env.DB.prepare(
      'SELECT crash_id, content_sha256 FROM telemetry_crash_reports WHERE upload_id = ?',
    ).bind(metadata.uploadId).first<{ crash_id: string; content_sha256: string }>();
    if (existing) {
      if (existing.content_sha256 !== contentHash) throw new Error('crash_upload_conflict');
      return { result: 'duplicate', uploadId: metadata.uploadId };
    }
    if (!await consumeTelemetryRateLimit(
      this.env,
      'crash_upload',
      input.rateLimitSubject,
      MAX_NEW_CRASH_UPLOADS_PER_HOUR,
    )) {
      await recordTelemetryRejection(this.env, 'crash_rate_limited').catch(() => undefined);
      throw new Error('crash_rate_limited');
    }

    const now = new Date();
    const breadcrumbs = input.breadcrumbs
      ? TelemetryBreadcrumbSidecarSchema.parse(input.breadcrumbs)
      : null;
    const breadcrumbStatus = breadcrumbs
      ? now.getTime() - Date.parse(breadcrumbs.updatedAt) <= 5 * 60_000 ? 'available' : 'stale'
      : 'unavailable';
    const deleteAt = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1_000);
    const crashId = newId(now.getTime());
    const objectKey = `telemetry/crashes/${this.env.AVALON_REGION}/${crashId}.dmp`;
    await this.env.TELEMETRY_PAYLOADS.put(objectKey, input.dump, {
      httpMetadata: { contentType: 'application/octet-stream' },
      customMetadata: { deleteAfter: deleteAt.toISOString(), kind: 'native-crash-minidump' },
    });
    try {
      await this.env.DB.prepare(
        `INSERT INTO telemetry_crash_reports
          (crash_id, upload_id, subject_user_id, subject_workspace_id, installation_analytics_id, route,
           object_key, byte_size, content_sha256, release, build_id, platform,
           architecture, process_role, launch_id, channel, breadcrumbs_json, breadcrumb_status,
           parser_state, received_at, delete_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      ).bind(
        crashId,
        metadata.uploadId,
        input.subjectUserId,
        input.subjectWorkspaceId ?? null,
        metadata.installationId,
        metadata.route,
        objectKey,
        input.dump.byteLength,
        contentHash,
        metadata.release,
        metadata.buildId,
        metadata.platform,
        metadata.architecture,
        metadata.processRole,
        metadata.launchId,
        metadata.channel,
        breadcrumbs ? JSON.stringify(breadcrumbs) : null,
        breadcrumbStatus,
        now.toISOString(),
        deleteAt.toISOString(),
      ).run();
    } catch (error) {
      await this.env.TELEMETRY_PAYLOADS.delete(objectKey).catch(() => undefined);
      throw error;
    }
    return { result: 'accepted', uploadId: metadata.uploadId, crashId };
  }
}
