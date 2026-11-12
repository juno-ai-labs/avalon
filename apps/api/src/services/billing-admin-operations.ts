import { BillingMutationResultSchema, type BillingMutationResult } from '@rally/contracts/billing-admin';
import type { Env } from '../env';
import { ApiError } from '../lib/api-error';

interface Operation { request_json: string; delivery_json: string; created_at: number; result_json: string | null; error_code: string | null }
export function billingRefusal(code: string): never { throw new ApiError(409, code, code); }

/** The actor serializes a scope. Durable intent survives eviction; Stripe's key
 * covers short retries and provider receipts cover older uncertain writes. */
export async function billingOperation<T>(env: Env, scope: string, request: { operationId: string }, options: {
  prepare: () => Promise<T>;
  execute: (delivery: T, key: string) => Promise<BillingMutationResult>;
  recover: (delivery: T, key: string) => Promise<BillingMutationResult | null>;
}): Promise<BillingMutationResult> {
  const json = JSON.stringify(request);
  let saved = await env.DB.prepare('SELECT * FROM billing_admin_operations WHERE scope = ? AND operation_id = ?').bind(scope, request.operationId).first<Operation>();
  if (saved && saved.request_json !== json) billingRefusal('billing_operation_conflict');
  if (saved?.result_json) return BillingMutationResultSchema.parse(JSON.parse(saved.result_json));
  if (saved?.error_code) billingRefusal(saved.error_code);
  const replay = Boolean(saved);
  if (!saved) {
    if (await env.DB.prepare('SELECT 1 FROM billing_admin_operations WHERE scope = ? AND result_json IS NULL AND error_code IS NULL').bind(scope).first()) billingRefusal('billing_operation_pending');
    const delivery = await options.prepare();
    saved = { request_json: json, delivery_json: JSON.stringify(delivery), created_at: Math.floor(Date.now() / 1000), result_json: null, error_code: null };
    await env.DB.prepare('INSERT INTO billing_admin_operations(scope, operation_id, request_json, delivery_json, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(scope, request.operationId, json, saved.delivery_json, saved.created_at).run();
  }
  const key = `billing-admin:${env.AVALON_REGION}:${scope}:${request.operationId}`;
  const delivery = JSON.parse(saved.delivery_json) as T;
  let result = replay ? await options.recover(delivery, key) : null;
  if (!result) {
    // Stripe promises idempotency retention for at least 24 hours. Absence of a
    // receipt after that is not permission to repeat a financial side effect.
    if (replay && Math.floor(Date.now() / 1000) - saved.created_at >= 86400) billingRefusal('billing_operation_uncertain_expired');
    try { result = await options.execute(delivery, key); }
    catch (error) {
      if (error instanceof ApiError && ['stripe_http_400', 'stripe_http_402', 'stripe_http_404'].includes(error.code)) {
        await env.DB.prepare('UPDATE billing_admin_operations SET error_code = ? WHERE scope = ? AND operation_id = ?')
          .bind(error.diagnosticCode ?? error.code, scope, request.operationId).run();
      }
      throw error;
    }
  }
  const parsed = BillingMutationResultSchema.parse(result);
  await env.DB.prepare('UPDATE billing_admin_operations SET result_json = ? WHERE scope = ? AND operation_id = ?')
    .bind(JSON.stringify(parsed), scope, request.operationId).run();
  return parsed;
}
