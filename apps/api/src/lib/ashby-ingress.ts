import type { Env } from '../env';

export const DEFAULT_ASHBY_INGRESS_BASE_URL = 'https://ashby.rallywith.ai';
export function ashbyIngressUrl(env: Pick<Env, 'ASHBY_INGRESS_BASE_URL'>, connectionId: string): string {
  return new URL(`/ingest/ashby/${connectionId}`, env.ASHBY_INGRESS_BASE_URL || DEFAULT_ASHBY_INGRESS_BASE_URL).toString();
}
export function isSharedAshbyIngress(env: Env, requestUrl: string): boolean {
  const host = new URL(requestUrl).host.toLowerCase();
  return host === new URL(env.ASHBY_INGRESS_BASE_URL || DEFAULT_ASHBY_INGRESS_BASE_URL).host.toLowerCase()
    && (!env.PUBLIC_API_BASE_URL || host !== new URL(env.PUBLIC_API_BASE_URL).host.toLowerCase());
}
export function isAllowedAshbyIngressRoute(method: string, pathname: string): boolean {
  return (method === 'GET' && (pathname === '/health' || pathname === '/health/'))
    || (method === 'POST' && /^\/ingest\/ashby\/[0-9a-f-]+$/iu.test(pathname));
}
