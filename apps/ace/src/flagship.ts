import { ProductFeatureFlagKeySchema, type ProductFeatureFlagKey } from '@rally/contracts';
import type { Env } from './env';
import { MANAGED_FLAGS, ManagedFlagUpdateSchema, type ManagedFlagUpdate } from './protocol';

const managedKeys = new Set<string>(MANAGED_FLAGS.map((flag) => flag.key));
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
