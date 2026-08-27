import { ProductFeatureFlagKeySchema, type ProductFeatureFlagKey } from '@rally/contracts';
import { z } from 'zod';
import type { Env } from './env';
import {
  MANAGED_FLAGS,
  MANAGED_MODELS,
  ManagedFlagUpdateSchema,
  ManagedModelRoleSchema,
  ManagedModelUpdateSchema,
  type ManagedFlagUpdate,
  type ManagedModelRole,
  type ManagedModelUpdate,
} from './protocol';

const managedKeys = new Set<string>(MANAGED_FLAGS.map((flag) => flag.key));
const managedModelKeys = new Set<string>(MANAGED_MODELS.map((model) => model.key));
// Flagship changes can take up to 30 seconds to propagate, checked 2026-08-24:
// https://developers.cloudflare.com/flagship/concepts/
export const FLAGSHIP_PROPAGATION_DELAY_SECONDS = 30;

function endpoint(env: Env, suffix = ''): string {
  return `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID)}`
    + `/flagship/apps/${encodeURIComponent(env.FLAGSHIP_APP_ID)}/flags${suffix}`;
}

async function request(env: Env, path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(endpoint(env, path), {
    ...init,
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${env.CLOUDFLARE_FLAGSHIP_API_TOKEN}`,
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  const body = await response.json().catch(() => null) as { result?: unknown; errors?: Array<{ message?: string }> } | null;
  if (!response.ok) {
    const detail = body?.errors?.map((error) => error.message).filter(Boolean).join('; ');
    throw new Error(`Flagship request failed (${response.status})${detail ? `: ${detail}` : ''}`);
  }
  return body?.result;
}

export async function listManagedFlags(env: Env): Promise<unknown[]> {
  const result = await request(env, '');
  const flags = Array.isArray(result) ? result : [];
  return flags.filter((flag) => flag !== null && typeof flag === 'object'
    && managedKeys.has(String((flag as { key?: unknown }).key)));
}

export async function listManagedModelFlags(env: Env): Promise<unknown[]> {
  const result = await request(env, '');
  const flags = Array.isArray(result) ? result : [];
  return flags.filter((flag) => flag !== null && typeof flag === 'object'
    && managedModelKeys.has(String((flag as { key?: unknown }).key)));
}

export async function updateManagedFlag(
  env: Env,
  key: ProductFeatureFlagKey,
  input: ManagedFlagUpdate,
): Promise<unknown> {
  const parsedKey = ProductFeatureFlagKeySchema.parse(key);
  const update = ManagedFlagUpdateSchema.parse({ ...input, key: parsedKey });
  const result = await request(env, `/${encodeURIComponent(parsedKey)}`, {
    method: 'PUT',
    body: JSON.stringify({
      ...update,
      variations: { off: false, on: true },
    }),
  });
  // Flagship configuration propagates asynchronously. Carry only the key, and
  // let every WorkspaceDO evaluate after the documented propagation window.
  await env.PRODUCT_FLAG_CHANGE_QUEUE.send(
    { kind: 'flagship_product_flag_changed', flagKey: parsedKey },
    { delaySeconds: FLAGSHIP_PROPAGATION_DELAY_SECONDS },
  );
  return result;
}

const FlagshipJsonFlagSchema = z.object({
  key: z.string().min(1),
  description: z.string().optional(),
  enabled: z.boolean(),
  default_variation: z.string().min(1),
  variations: z.record(z.string(), z.unknown()),
  rules: z.array(z.unknown()),
}).passthrough();

/**
 * Replace only the route plan served by the flag's current default variation.
 * Cloudflare's PUT replaces the whole flag, so the live definition is read
 * immediately before the write and every staged variation and targeting rule
 * is copied back unchanged.
 */
export async function updateManagedModelRouting(
  env: Env,
  role: ManagedModelRole,
  input: ManagedModelUpdate,
): Promise<unknown> {
  const parsedRole = ManagedModelRoleSchema.parse(role);
  const update = ManagedModelUpdateSchema.parse(input);
  if (update.role !== parsedRole) throw new Error('Model role does not match the request path');
  const definition = MANAGED_MODELS.find((model) => model.role === parsedRole)!;
  const current = FlagshipJsonFlagSchema.parse(await request(env, `/${encodeURIComponent(definition.key)}`));
  if (current.key !== definition.key) throw new Error('Flagship returned a different model flag');

  return request(env, `/${encodeURIComponent(definition.key)}`, {
    method: 'PUT',
    body: JSON.stringify({
      key: current.key,
      description: current.description ?? definition.description,
      enabled: current.enabled,
      default_variation: current.default_variation,
      variations: {
        ...current.variations,
        [current.default_variation]: update.routing,
      },
      rules: current.rules,
      type: 'json',
    }),
  });
}
