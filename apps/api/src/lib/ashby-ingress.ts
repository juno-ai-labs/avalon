import type { Env } from '../env';

export const DEFAULT_ASHBY_INGRESS_BASE_URL = 'https://ashby.rallywith.ai';
export function ashbyIngressUrl(env: Pick<Env, 'ASHBY_INGRESS_BASE_URL'>, connectionId: string): string {
  return new URL(`/ingest/ashby/${connectionId}`, env.ASHBY_INGRESS_BASE_URL || DEFAULT_ASHBY_INGRESS_BASE_URL).toString();
}
