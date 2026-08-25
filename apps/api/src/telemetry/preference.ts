import { newId } from '@rally/db';
import { z } from 'zod';
import type { Env } from '../env';
import { ApiError } from '../lib/api-error';

const UuidV7Schema = z.string().uuid().refine((value) => value[14] === '7');
export const PreferenceProjectionSchema = z.object({
  preferenceSubjectHandle: UuidV7Schema,
  enabled: z.boolean(),
  version: z.number().int().positive(),
}).strict();
export const CanonicalPreferenceMutationSchema = z.object({
  preferenceSubjectHandle: UuidV7Schema,
  enabled: z.boolean(),
  expectedVersion: z.number().int().nonnegative(),
  operationId: UuidV7Schema,
}).strict();
const CanonicalPreferenceResultSchema = z.object({
  result: z.enum(['applied', 'duplicate', 'conflict']),
  enabled: z.boolean(),
  version: z.number().int().positive(),
}).strict();

export type CanonicalPreferenceResult = z.infer<typeof CanonicalPreferenceResultSchema>;

interface UserPreferenceRow {
  preference_subject_handle: string | null;
  product_analytics_enabled: number;
  product_analytics_preference_version: number;
}

export async function loadOrCreateCanonicalPreferenceProjection(
  env: Env,
  userId: string,
): Promise<z.infer<typeof PreferenceProjectionSchema>> {
  if (env.AVALON_REGION !== 'global') throw new Error('telemetry_preference_canonical_global_only');
  let row = await env.DB.prepare(
    `SELECT preference_subject_handle, product_analytics_enabled, product_analytics_preference_version
     FROM users WHERE id = ?`,
  ).bind(userId).first<UserPreferenceRow>();
  if (!row) throw new Error('telemetry_preference_user_missing');
  if (!row.preference_subject_handle) {
    const candidate = newId();
    await env.DB.prepare(
      'UPDATE users SET preference_subject_handle = COALESCE(preference_subject_handle, ?) WHERE id = ?',
    ).bind(candidate, userId).run();
    row = await env.DB.prepare(
      `SELECT preference_subject_handle, product_analytics_enabled, product_analytics_preference_version
       FROM users WHERE id = ?`,
    ).bind(userId).first<UserPreferenceRow>();
  }
  if (!row?.preference_subject_handle) throw new Error('telemetry_preference_handle_missing');
  return PreferenceProjectionSchema.parse({
    preferenceSubjectHandle: row.preference_subject_handle,
    enabled: row.product_analytics_enabled === 1,
    version: row.product_analytics_preference_version,
  });
}

export async function applyCanonicalPreferenceMutation(
  env: Env,
  input: unknown,
): Promise<CanonicalPreferenceResult> {
  if (env.AVALON_REGION !== 'global') throw new Error('telemetry_preference_canonical_global_only');
  const request = CanonicalPreferenceMutationSchema.parse(input);
  const row = await env.DB.prepare(
    `SELECT product_analytics_enabled, product_analytics_preference_version
     FROM users WHERE preference_subject_handle = ?`,
  ).bind(request.preferenceSubjectHandle).first<{
    product_analytics_enabled: number;
    product_analytics_preference_version: number;
  }>();
  if (!row) throw new Error('telemetry_preference_handle_unknown');
  const current = {
    enabled: row.product_analytics_enabled === 1,
    version: row.product_analytics_preference_version,
  };
  if (current.version === request.expectedVersion + 1 && current.enabled === request.enabled) {
    return { result: 'duplicate', ...current };
  }
  if (current.version !== request.expectedVersion) return { result: 'conflict', ...current };
  const nextVersion = request.expectedVersion + 1;
  const updated = await env.DB.prepare(
    `UPDATE users SET product_analytics_enabled = ?, product_analytics_preference_version = ?, updated_at = ?
     WHERE preference_subject_handle = ? AND product_analytics_preference_version = ?`,
  ).bind(
    request.enabled ? 1 : 0, nextVersion, new Date().toISOString(),
    request.preferenceSubjectHandle, request.expectedVersion,
  ).run();
  if (Number(updated.meta.changes ?? 0) !== 1) {
    const winner = await env.DB.prepare(
      `SELECT product_analytics_enabled, product_analytics_preference_version
       FROM users WHERE preference_subject_handle = ?`,
    ).bind(request.preferenceSubjectHandle).first<{
      product_analytics_enabled: number;
      product_analytics_preference_version: number;
    }>();
    if (!winner) throw new Error('telemetry_preference_handle_unknown');
    return {
      result: winner.product_analytics_preference_version === nextVersion
          && winner.product_analytics_enabled === (request.enabled ? 1 : 0)
        ? 'duplicate'
        : 'conflict',
      enabled: winner.product_analytics_enabled === 1,
      version: winner.product_analytics_preference_version,
    };
  }
  return { result: 'applied', enabled: request.enabled, version: nextVersion };
}

export async function applyRegionalPreferenceProjection(
  env: Env,
  userId: string,
  input: unknown,
): Promise<void> {
  const projection = PreferenceProjectionSchema.parse(input);
  const row = await env.DB.prepare(
    `SELECT preference_subject_handle, product_analytics_enabled, product_analytics_preference_version
     FROM users WHERE id = ?`,
  ).bind(userId).first<UserPreferenceRow>();
  if (!row) throw new Error('telemetry_preference_user_missing');
  if (row.preference_subject_handle && row.preference_subject_handle !== projection.preferenceSubjectHandle) {
    throw new Error('telemetry_preference_handle_conflict');
  }
  if (row.product_analytics_preference_version > projection.version) return;
  if (row.product_analytics_preference_version === projection.version
    && row.product_analytics_enabled !== (projection.enabled ? 1 : 0)) {
    throw new Error('telemetry_preference_version_conflict');
  }
  await env.DB.prepare(
    `UPDATE users
     SET preference_subject_handle = ?, product_analytics_enabled = ?,
         product_analytics_preference_version = ?, updated_at = ?
     WHERE id = ? AND product_analytics_preference_version <= ?
       AND (preference_subject_handle IS NULL OR preference_subject_handle = ?)`,
  ).bind(
    projection.preferenceSubjectHandle, projection.enabled ? 1 : 0,
    projection.version, new Date().toISOString(), userId, projection.version,
    projection.preferenceSubjectHandle,
  ).run();
}

export class ProductAnalyticsPreferenceService {
  constructor(private readonly env: Env, private readonly userId: string) {}

  async update(input: {
    enabled: boolean;
    expectedVersion: number;
    operationId?: string;
  }): Promise<{ enabled: boolean; version: number }> {
    const operationId = input.operationId ?? newId();
    const row = await this.user();
    const handle = row.preference_subject_handle ?? await this.allocateHandle();
    if (row.product_analytics_preference_version === input.expectedVersion + 1
      && row.product_analytics_enabled === (input.enabled ? 1 : 0)) {
      return { enabled: input.enabled, version: input.expectedVersion + 1 };
    }
    if (row.product_analytics_preference_version !== input.expectedVersion) {
      throw new ApiError(409, 'telemetry_preference_conflict', 'The analytics preference changed on another installation');
    }

    if (this.env.AVALON_REGION === 'eu' && !input.enabled) {
      await this.env.DB.prepare(
        `UPDATE users SET product_analytics_enabled = 0, updated_at = ?
         WHERE id = ? AND product_analytics_preference_version = ?`,
      ).bind(new Date().toISOString(), this.userId, input.expectedVersion).run();
    }
    const result = this.env.AVALON_REGION === 'global'
      ? await applyCanonicalPreferenceMutation(this.env, {
          preferenceSubjectHandle: handle,
          enabled: input.enabled,
          expectedVersion: input.expectedVersion,
          operationId,
        })
      : await this.mutateCanonical({
          preferenceSubjectHandle: handle,
          enabled: input.enabled,
          expectedVersion: input.expectedVersion,
          operationId,
        });
    if (result.result === 'conflict') {
      if (this.env.AVALON_REGION === 'eu') {
        await applyRegionalPreferenceProjection(this.env, this.userId, {
          preferenceSubjectHandle: handle,
          enabled: result.enabled,
          version: result.version,
        });
      }
      throw new ApiError(409, 'telemetry_preference_conflict', 'The analytics preference changed on another installation');
    }
    if (result.enabled !== input.enabled || result.version !== input.expectedVersion + 1) {
      throw new ApiError(409, 'telemetry_preference_conflict', 'The analytics preference changed on another installation');
    }
    if (this.env.AVALON_REGION === 'eu') {
      const updated = await this.env.DB.prepare(
        `UPDATE users SET product_analytics_enabled = ?, product_analytics_preference_version = ?, updated_at = ?
         WHERE id = ? AND preference_subject_handle = ? AND product_analytics_preference_version = ?`,
      ).bind(
        input.enabled ? 1 : 0, result.version, new Date().toISOString(),
        this.userId, handle, input.expectedVersion,
      ).run();
      if (Number(updated.meta.changes ?? 0) !== 1) {
        const winner = await this.user();
        if (winner.product_analytics_preference_version !== result.version
          || winner.product_analytics_enabled !== (input.enabled ? 1 : 0)) {
          throw new Error('telemetry_preference_projection_failed');
        }
      }
    }
    return { enabled: result.enabled, version: result.version };
  }

  private async user(): Promise<UserPreferenceRow> {
    const row = await this.env.DB.prepare(
      `SELECT preference_subject_handle, product_analytics_enabled, product_analytics_preference_version
       FROM users WHERE id = ?`,
    ).bind(this.userId).first<UserPreferenceRow>();
    if (!row) throw new ApiError(401, 'session_revoked', 'The session is no longer active');
    return row;
  }

  private async allocateHandle(): Promise<string> {
    if (this.env.AVALON_REGION !== 'global') throw new Error('telemetry_preference_handle_missing');
    await this.env.DB.prepare(
      'UPDATE users SET preference_subject_handle = COALESCE(preference_subject_handle, ?) WHERE id = ?',
    ).bind(newId(), this.userId).run();
    const row = await this.user();
    if (!row.preference_subject_handle) throw new Error('telemetry_preference_handle_missing');
    return row.preference_subject_handle;
  }

  private mutateCanonical(input: z.infer<typeof CanonicalPreferenceMutationSchema>): Promise<CanonicalPreferenceResult> {
    if (!this.env.GLOBAL_TELEMETRY_CONTROL) throw new Error('telemetry_preference_canonical_unavailable');
    return this.env.GLOBAL_TELEMETRY_CONTROL.mutatePreference(input).then((value) => (
      CanonicalPreferenceResultSchema.parse(value)
    ));
  }
}
