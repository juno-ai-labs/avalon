import type { Env } from '../env';

export const DEFAULT_ASHBY_INGRESS_BASE_URL = 'https://ashby.rallywith.ai';
export function ashbyIngressUrl(env: Pick<Env, 'ASHBY_INGRESS_BASE_URL'>, connectionId: string): string {
  return new URL(`/ingest/ashby/${connectionId}`, env.ASHBY_INGRESS_BASE_URL || DEFAULT_ASHBY_INGRESS_BASE_URL).toString();
}
/** Same existing regional admission policy, applied before transport allocation. */
export function ashbyWebhookMaxBytes(env: Pick<Env, 'PROVIDER_WEBHOOK_MAX_BYTES'>): number {
  const configured = Number.parseInt(env.PROVIDER_WEBHOOK_MAX_BYTES ?? '', 10);
  return Number.isFinite(configured) && configured > 0 ? configured : 1_000_000;
}
