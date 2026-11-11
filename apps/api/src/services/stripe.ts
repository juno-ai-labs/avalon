import { HttpUrlSchema } from '@rally/contracts/url-schemas';
import { z } from 'zod';
import { ApiError } from '../lib/api-error';
import type { Env } from '../env';
import { codeShaped, zodDiagnosticCode } from '@rally/contracts/zod-diagnostics';

export async function stripe<T>(env: Pick<Env, 'STRIPE_SECRET_KEY'>, path: string, schema: z.ZodType<T>, fields?: Record<string, string>, key?: string): Promise<T> {
  if (!env.STRIPE_SECRET_KEY) throw new ApiError(503, 'stripe_not_configured', 'Billing is not configured');
  const response = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: fields ? 'POST' : 'GET',
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Stripe-Version': '2025-02-24.acacia',
      ...(fields ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      ...(key ? { 'Idempotency-Key': key } : {}),
    },
    ...(fields ? { body: new URLSearchParams(fields) } : {}),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    const error = z.object({ error: z.object({ type: z.string().optional(), code: z.string().optional(), param: z.string().optional() }) }).safeParse(payload);
    const types = new Set(['api_error', 'card_error', 'idempotency_error', 'invalid_request_error', 'authentication_error', 'rate_limit_error']);
    const codes = new Set(['resource_missing', 'idempotency_key_in_use', 'parameter_invalid_integer', 'parameter_invalid_empty',
      'parameter_invalid_string_blank', 'parameter_missing', 'parameter_unknown', 'parameter_invalid_enum', 'parameter_invalid_string_empty',
      'parameter_invalid_string_long', 'parameter_invalid_string_short', 'parameter_invalid_string_unicode', 'parameter_invalid_string_pattern',
      'api_key_expired', 'invalid_api_key', 'rate_limit', 'lock_timeout', 'card_declined', 'expired_card', 'incorrect_cvc', 'incorrect_number',
      'authentication_required', 'invoice_no_customer_line_items', 'invoice_no_subscription_line_items', 'invoice_not_editable',
      'invoice_already_paid', 'invoice_payment_intent_requires_action', 'tax_id_invalid', 'currency_not_supported']);
    const detail = error.success ? error.data.error : null;
    // A provider param may contain arbitrary metadata keys. Only our declared
    // request fields may be reported; sanitizing an unknown key is not redaction.
    const param = detail?.param && Object.hasOwn(fields ?? {}, detail.param) ? detail.param : undefined;
    const reason = codeShaped([`stripe_http_${response.status}`,
      detail?.type && types.has(detail.type) ? detail.type : 'provider_error',
      detail?.code && codes.has(detail.code) ? detail.code : detail?.code ? 'unrecognized_error_code' : undefined, param].filter(Boolean).join(':'));
    throw new ApiError(502, `stripe_http_${response.status}`, 'Stripe could not complete the request', undefined, reason);
  }
  const parsed = schema.safeParse(await response.json());
  if (!parsed.success) throw new ApiError(502, zodDiagnosticCode(parsed.error, 'stripe_response')!, 'Stripe returned an invalid response');
  return parsed.data;
}

/** Stripe's recommended five-minute tolerance; verify the untouched request body. */
export async function verifyStripeSignature(body: string, header: string, secret: string, now = Date.now()): Promise<boolean> {
  const parts = header.split(',');
  const timestamp = parts.find((p) => p.startsWith('t='))?.slice(2);
  if (!timestamp || !/^\d+$/.test(timestamp) || Math.abs(now / 1000 - Number(timestamp)) > 300) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  for (const part of parts.filter((p) => /^v1=[a-f0-9]{64}$/.test(p))) {
    const bytes = Uint8Array.from(part.slice(3).match(/../g)!, (hex) => parseInt(hex, 16));
    if (await crypto.subtle.verify('HMAC', key, bytes, new TextEncoder().encode(`${timestamp}.${body}`))) return true;
  }
  return false;
}
export const StripeIdSchema = z.object({ id: z.string() });
export const StripeUrlSchema = z.object({ id: z.string(), url: HttpUrlSchema });
