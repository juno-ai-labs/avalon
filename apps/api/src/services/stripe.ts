import { HttpUrlSchema } from '@rally/contracts/url-schemas';
import { z } from 'zod';
import { ApiError } from '../lib/api-error';
import type { Env } from '../env';
import { zodDiagnosticCode } from '@rally/contracts/zod-diagnostics';

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
  if (!response.ok) throw new ApiError(502, `stripe_http_${response.status}`, 'Stripe could not complete the request');
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
